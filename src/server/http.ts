/**
 * The HTTP surface: the round commands, the fairness sheet, and the client.
 *
 * Every route is server-authoritative and every command is idempotent and fenced.
 * Nothing that could leak an unresolved draw is ever serialized: a frame carries
 * the wild line only for the stage the player has already resolved, and side bets
 * resolve at settlement and nowhere else (`docs/ENGINE.md` §5.2).
 *
 * Requests are held to bounds before they are read: a body over 64 KiB is
 * refused, a stake that is not an integer string of minor units is refused, and
 * every failure is one of the public codes in `./errors.ts` with a path — never a
 * stack trace.
 *
 * Two responsible-design surfaces are enforced here rather than in the client,
 * because a rule that only exists in the client is not a rule: `docs/DESIGN.md`
 * §9.7's speed-of-play floors hold every round command until its floor has
 * passed (a wait, never a refusal — no floor can cost a payout), and §9.9's
 * session limits refuse a stake with `LIMIT_REACHED` and nothing else.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwarmError, fail, statusFor, toSwarmError } from './errors.ts';
import type { Admission } from './pacing.ts';
import { RoundService, type ServiceOptions } from './service.ts';
import { verifyRound } from './verify.ts';
import {
  parseProofBundle,
  wireConfig,
  wireFrame,
  wireHistory,
  wireReceipt,
  wireSettlement,
} from './wire.ts';

const CLIENT_ROOT = resolve(fileURLToPath(new URL('../client', import.meta.url)));
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface AppOptions extends ServiceOptions {
  readonly clientRoot?: string;
}

export interface App {
  readonly server: Server;
  readonly service: RoundService;
}

export function createApp(options: AppOptions = {}): App {
  const service = new RoundService(options);
  const clientRoot = options.clientRoot ?? CLIENT_ROOT;

  const server = createServer((request, response) => {
    handle(request, response, service, clientRoot).catch((error: unknown) => {
      sendError(response, toSwarmError(error));
    });
  });
  return { server, service };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  service: RoundService,
  clientRoot: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  // The bound is checked before routing, so it holds on every route rather than
  // only on the ones that read a body.
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    return sendError(response, new SwarmError('PAYLOAD_TOO_LARGE', 'Request body is too large'));
  }

  if (!path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD')
      return sendError(response, new SwarmError('METHOD_NOT_ALLOWED', 'Static assets are read-only'));
    return sendStatic(response, clientRoot, path);
  }

  const segments = path.split('/').filter((segment) => segment.length > 0);
  // segments[0] === 'api'
  try {
    if (method === 'GET' && segments[1] === 'config' && segments.length === 2)
      return sendJson(
        response,
        200,
        wireConfig({
          abandonedRoundTimeoutHours: service.abandonedRoundTimeoutHours,
          pacing: service.pacer.floors,
          realityCheckMinutes: service.protection.realityCheckMinutes,
          limitCoolOffHours: service.protection.limitCoolOffHours,
        }),
      );

    if (method === 'GET' && segments[1] === 'session' && segments.length === 2) {
      service.sweep();
      return sendJson(response, 200, sessionOf(service));
    }

    // `docs/DESIGN.md` §9.9. Limits live on the server because a limit a reload
    // clears is not a limit; the reality check restarts from an acknowledgement
    // for the same reason.
    if (segments[1] === 'limits' && segments.length === 2) {
      if (method === 'GET') return sendJson(response, 200, limitsOf(service));
      if (method === 'POST') {
        const body = await readJson(request);
        service.protection.set(body);
        return sendJson(response, 200, { ...limitsOf(service), session: sessionOf(service) });
      }
      return sendError(response, new SwarmError('METHOD_NOT_ALLOWED', 'Use GET or POST on limits'));
    }

    if (segments[1] === 'reality-check' && segments.length === 2) {
      if (method !== 'POST')
        return sendError(
          response,
          new SwarmError('METHOD_NOT_ALLOWED', 'Use POST to acknowledge a reality check'),
        );
      service.protection.acknowledgeRealityCheck();
      return sendJson(response, 200, sessionOf(service));
    }

    if (segments[1] === 'rounds' && segments.length === 2) {
      if (method !== 'POST')
        return sendError(response, new SwarmError('METHOD_NOT_ALLOWED', 'Use POST to open a round'));
      // Phase 1: the seed pre-commitment is published before a stake exists.
      const created = service.createRound();
      return sendJson(response, 201, {
        roundId: created.roundId,
        seedCommitment: created.seedCommitment,
        createdAt: created.createdAt,
        session: sessionOf(service),
      });
    }

    if (segments[1] === 'rounds' && segments.length >= 3) {
      const roundId = decodeURIComponent(segments[2] as string);
      const command = segments[3];

      if (method === 'GET' && command === undefined) {
        const record = service.record(roundId);
        // A round that has been created but not opened holds a commitment and
        // nothing else: no stake, no entropy, no grid.
        if (record.book === null)
          return sendJson(response, 200, {
            roundId,
            seedCommitment: record.seedCommitment,
            createdAt: record.createdAt,
            state: 'AWAITING_OPEN',
            session: sessionOf(service),
          });
        return sendJson(response, 200, roundView(service, roundId));
      }

      if (method !== 'POST')
        return sendError(response, new SwarmError('METHOD_NOT_ALLOWED', 'Round commands are POST'));

      const body = await readJson(request);
      if (command === 'open') {
        const result = await paced(service.pacer.admitOpen(roundId), () =>
          service.open(roundId, {
            idempotencyKey: readKey(body.idempotencyKey),
            expectedFrameRevision: readRevision(body.expectedFrameRevision),
            stakeUnits: readUnits(body.stakeUnits, '$.stakeUnits'),
            sideBets: readSideBets(body.sideBets),
            clientEntropy: String(body.clientEntropy ?? ''),
          }),
        );
        return sendJson(response, 200, {
          ...roundView(service, roundId),
          receipts: result.receipts.map(wireReceipt),
        });
      }
      if (command === 'advance') {
        const result = await paced(service.pacer.admitCommand(roundId), () =>
          service.advance(roundId, {
            idempotencyKey: readKey(body.idempotencyKey),
            expectedFrameRevision: readRevision(body.expectedFrameRevision),
          }),
        );
        return sendJson(response, 200, {
          ...roundView(service, roundId),
          receipts: result.receipts.map(wireReceipt),
        });
      }
      if (command === 'harvest') {
        const units = body.units;
        if (!Number.isSafeInteger(units)) fail('INVALID_REQUEST', 'units must be an integer', '$.units');
        const result = await paced(service.pacer.admitCommand(roundId), () =>
          service.harvest(roundId, {
            idempotencyKey: readKey(body.idempotencyKey),
            expectedFrameRevision: readRevision(body.expectedFrameRevision),
            units: units as number,
          }),
        );
        return sendJson(response, 200, {
          ...roundView(service, roundId),
          receipts: result.receipts.map(wireReceipt),
        });
      }
      if (command === 'settle') {
        const result = await paced(service.pacer.admitCommand(roundId), () =>
          service.settle(roundId, {
            idempotencyKey: readKey(body.idempotencyKey),
            expectedFrameRevision: readRevision(body.expectedFrameRevision),
          }),
        );
        return sendJson(response, 200, {
          ...roundView(service, roundId),
          receipts: result.receipts.map(wireReceipt),
        });
      }
      if (command === 'reconcile') {
        service.reconcile(roundId);
        return sendJson(response, 200, roundView(service, roundId));
      }
      return sendError(response, new SwarmError('NOT_FOUND', `No such round command: ${command}`));
    }

    if (method === 'POST' && segments[1] === 'verify' && segments.length === 2) {
      const body = await readJson(request);
      const bundle = parseProofBundle(body.proof ?? body);
      return sendJson(response, 200, verifyRound(bundle));
    }

    return sendError(response, new SwarmError('NOT_FOUND', 'No such endpoint'));
  } catch (error) {
    return sendError(response, toSwarmError(error));
  }
}

/**
 * The session view: the money, the clock, and the state of every §9.9 surface.
 *
 * `elapsedMs` is served rather than left to the client to subtract, because the
 * session timer §9.9 asks for is the server's session and a client clock can be
 * anything. `limitReached` is published so the client renders a locked state
 * instead of provoking a refusal to discover one.
 */
function sessionOf(service: RoundService): Record<string, unknown> {
  const wallet = service.wallet;
  const reached = service.limitReached();
  return {
    balanceUnits: wallet.balanceUnits.toString(),
    openingUnits: wallet.openingUnits.toString(),
    stakedUnits: wallet.stakedUnits.toString(),
    creditedUnits: wallet.creditedUnits.toString(),
    netUnits: wallet.netUnits.toString(),
    startedAt: service.startedAt,
    now: service.now,
    elapsedMs: service.protection.elapsedMs,
    realityCheck: service.protection.realityCheck(),
    limits: wireLimits(service),
    limitReached: reached === null ? null : { field: reached.field, message: reached.message },
    history: service.history.map(wireHistory),
  };
}

function wireLimits(service: RoundService): Record<string, unknown> {
  const limits = service.protection.limits;
  return {
    budgetUnits: limits.budgetUnits === null ? null : limits.budgetUnits.toString(),
    lossUnits: limits.lossUnits === null ? null : limits.lossUnits.toString(),
    timeMinutes: limits.timeMinutes,
    pending: service.protection.pending,
    coolOffHours: service.protection.limitCoolOffHours,
  };
}

function limitsOf(service: RoundService): Record<string, unknown> {
  return { limits: wireLimits(service) };
}

/** §9.7's floors: a wait before the command runs, never a refusal of it. */
function hold(milliseconds: number): Promise<void> {
  if (!(milliseconds > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Runs a round command behind its §9.7 floor.
 *
 * The floor is a wait and never a refusal — and a command that is *itself* refused
 * pays no floor at all. §9.7's floors govern how fast a round may be cycled, and a
 * malformed payload, a stake a session limit refuses, or a command fenced to a
 * stale frame has not cycled a round: it gets its slot back, so arguing with the
 * API is not slower than playing it and a client cannot hold a connection per
 * piece of garbage it sends. A command that *succeeds* keeps its slot, which is
 * what makes the floor a floor.
 */
async function paced<T>(admission: Admission, run: () => T): Promise<T> {
  await hold(admission.waitMs);
  try {
    return run();
  } catch (error) {
    admission.release();
    throw error;
  }
}

function roundView(service: RoundService, roundId: string): Record<string, unknown> {
  const record = service.record(roundId);
  const book = service.book(roundId);
  const settlement = book.settlement;
  return {
    roundId,
    seedCommitment: book.seedCommitment,
    clientEntropy: book.context.clientEntropy,
    createdAt: record.createdAt,
    lastCommandAt: record.lastCommandAt,
    stakeUnits: book.stakeUnits.toString(),
    sideBetStakes: Object.fromEntries(
      Object.entries(book.sideBetStakes).map(([id, units]) => [id, units.toString()]),
    ),
    exposureUnits: book.exposureUnits.toString(),
    frame: wireFrame(book.frame),
    ledger: book.receipts.map(wireReceipt),
    settlement: settlement === null ? null : wireSettlement(settlement),
    session: sessionOf(service),
  };
}

function readKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    fail('INVALID_REQUEST', 'An idempotency key is required', '$.idempotencyKey');
  return value;
}

function readRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('INVALID_REQUEST', 'expectedFrameRevision must be a non-negative integer', '$.expectedFrameRevision');
  return value as number;
}

function readUnits(value: unknown, path: string): bigint {
  if (typeof value === 'string' && /^\d{1,25}$/u.test(value)) return BigInt(value);
  fail('INVALID_REQUEST', 'Money must be an integer string of minor units', path);
}

function readSideBets(value: unknown): readonly { id: string; stakeUnits: bigint }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8)
    fail('INVALID_REQUEST', 'Side bets must be a short array', '$.sideBets');
  return value.map((entry: Record<string, unknown>, index: number) => {
    if (typeof entry !== 'object' || entry === null)
      fail('INVALID_REQUEST', 'Malformed side bet', `$.sideBets[${index}]`);
    return {
      id: String(entry.id),
      stakeUnits: readUnits(entry.stakeUnits, `$.sideBets[${index}].stakeUnits`),
    };
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) fail('PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      fail('INVALID_REQUEST', 'Request body must be a JSON object');
    return parsed as Record<string, any>;
  } catch (error) {
    if (error instanceof SwarmError) throw error;
    return fail('INVALID_REQUEST', 'Request body is not valid JSON');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: SwarmError): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, statusFor(error.code), {
    error: { code: error.code, message: error.message, path: error.path, detail: error.detail },
  });
}

function sendStatic(response: ServerResponse, root: string, path: string): void {
  const relative = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(
    /^(\.\.[/\\])+/u,
    '',
  );
  const target = resolve(join(root, relative));
  if (!target.startsWith(root + sep) && target !== root)
    return sendError(response, new SwarmError('NOT_FOUND', 'No such asset'));
  if (!existsSync(target) || !statSync(target).isFile())
    return sendError(response, new SwarmError('NOT_FOUND', 'No such asset'));
  const type = CONTENT_TYPES[extname(target)];
  if (type === undefined) return sendError(response, new SwarmError('NOT_FOUND', 'Unsupported asset'));
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(target).pipe(response);
}
