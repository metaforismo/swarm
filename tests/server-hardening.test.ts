import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SWARM } from '../src/server/adapter.ts';
import { seedCommitment } from '../src/server/commitment.ts';
import { deriveGrid, replayRound, roundContext, wildLineOf } from '../src/server/derivation.ts';
import { createApp } from '../src/server/http.ts';
import { RoundService } from '../src/server/service.ts';
import { sealSettlement, type Receipt } from '../src/server/settlement.ts';
import { verifyRound } from '../src/server/verify.ts';
import { Wallet } from '../src/server/wallet.ts';

const ENTROPY = 'c'.repeat(64);
const SEED_A = '9667b8896a62186befbaf96b9ae8e4704e44d065f0ae6aa6a43a4239c63874cb';
const SEED_B = '0e4ac2893a15a0fc6a7caecedbc56d943eee45377f5ef4f2ecf9cc758bcb1ec2';
const CREDIT = SWARM.money.unitsPerCredit;
const NO_PACING = { roundCycleMs: 0, decisionDeadPeriodMs: 0, settlementHoldMs: 0 };

let counter = 0;
const key = (label: string): string => `hardening-${label}-${(counter += 1)}`;

function service(
  overrides: ConstructorParameters<typeof RoundService>[0] = {},
): RoundService {
  return new RoundService({
    openingBalanceUnits: 10_000n * CREDIT,
    seedSource: () => SEED_A,
    roundIdSource: () => 'swarm-fixture-0',
    pacing: NO_PACING,
    ...overrides,
  });
}

async function openRound(rounds: RoundService, sideBets: readonly { id: string; stakeUnits: bigint }[] = []) {
  const created = rounds.createRound();
  const opened = await rounds.open(created.roundId, {
    idempotencyKey: key('open'),
    expectedFrameRevision: 0,
    stakeUnits: CREDIT,
    sideBets,
    clientEntropy: ENTROPY,
  });
  return { ...created, opened };
}

describe('finding 1 — public state is a frozen copy, never settlement custody', () => {
  it('cannot delete a posted harvest receipt and make settlement credit it twice', async () => {
    const rounds = service();
    const { roundId, opened } = await openRound(rounds);
    const advanced = await rounds.advance(roundId, {
      idempotencyKey: key('advance'),
      expectedFrameRevision: opened.frame.revision,
    });
    expect(advanced.frame.units).toBe(4);
    const banked = await rounds.harvest(roundId, {
      idempotencyKey: key('bank'),
      expectedFrameRevision: advanced.frame.revision,
      units: 4,
    });
    const afterHarvest = rounds.wallet.balanceUnits;

    const exposed = rounds.book(roundId);
    const receipts = exposed.receipts as Receipt[];
    const harvestAt = receipts.findIndex((receipt) => receipt.kind === 'HARVEST');
    expect(harvestAt).toBeGreaterThanOrEqual(0);
    try {
      receipts.splice(harvestAt, 1);
    } catch {
      // A frozen public snapshot is allowed to reject the attempted mutation.
    }

    const settled = await rounds.settle(roundId, {
      idempotencyKey: key('settle'),
      expectedFrameRevision: banked.frame.revision,
    });
    expect(rounds.wallet.balanceUnits).toBe(afterHarvest);
    expect(settled.value.receipts.filter((receipt) => receipt.kind === 'HARVEST')).toHaveLength(1);
  });

  it('cannot add a side bet after its wild outcome is known', async () => {
    const rounds = service();
    const { roundId, opened } = await openRound(rounds);
    let frame = (
      await rounds.advance(roundId, {
        idempotencyKey: key('advance'),
        expectedFrameRevision: opened.frame.revision,
      })
    ).frame;
    expect(frame.wildPopulations[0]).toBe(4); // FIRST_LIGHT is already known to have won.

    const exposed = rounds.book(roundId);
    Reflect.set(exposed.sideBetStakes, 'FIRST_LIGHT', 100_000_000n);

    while (frame.state === 'STAGED') {
      frame = (
        await rounds.advance(roundId, {
          idempotencyKey: key('advance'),
          expectedFrameRevision: frame.revision,
        })
      ).frame;
    }
    const settled = await rounds.settle(roundId, {
      idempotencyKey: key('settle'),
      expectedFrameRevision: frame.revision,
    });
    expect(settled.value.stakedUnits).toBe(CREDIT);
    expect(settled.value.receipts.some((receipt) => receipt.kind === 'SIDE_BET')).toBe(false);
  });
});

describe('finding 2 — service requests are snapshotted exactly once', () => {
  it('does not let a stake getter pass the session limit with one value and execute another', async () => {
    const rounds = service();
    rounds.protection.set({ budgetUnits: '100000' });
    const { roundId } = rounds.createRound();
    let stakeReads = 0;
    const request = {
      idempotencyKey: key('hostile-open'),
      expectedFrameRevision: 0,
      get stakeUnits() {
        stakeReads += 1;
        return stakeReads === 1 ? 100_000n : 1_000_000_000n;
      },
      sideBets: [],
      clientEntropy: ENTROPY,
    };

    await rounds.open(roundId, request);
    expect(stakeReads).toBe(1);
    expect(rounds.wallet.stakedUnits).toBe(100_000n);
    expect(rounds.book(roundId).stakeUnits).toBe(100_000n);
  });

  it('uses one Proxy snapshot for a harvest fingerprint and its execution', async () => {
    const rounds = service();
    const { roundId, opened } = await openRound(rounds);
    const advanced = await rounds.advance(roundId, {
      idempotencyKey: key('advance'),
      expectedFrameRevision: opened.frame.revision,
    });
    let unitReads = 0;
    const target = {
      idempotencyKey: key('hostile-harvest'),
      expectedFrameRevision: advanced.frame.revision,
      units: 1,
    };
    const request = new Proxy(target, {
      get(object, property, receiver) {
        if (property === 'units') {
          unitReads += 1;
          return unitReads === 1 ? 1 : 2;
        }
        return Reflect.get(object, property, receiver);
      },
    });

    const harvested = await rounds.harvest(roundId, request);
    expect(unitReads).toBe(1);
    expect(harvested.receipts[0]?.unitsHarvested).toBe(1);
    expect(harvested.frame.units).toBe(3);

    const retried = await rounds.harvest(roundId, { ...target, units: 1 });
    expect(retried).toEqual(harvested);
  });
});

describe('finding 4 — wallet posting is atomic', () => {
  it('commits no debit when a later receipt in the same posting fails', () => {
    const wallet = new Wallet(10n);
    const receipt = (sequence: number, amountUnits: bigint): Receipt => ({
      schema: 'receipt-v2',
      sequence,
      kind: 'OPEN',
      line: 'COLONY',
      direction: 'DEBIT',
      stage: 0,
      amountUnits,
      unitsHarvested: 0,
      resolved: null,
      theoretical: null,
      capped: false,
    });

    expect(() => wallet.post([receipt(1, 5n), receipt(2, 20n)])).toThrow();
    expect(wallet.balanceUnits).toBe(10n);
    expect(wallet.stakedUnits).toBe(0n);
    expect(wallet.creditedUnits).toBe(0n);
  });
});

const servers: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const app = servers.pop();
    if (app === undefined || !app.server.listening) continue;
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

async function startHttp(clock: { now: number }) {
  const app = createApp({
    openingBalanceUnits: 10_000n * CREDIT,
    seedSource: () => SEED_A,
    roundIdSource: (round) => `retry-round-${round}`,
    clock: () => clock.now,
    pacing: NO_PACING,
  });
  servers.push(app);
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  const { port } = app.server.address() as AddressInfo;
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { app, post };
}

describe('finding 5 — exact retries neither move abandonment nor substitute a frame', () => {
  it('replays the recorded frame over HTTP without moving lastCommandAt', async () => {
    const clock = { now: 1_800_000_000_000 };
    const { app, post } = await startHttp(clock);
    const created = await post('/api/rounds');
    const roundId = created.body.roundId as string;
    const openBody = {
      idempotencyKey: key('retry-open'),
      expectedFrameRevision: 0,
      stakeUnits: CREDIT.toString(),
      sideBets: [],
      clientEntropy: ENTROPY,
    };
    const opened = await post(`/api/rounds/${roundId}/open`, openBody);
    clock.now += 1_000;
    const advanced = await post(`/api/rounds/${roundId}/advance`, {
      idempotencyKey: key('advance'),
      expectedFrameRevision: opened.body.frame.revision,
    });
    const progressAt = app.service.record(roundId).lastCommandAt;
    expect(advanced.body.frame).not.toEqual(opened.body.frame);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      clock.now += 1_000;
      const retried = await post(`/api/rounds/${roundId}/open`, openBody);
      expect(retried.status).toBe(200);
      expect(retried.body.frame).toEqual(opened.body.frame);
      expect(retried.body.receipts).toEqual(opened.body.receipts);
      expect(app.service.record(roundId).lastCommandAt).toBe(progressAt);
    }
  });
});

describe('finding 6 — seeds remain in server custody and are unique', () => {
  it('regenerates a colliding seed and ignores caller seed-shaped input', () => {
    const issued = [SEED_A, SEED_A, SEED_B];
    let reads = 0;
    const rounds = service({
      seedSource: () => issued[reads++] as string,
      roundIdSource: (round) => `seed-round-${round}`,
    });
    const first = (rounds.createRound as unknown as (request: unknown) => ReturnType<RoundService['createRound']>)({
      seed: 'f'.repeat(64),
    });
    const second = rounds.createRound();

    expect(first.seedCommitment).toBe(seedCommitment(SEED_A, first.roundId));
    expect(second.seedCommitment).toBe(seedCommitment(SEED_B, second.roundId));
    expect(second.seedCommitment).not.toBe(seedCommitment(SEED_A, second.roundId));
    expect(reads).toBe(3);
    expect(JSON.stringify(rounds.record(first.roundId))).not.toContain(SEED_A);
  });
});

describe('finding 7 — every meaningful receipt field is verified', () => {
  const context = roundContext('verify-hardening', ENTROPY);
  const grid = deriveGrid(SEED_A, context);
  const round = replayRound(grid, (_stage, units) => Math.floor(units / 2));
  const settlement = sealSettlement({
    seedHex: SEED_A,
    context,
    seedCommitment: seedCommitment(SEED_A, context.roundId),
    stakeUnits: CREDIT,
    sideBetStakes: { FIRST_LIGHT: 100_000n },
    round,
    wild: wildLineOf(grid),
    settlementMode: 'PLAYER',
  });
  const bundle = { ...settlement.proof, receipts: settlement.receipts };

  it('fails closed when each receipt field is changed one at a time', () => {
    const creditAt = bundle.receipts.findIndex(
      (receipt) => receipt.direction === 'CREDIT' && receipt.theoretical !== null,
    );
    const settleAt = bundle.receipts.findIndex((receipt) => receipt.kind === 'SETTLE');
    expect(creditAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThanOrEqual(0);

    const cases: readonly [string, number, Partial<Receipt>][] = [
      ['schema', 0, { schema: 'receipt-v2-tampered' as Receipt['schema'] }],
      ['sequence', 0, { sequence: 99 }],
      ['kind', 0, { kind: 'HARVEST' }],
      ['line', 0, { line: 'FIRST_LIGHT' }],
      ['direction', 0, { direction: 'CREDIT' }],
      ['stage', 0, { stage: 7 }],
      ['amountUnits', 0, { amountUnits: CREDIT + 1n }],
      ['unitsHarvested', creditAt, { unitsHarvested: 99 }],
      ['resolved', 0, { resolved: 'WON' }],
      [
        'theoretical',
        creditAt,
        {
          theoretical: {
            numerator: (bundle.receipts[creditAt]?.theoretical?.numerator ?? 0n) + 1n,
            denominator: bundle.receipts[creditAt]?.theoretical?.denominator ?? 1n,
          },
        },
      ],
      ['capped', creditAt, { capped: true }],
      ['terminal', settleAt, { terminal: 'FINAL' }],
    ];

    for (const [field, at, patch] of cases) {
      const receipts = bundle.receipts.map((receipt, index) =>
        index === at ? ({ ...receipt, ...patch } as Receipt) : receipt,
      );
      const result = verifyRound({ ...bundle, receipts });
      expect(result.ok, `${field} was accepted as VERIFIED`).toBe(false);
      expect(result.code, field).not.toBe('VERIFIED');
    }
  });
});

describe('finding 8 — pacing is enforced by the service without HTTP', () => {
  it('holds direct service calls to the configured floor', async () => {
    const rounds = service({
      seedSource: (roundId) => roundId.endsWith('-1') ? SEED_A : SEED_B,
      roundIdSource: (round) => `paced-round-${round}`,
      pacing: { roundCycleMs: 30, decisionDeadPeriodMs: 20, settlementHoldMs: 10 },
    });
    const first = rounds.createRound();
    const second = rounds.createRound();
    const startedAt = Date.now();
    await rounds.open(first.roundId, {
      idempotencyKey: key('paced-open'),
      expectedFrameRevision: 0,
      stakeUnits: CREDIT,
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    await rounds.open(second.roundId, {
      idempotencyKey: key('paced-open'),
      expectedFrameRevision: 0,
      stakeUnits: CREDIT,
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});
