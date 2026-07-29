/**
 * The API-level playthrough: whole rounds driven through the HTTP service, with
 * the exact credited amount asserted at every step against the ladder in
 * `docs/MATH.md` §4.
 *
 * The three fixtures are pinned by `(seed, roundId, clientEntropy)` — every draw
 * is a function of all three — so the populations below are the populations that
 * committed grid produces, and the credits below are the only credits it can pay.
 *
 *   A  swarm-fixture-0   4 → 3 → 3   harvest 2, harvest 1, bank 3   FIRST LIGHT wins
 *   B  swarm-fixture-2   ride to generation 18 and settle at 4 organisms
 *   C  swarm-fixture-1   1 → 1 → 0   extinct, and DARK VENT wins on the same grid
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/server/http.ts';
import * as reference from '../tools/simulate.mjs';

const ENTROPY = 'c'.repeat(64);
const CREDIT = 1_000_000n;

const FIXTURE_A = {
  seed: '9667b8896a62186befbaf96b9ae8e4704e44d065f0ae6aa6a43a4239c63874cb',
  roundId: 'swarm-fixture-0',
};
const FIXTURE_B = {
  seed: '0e4ac2893a15a0fc6a7caecedbc56d943eee45377f5ef4f2ecf9cc758bcb1ec2',
  roundId: 'swarm-fixture-2',
};
const FIXTURE_C = {
  seed: 'c84b422a6588bccc30f4847111fa1a5116ab4bc4b37ab122fe48c2a846b6e85f',
  roundId: 'swarm-fixture-1',
};

interface Harness {
  readonly base: string;
  close(): Promise<void>;
  clock: { now: number };
}

const running: Harness[] = [];

async function start(
  fixture: { seed: string; roundId: string },
  options: AppOptions = {},
): Promise<Harness> {
  const clock = { now: 1_760_000_000_000 };
  const { server } = createApp({
    openingBalanceUnits: 1_000n * CREDIT,
    seedSource: () => fixture.seed,
    roundIdSource: () => fixture.roundId,
    clock: () => clock.now,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    base: `http://127.0.0.1:${port}`,
    clock,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  running.push(harness);
  return harness;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function call(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const get = (base: string, path: string) => call(base, 'GET', path);
const post = (base: string, path: string, body: unknown = {}) => call(base, 'POST', path, body);

let keyCounter = 0;
const key = (): string => `test-key-${(keyCounter += 1)}`;

const amountOf = (ledger: any[], kind: string, line: string, stage?: number): bigint => {
  const receipt = ledger.find(
    (entry) => entry.kind === kind && entry.line === line && (stage === undefined || entry.stage === stage),
  );
  if (receipt === undefined) throw new Error(`no ${kind} receipt on ${line}`);
  return BigInt(receipt.amountUnits);
};

describe('the worked ticket, end to end through the API', () => {
  it('pays the exact ladder amount at every step, and nothing else', async () => {
    const { base } = await start(FIXTURE_A);

    // Phase 1 happens before a stake exists: the round is created, the seed is
    // sealed, and its pre-commitment is published.
    const created = await post(base, '/api/rounds');
    expect(created.status).toBe(201);
    expect(created.json.roundId).toBe(FIXTURE_A.roundId);
    expect(created.json.seedCommitment).toBe(
      reference.seedCommitment(FIXTURE_A.seed, FIXTURE_A.roundId),
    );
    const roundId = created.json.roundId as string;

    const beforeOpen = await get(base, `/api/rounds/${roundId}`);
    expect(beforeOpen.json.state).toBe('AWAITING_OPEN');
    expect(beforeOpen.json.seedCommitment).toBe(created.json.seedCommitment);

    // The ticket: 1.00 on the colony, 0.50 on FIRST LIGHT, 0.20 on SWARM.
    const opened = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [
        { id: 'FIRST_LIGHT', stakeUnits: '500000' },
        { id: 'SWARM', stakeUnits: '200000' },
      ],
      clientEntropy: ENTROPY,
    });
    expect(opened.status).toBe(200);
    expect(opened.json.receipts.map((receipt: any) => `${receipt.kind}:${receipt.line}:${receipt.amountUnits}`)).toEqual([
      'OPEN:COLONY:1000000',
      'OPEN:FIRST_LIGHT:500000',
      'OPEN:SWARM:200000',
    ]);
    expect(opened.json.session.balanceUnits).toBe('998300000');
    expect(opened.json.exposureUnits).toBe(String(1_000_000n * 906n + 500_000n * 5n + 200_000n * 249n));

    // Every wild-line value the round ever discloses, and every SWARM chip state,
    // collected as the round runs and checked at the end against the line the
    // settlement finally reveals (§5.2).
    const disclosed: number[] = [];
    const swarmChips: string[] = [];
    const observe = (payload: any): void => {
      const value = payload.frame;
      if (value.stage >= 1) disclosed[value.stage - 1] = value.wildUnits;
      const chip = value.sideBetChips.find((entry: any) => entry.id === 'SWARM');
      if (chip !== undefined && value.state !== 'SETTLED') swarmChips.push(chip.state);
      // A live round never carries a settlement, a revealed seed or a side-bet credit.
      if (value.state !== 'SETTLED') {
        expect(payload.settlement).toBeNull();
        expect(JSON.stringify(payload)).not.toContain('revealedSeed');
        expect(payload.ledger.every((receipt: any) => receipt.kind !== 'SIDE_BET')).toBe(true);
      }
    };

    // Stage 0: three organisms, no ladder value, no decision, chain = phase 1.
    let frame = opened.json.frame;
    observe(opened.json);
    expect(frame.stage).toBe(0);
    expect(frame.units).toBe(3);
    expect(frame.unitValue).toBeNull();
    expect(frame.colonyValue).toBeNull();
    expect(frame.decisionOpen).toBe(false);
    expect(frame.state).toBe('STAGED');
    expect(frame.actionChain).toBe(created.json.seedCommitment);
    expect(frame.wildUnits).toBe(3);

    // Harvesting before anything has resolved is refused: generation 1 is
    // mandatory and carries no decision.
    const early = await post(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
      units: 1,
    });
    expect(early.status).toBe(400);
    expect(early.json.error.code).toBe('INVALID_REQUEST');

    // Generation 1 resolves to four organisms.
    const g1 = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    observe(g1.json);
    frame = g1.json.frame;
    expect(frame.stage).toBe(1);
    expect(frame.units).toBe(4);
    expect(frame.unitValue.fraction).toBe('19/48');
    expect(frame.unitValue.decimal).toBe('0.395833');
    expect(frame.colonyValue.fraction).toBe('19/12');
    expect(frame.colonyValue.decimal).toBe('1.583333');
    expect(frame.nextUnitValue.fraction).toBe('95/192');
    expect(frame.decisionOpen).toBe(true);
    expect(frame.terminal).toBeNull();
    expect(frame.wildUnits).toBe(4);
    // FIRST LIGHT is a function of the wild line at generation 1 and nothing
    // else, so it settles the instant generation 1 resolves.
    expect(frame.sideBetChips).toEqual([
      { id: 'FIRST_LIGHT', state: 'WON', peak: null, target: 4 },
      { id: 'SWARM', state: 'LIVE', peak: 4, target: 10 },
    ]);
    // No side bet has been credited: they resolve at settlement and nowhere else.
    expect(g1.json.ledger.some((receipt: any) => receipt.kind === 'SIDE_BET')).toBe(false);

    // HARVEST 2 at c(1) = 19/48 → floor(1000000 * 2 * 19/48) = 791666.
    const h1 = await post(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
      units: 2,
    });
    expect(h1.json.receipts).toHaveLength(1);
    expect(h1.json.receipts[0]).toMatchObject({
      kind: 'HARVEST',
      line: 'COLONY',
      direction: 'CREDIT',
      stage: 1,
      unitsHarvested: 2,
      amountUnits: '791666',
      capped: false,
    });
    // The receipt carries the exact unrounded amount in minor units next to the
    // floored one: 1000000 * 19/12 = 2375000/3 = 791666.666..., credited 791666.
    expect(h1.json.receipts[0].theoretical.fraction).toBe('2375000/3');
    expect(h1.json.receipts[0].theoretical.decimal).toBe('791666.666666');
    observe(h1.json);
    frame = h1.json.frame;
    expect(frame.units).toBe(2);
    expect(frame.decisionOpen).toBe(false);
    expect(frame.stage).toBe(1);
    expect(h1.json.session.balanceUnits).toBe('999091666');

    // A stage commits once: the second harvest is refused and mutates nothing.
    const second = await post(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
      units: 1,
    });
    expect(second.status).toBe(400);
    expect(second.json.error.code).toBe('INVALID_REQUEST');
    expect((await get(base, `/api/rounds/${roundId}`)).json.frame.units).toBe(2);

    // Generation 2 resolves the two survivors to three organisms.
    const g2 = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    observe(g2.json);
    frame = g2.json.frame;
    expect(frame.stage).toBe(2);
    expect(frame.units).toBe(3);
    expect(frame.unitValue.fraction).toBe('95/192');
    expect(frame.wildUnits).toBe(5);
    expect(frame.wildPeakUnits).toBe(5);

    // HARVEST 1 at c(2) = 95/192 → floor(1000000 * 95/192) = 494791.
    const h2 = await post(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
      units: 1,
    });
    expect(h2.json.receipts[0].amountUnits).toBe('494791');
    observe(h2.json);
    frame = h2.json.frame;
    expect(frame.units).toBe(2);

    const g3 = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    observe(g3.json);
    frame = g3.json.frame;
    expect(frame.stage).toBe(3);
    expect(frame.units).toBe(3);
    expect(frame.unitValue.fraction).toBe('475/768');
    expect(frame.colonyValue.decimal).toBe('1.855468');

    // BANK: k = n. floor(1000000 * 3 * 475/768) = 1855468, terminal BANKED, and
    // the round still owes a settle() — the only call that reveals the seed.
    const banked = await post(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
      units: 3,
    });
    expect(banked.json.receipts[0].amountUnits).toBe('1855468');
    observe(banked.json);
    frame = banked.json.frame;
    expect(frame.terminal).toBe('BANKED');
    expect(frame.state).toBe('AWAITING_SETTLEMENT');
    expect(frame.units).toBe(0);
    expect(banked.json.settlement).toBeNull();

    // A duplicate tap shows the player their terminal rather than an error page.
    const afterTerminal = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    expect(afterTerminal.status).toBe(409);
    expect(afterTerminal.json.error.code).toBe('ROUND_SETTLED');
    expect(afterTerminal.json.error.detail.terminal).toBe('BANKED');

    const settled = await post(base, `/api/rounds/${roundId}/settle`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    const ledger = settled.json.settlement.receipts as any[];
    expect(ledger.map((receipt) => `${receipt.kind}:${receipt.line}:${receipt.amountUnits}`)).toEqual([
      'OPEN:COLONY:1000000',
      'OPEN:FIRST_LIGHT:500000',
      'OPEN:SWARM:200000',
      'HARVEST:COLONY:791666',
      'HARVEST:COLONY:494791',
      'HARVEST:COLONY:1855468',
      'SETTLE:COLONY:0',
      'SIDE_BET:FIRST_LIGHT:2375000',
      'SIDE_BET:SWARM:0',
    ]);
    // FIRST LIGHT pays exactly 19/4 on its own stake: 500000 * 19/4 = 2375000.
    expect(amountOf(ledger, 'SIDE_BET', 'FIRST_LIGHT')).toBe(2_375_000n);
    expect(settled.json.settlement.creditedUnits).toBe('5516925');
    expect(settled.json.settlement.stakedUnits).toBe('1700000');
    expect(settled.json.settlement.netUnits).toBe('3816925');
    expect(settled.json.session.balanceUnits).toBe('1003816925');
    expect(settled.json.frame.terminal).toBe('BANKED');
    expect(settled.json.frame.state).toBe('SETTLED');

    // The colony line lost exactly two minor units to the three floors, which is
    // the disclosed rounding gap of docs/MATH.md §13 and not an accounting error.
    const colonyCredited = 791_666n + 494_791n + 1_855_468n;
    const theoretical = (1_000_000n * 2413n) / 768n;
    expect(theoretical - colonyCredited).toBe(2n);

    // The proof verifies, on this server and under the published verifier.
    const proof = settled.json.settlement.proof;
    expect(proof.settlementMode).toBe('PLAYER');
    expect(proof.actionLog).toEqual([
      { generation: 1, kind: 'HARVEST', units: 2 },
      { generation: 2, kind: 'HARVEST', units: 1 },
      { generation: 3, kind: 'BANK', units: 3 },
    ]);
    expect(proof.populations).toEqual([4, 3, 3]);
    const verified = await post(base, '/api/verify', { proof });
    expect(verified.json.code).toBe('VERIFIED');
    expect(verified.json.steps).toHaveLength(8);
    expect(reference.verifyRound(toReferenceBundle(proof)).code).toBe('VERIFIED');

    // The whole wild line is disclosed only now, after the round (screen S8a).
    expect(settled.json.settlement.wild.populations).toEqual([4, 5, 6, 3, 2, 3, 4, 2, 1, 1, 1, 0]);
    expect(settled.json.settlement.wild.peak).toBe(6);

    // §5.2, checked against the line the round only revealed at settlement: every
    // frame carried the wild population for the stage the player had resolved and
    // never one generation further. The player harvested twice here, so their own
    // colony and the wild line had already diverged when this was disclosed.
    const wild = settled.json.settlement.wild.populations as number[];
    expect(disclosed).toEqual(wild.slice(0, disclosed.length));
    expect(disclosed.length).toBe(3);
    // SWARM never said it could no longer win: a peak is monotone, so "already
    // won" is knowable early and "cannot win" is not.
    expect(swarmChips).not.toContain('LOST');

    // A forged log, published against the honest body, is refused.
    const forged = await post(base, '/api/verify', {
      proof: { ...proof, actionLog: [{ generation: 1, kind: 'CONTINUE', units: 0 }] },
    });
    expect(forged.json.ok).toBe(false);
    expect(['TRANSCRIPT_MISMATCH', 'COMMITMENT_MISMATCH', 'DERIVATION_FAILED']).toContain(
      forged.json.code,
    );

    // The history carries the round with its terminal and its signed net result.
    const session = await get(base, '/api/session');
    expect(session.json.history[0]).toMatchObject({
      roundId,
      terminal: 'BANKED',
      settlementMode: 'PLAYER',
      netUnits: '3816925',
      generations: 3,
    });
    expect(session.json.netUnits).toBe('3816925');
  });
});

describe('a round ridden to the last generation', () => {
  it('settles 4 organisms at c(18) and credits 70.314124x', async () => {
    const { base } = await start(FIXTURE_B);
    const created = await post(base, '/api/rounds');
    const roundId = created.json.roundId as string;
    let frame = (
      await post(base, `/api/rounds/${roundId}/open`, {
        idempotencyKey: key(),
        expectedFrameRevision: 0,
        stakeUnits: '1000000',
        sideBets: [],
        clientEntropy: ENTROPY,
      })
    ).json.frame;

    const populations: number[] = [];
    for (let step = 0; step < 20 && frame.state === 'STAGED'; step += 1) {
      const advanced = await post(base, `/api/rounds/${roundId}/advance`, {
        idempotencyKey: key(),
        expectedFrameRevision: frame.revision,
      });
      frame = advanced.json.frame;
      populations.push(frame.units);
      // Nothing is credited while the colony rides: the ledger holds one debit.
      if (frame.state === 'STAGED') expect(advanced.json.ledger).toHaveLength(1);
    }
    expect(populations).toEqual([4, 5, 6, 7, 7, 5, 3, 3, 2, 3, 3, 1, 1, 1, 2, 3, 4, 4]);
    expect(frame.stage).toBe(18);
    expect(frame.terminal).toBe('FINAL');
    expect(frame.unitValue.fraction).toBe('14495849609375/824633720832');

    const settled = await post(base, `/api/rounds/${roundId}/settle`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    const ledger = settled.json.settlement.receipts as any[];
    expect(amountOf(ledger, 'SETTLE', 'COLONY')).toBe(70_314_124n);
    expect(settled.json.settlement.creditedUnits).toBe('70314124');
    expect(settled.json.settlement.proof.terminal).toBe('FINAL');
    // 17 generations carried a decision and every one of them was CONTINUE.
    expect(settled.json.settlement.proof.actionLog).toHaveLength(17);
    expect(
      settled.json.settlement.proof.actionLog.every((action: any) => action.kind === 'CONTINUE'),
    ).toBe(true);
    expect(reference.verifyRound(toReferenceBundle(settled.json.settlement.proof)).code).toBe(
      'VERIFIED',
    );
  });
});

describe('an extinct round with a live side bet', () => {
  it('credits nothing on the colony line and pays DARK VENT on its own stake', async () => {
    const { base } = await start(FIXTURE_C);
    const created = await post(base, '/api/rounds');
    const roundId = created.json.roundId as string;
    let frame = (
      await post(base, `/api/rounds/${roundId}/open`, {
        idempotencyKey: key(),
        expectedFrameRevision: 0,
        stakeUnits: '1000000',
        sideBets: [{ id: 'DARK_VENT', stakeUnits: '1000000' }],
        clientEntropy: ENTROPY,
      })
    ).json.frame;

    for (let step = 0; step < 4 && frame.state === 'STAGED'; step += 1) {
      const advanced = await post(base, `/api/rounds/${roundId}/advance`, {
        idempotencyKey: key(),
        expectedFrameRevision: frame.revision,
      });
      frame = advanced.json.frame;
    }
    expect(frame.stage).toBe(3);
    expect(frame.units).toBe(0);
    expect(frame.terminal).toBe('EXTINCT');
    expect(frame.colonyValue.fraction).toBe('0/1');

    const settled = await post(base, `/api/rounds/${roundId}/settle`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    const ledger = settled.json.settlement.receipts as any[];
    expect(amountOf(ledger, 'SETTLE', 'COLONY')).toBe(0n);
    // 2.689446x on the DARK VENT stake, on its own cap basis, with the colony
    // line at zero. Two 95% bets on one ticket, and the ticket is up.
    expect(amountOf(ledger, 'SIDE_BET', 'DARK_VENT')).toBe(2_689_446n);
    expect(settled.json.settlement.netUnits).toBe('689446');
    expect(settled.json.settlement.proof.sideBetResults).toEqual([
      { id: 'FIRST_LIGHT', resolved: 'NOT_SELECTED' },
      { id: 'DARK_VENT', resolved: 'WON' },
      { id: 'SWARM', resolved: 'NOT_SELECTED' },
    ]);
    expect(reference.verifyRound(toReferenceBundle(settled.json.settlement.proof)).code).toBe(
      'VERIFIED',
    );
  });
});

describe('the frame fence, idempotency and hostile input', () => {
  it('holds every rule docs/ENGINE.md §5.1 inherits from RoundBook', async () => {
    const { base } = await start(FIXTURE_A);
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;

    // A stake outside the declared bounds is refused before money moves.
    const tooSmall = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '99999',
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    expect(tooSmall.json.error.code).toBe('INVALID_REQUEST');

    // So is entropy that is not exactly 32 bytes of hex.
    const badEntropy = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: 'not-hex',
    });
    expect(badEntropy.json.error.code).toBe('INVALID_REQUEST');

    // And a side bet selected twice.
    const duplicate = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [
        { id: 'SWARM', stakeUnits: '100000' },
        { id: 'SWARM', stakeUnits: '100000' },
      ],
      clientEntropy: ENTROPY,
    });
    expect(duplicate.json.error.code).toBe('INVALID_REQUEST');

    const openKey = key();
    const openBody = {
      idempotencyKey: openKey,
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    };
    const opened = await post(base, `/api/rounds/${roundId}/open`, openBody);
    expect(opened.status).toBe(200);

    // An exact retry replays the receipts and the frame, and moves no money.
    const retried = await post(base, `/api/rounds/${roundId}/open`, openBody);
    expect(retried.json.receipts).toEqual(opened.json.receipts);
    expect(retried.json.session.balanceUnits).toBe(opened.json.session.balanceUnits);

    // The same key with a different payload is a conflict, not a second command.
    const conflict = await post(base, `/api/rounds/${roundId}/open`, {
      ...openBody,
      stakeUnits: '2000000',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // A stale fence mutates nothing.
    const stale = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE_FRAME');

    const frame = (await get(base, `/api/rounds/${roundId}`)).json.frame;
    const advanced = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    const live = advanced.json.frame;
    expect(live.units).toBe(4);

    for (const units of [0, -1, 5, 1.5, 'two']) {
      const bad = await post(base, `/api/rounds/${roundId}/harvest`, {
        idempotencyKey: key(),
        expectedFrameRevision: live.revision,
        units,
      });
      expect(bad.json.error.code, `units=${units}`).toBe('INVALID_REQUEST');
    }

    // Unknown routes and unknown rounds fail closed with a code, never a trace.
    expect((await get(base, '/api/nope')).json.error.code).toBe('NOT_FOUND');
    expect((await get(base, '/api/rounds/does-not-exist')).json.error.code).toBe('ROUND_NOT_FOUND');
    expect((await post(base, '/api/verify', { proof: { seedCommitment: 1 } })).json.error.code).toBe(
      'INVALID_TRANSCRIPT',
    );
  });

  it('refuses a ticket the free-play wallet cannot cover, before any receipt', async () => {
    const { base } = await start(FIXTURE_A, { openingBalanceUnits: 500_000n });
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    const refused = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    expect(refused.json.error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await get(base, '/api/session')).json.balanceUnits).toBe('500000');
  });
});

describe('the abandonment rule', () => {
  it('is refused before the timeout and forces a bank after it', async () => {
    const harness = await start(FIXTURE_A, { abandonedRoundTimeoutHours: 72 });
    const { base, clock } = harness;
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    let frame = (
      await post(base, `/api/rounds/${roundId}/open`, {
        idempotencyKey: key(),
        expectedFrameRevision: 0,
        stakeUnits: '1000000',
        sideBets: [],
        clientEntropy: ENTROPY,
      })
    ).json.frame;
    frame = (
      await post(base, `/api/rounds/${roundId}/advance`, {
        idempotencyKey: key(),
        expectedFrameRevision: frame.revision,
      })
    ).json.frame;
    expect(frame.units).toBe(4);

    const early = await post(base, `/api/rounds/${roundId}/reconcile`);
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('TOO_EARLY');

    clock.now += 72 * 60 * 60 * 1000;
    const reconciled = await post(base, `/api/rounds/${roundId}/reconcile`);
    const ledger = reconciled.json.settlement.receipts as any[];
    // A forced BANK of the whole colony at the exact current stage value:
    // floor(1000000 * 4 * 19/48) = 1583333, and the SETTLE receipt is zero.
    expect(amountOf(ledger, 'HARVEST', 'COLONY')).toBe(1_583_333n);
    expect(amountOf(ledger, 'SETTLE', 'COLONY')).toBe(0n);
    expect(reconciled.json.settlement.proof.terminal).toBe('RECONCILED');
    expect(reconciled.json.settlement.proof.settlementMode).toBe('RECONCILED');
    expect(reconciled.json.settlement.proof.actionLog).toEqual([
      { generation: 1, kind: 'BANK', units: 4 },
    ]);
    expect(reference.verifyRound(toReferenceBundle(reconciled.json.settlement.proof)).code).toBe(
      'VERIFIED',
    );
  });

  it('settles a round that was staked and never advanced', async () => {
    const harness = await start(FIXTURE_A, { abandonedRoundTimeoutHours: 72 });
    const { base, clock } = harness;
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    });

    clock.now += 73 * 60 * 60 * 1000;
    // The sweep runs on any session read: an abandoned round cannot sit holding a
    // committed seed nobody can ever publish.
    const session = await get(base, '/api/session');
    expect(session.json.history[0].terminal).toBe('RECONCILED');

    const view = await get(base, `/api/rounds/${roundId}`);
    const proof = view.json.settlement.proof;
    // Stage 0 owes its one legal command — the mandatory generation 1 — and then
    // the forced bank, which is exactly the transcript a returning player who
    // tapped once and banked would have produced.
    expect(proof.actionLog).toEqual([{ generation: 1, kind: 'BANK', units: 4 }]);
    expect(proof.populations).toEqual([4]);
    expect(amountOf(view.json.settlement.receipts, 'HARVEST', 'COLONY')).toBe(1_583_333n);
    expect(reference.verifyRound(toReferenceBundle(proof)).code).toBe('VERIFIED');

    // Relabelling a reconciled settlement as a player settlement is refused.
    const relabelled = await post(base, '/api/verify', {
      proof: { ...proof, settlementMode: 'PLAYER' },
    });
    expect(relabelled.json.ok).toBe(false);
  });
});

describe('the served configuration', () => {
  it('publishes the enumerated paytable the client renders from', async () => {
    const { base } = await start(FIXTURE_A);
    const config = (await get(base, '/api/config')).json;
    expect(config.identity.adapterId).toBe('swarm-colony-v1');
    expect(config.identity.adapterVersion).toBe('1.3.0');
    expect(config.identity.adapterFingerprint).toBe(reference.adapterFingerprint());
    expect(config.identity.engine.name).toBe('@axiom-games/reveal-engine');
    expect(config.rules.targetRtp.fraction).toBe('19/20');
    expect(config.rules.offspring.map((band: any) => `${band.id}:${band.band}:${band.percent}`)).toEqual([
      'DIE:0-7:40',
      'HOLD:8-15:40',
      'SPLIT:16-19:20',
    ]);
    expect(config.sideBets.map((bet: any) => bet.multiplier.decimal)).toEqual([
      '4.750000',
      '2.689446',
      '248.798505',
    ]);
    expect(config.money.colonyMaxWinMultiple).toBe('906');
    expect(config.published.totals.rtp).toBe('19/20');
    expect(config.published.roundMaximum.decimal).toBe('905.776494');
    expect(config.published.underwater.afterGenerationOneDecimal).toBe('0.5440000000');
    // The per-policy bloom table, which no surface may print a bare frequency from.
    const bankFirst = config.published.policies.find((policy: any) => policy.id === 'BANK_FIRST');
    expect(bankFirst.bloomOneIn).toBe('never');
    expect(bankFirst.profitRate).toBe('0.4560000000');
    expect(config.pacing).toEqual({ roundCycleMs: 2500, decisionDeadPeriodMs: 350, settlementHoldMs: 600 });
  });

  it('serves the client shell', async () => {
    const { base } = await start(FIXTURE_A);
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('SWARM');
    // No path traversal out of the client root.
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });
});

/** The published verifier takes BigInts and plain objects; the wire takes strings. */
function toReferenceBundle(proof: any): Record<string, unknown> {
  return {
    ...proof,
    stakeUnits: BigInt(proof.stakeUnits),
    sideBetStakes: Object.fromEntries(
      Object.entries(proof.sideBetStakes as Record<string, string>).map(([id, units]) => [
        id,
        BigInt(units),
      ]),
    ),
    receipts: proof.receipts.map((receipt: any) => ({
      ...receipt,
      amountUnits: BigInt(receipt.amountUnits),
      theoretical: receipt.theoretical === null ? null : parseFraction(receipt.theoretical.fraction),
    })),
  };
}

function parseFraction(text: string): { numerator: bigint; denominator: bigint } {
  const [numerator, denominator] = text.split('/');
  return { numerator: BigInt(numerator as string), denominator: BigInt(denominator as string) };
}
