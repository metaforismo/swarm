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
    // `docs/DESIGN.md` §9.7's floors are real elapsed time on a real clock, and a
    // suite that plays dozens of rounds would spend minutes waiting them out. They
    // are switched off here and asserted on their own, with default settings, in
    // "the speed-of-play floors" below.
    pacing: { roundCycleMs: 0, decisionDeadPeriodMs: 0, settlementHoldMs: 0 },
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
    const swarmPeaks: number[] = [];
    const observe = (payload: any): void => {
      const value = payload.frame;
      if (value.stage >= 1) disclosed[value.stage - 1] = value.wildUnits;
      // A frame carries wild-line state and never a bet resolution (§5.2), and it
      // never carries a stage the player has not resolved.
      expect(value.sideBetChips).toBeUndefined();
      expect(value.wildPopulations).toHaveLength(value.state === 'SETTLED' ? 12 : value.stage);
      swarmPeaks.push(value.wildPeakUnits);
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
    // The wild line through generation 1 and no further: FIRST LIGHT is decided
    // by it, and the client derives that chip rather than the protocol shipping a
    // resolution (§5.2, DESIGN §4.2).
    expect(frame.wildPopulations).toEqual([4]);
    expect(frame.wildPeakUnits).toBe(4);
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
    // The disclosed peak is monotone and never runs ahead of the wild line the
    // player has resolved: 3 (the seeded colony) then 4, 5, 6.
    expect(swarmPeaks).toEqual([3, 4, 4, 5, 5, 6, 6]);

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

    // The client seed is part of the payload — it decides every draw — so the
    // same key with a different seed is a conflict, not a replay.
    const otherEntropy = await post(base, `/api/rounds/${roundId}/open`, {
      ...openBody,
      clientEntropy: 'd'.repeat(64),
    });
    expect(otherEntropy.status).toBe(409);
    expect(otherEntropy.json.error.code).toBe('IDEMPOTENCY_CONFLICT');

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

    // The forced bank is money, and money the ledger records has to reach the
    // wallet: 1000.00 opening, 1.00 staked, 1.583333 credited.
    expect(reconciled.json.session.balanceUnits).toBe(String(1_000n * CREDIT - CREDIT + 1_583_333n));
    expect(reconciled.json.session.history[0].netUnits).toBe(String(1_583_333n - CREDIT));

    // The reserved key replays: a retry of the call that stopped the clock is not
    // `TOO_EARLY`, and it credits nothing a second time.
    const retried = await post(base, `/api/rounds/${roundId}/reconcile`);
    expect(retried.status).toBe(200);
    expect(retried.json.settlement.proof.bodyCommitment).toBe(
      reconciled.json.settlement.proof.bodyCommitment,
    );
    expect(retried.json.session.balanceUnits).toBe(reconciled.json.session.balanceUnits);
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
    /*
     * Provenance, and the round-2 finding it closes.
     *
     * `reveal-engine/staged-survival-v1` is SWARM's own module contract
     * (`docs/ENGINE.md` §2), not the identity of the module Reveal Engine 0.4
     * ships. Publishing it in a field called `moduleApi`, beside the engine's name
     * and version, read as a conformance claim to a module that provably cannot
     * express this game. Both identities are now served, each with its owner, and
     * this test is what stops the two collapsing back into one string.
     */
    expect(config.identity.adapterContract.id).toBe('reveal-engine/staged-survival-v1');
    expect(config.identity.adapterContract.owner).toContain('SWARM');
    expect(config.identity.adapterContract.implementedBy).toContain('this repository');
    expect(config.identity.moduleApi).toBeUndefined();
    expect(config.identity.engine.moduleApiVersion).toBe('reveal-engine/module-v1');
    expect(config.identity.engine.shippedModule).toEqual({ id: 'staged-survival', version: '1.0.0' });
    expect(config.identity.engine.doesNotProvide).toContain('cannot express offspring');
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
    // This harness runs with the floors off; the published values are the
    // service's own, so the assertion is on the shape and on `enforcedBy`.
    expect(config.pacing.enforcedBy).toBe('server and client');
    const defaults = (await get((await start(FIXTURE_A, { pacing: undefined })).base, '/api/config')).json;
    expect(defaults.pacing).toEqual({
      roundCycleMs: 2500,
      decisionDeadPeriodMs: 350,
      settlementHoldMs: 600,
      enforcedBy: 'server and client',
    });
    // §9.9's surfaces are configuration too: the client renders them from here.
    expect(defaults.protection.realityCheckMinutes).toBe(30);
    expect(defaults.protection.limitCoolOffHours).toBe(24);
    expect(defaults.protection.limits.map((limit: any) => limit.field)).toEqual([
      'budgetUnits',
      'lossUnits',
      'timeMinutes',
    ]);
    expect(defaults.protection.helpResources.length).toBeGreaterThanOrEqual(3);
    for (const resource of defaults.protection.helpResources)
      expect(resource.url).toMatch(/^https:\/\//u);
    expect(defaults.protection.freePlayNotice).toContain('NO CASH VALUE');
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

/**
 * `docs/DESIGN.md` §9.7 states the floors as properties of the product — "a whole
 * round cannot be chained faster than this, however much is skipped". Round 2's
 * review found them only in `src/client/app.js`, and chained about 26 rounds a
 * second through the documented API. These run with the real defaults and real
 * elapsed time, which is why they are the only slow tests in the suite.
 */
describe('the speed-of-play floors', () => {
  const spread = (fixture: { roundId: string }) => ({
    pacing: undefined,
    roundIdSource: (counter: number) => `${fixture.roundId}-${counter}`,
  });

  const stake = async (base: string, roundId: string) =>
    post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    });

  it('holds a chained round to the 2,500 ms cycle floor', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));
    const first = (await post(base, '/api/rounds')).json.roundId as string;
    const second = (await post(base, '/api/rounds')).json.roundId as string;

    const startedAt = Date.now();
    const one = await stake(base, first);
    const two = await stake(base, second);
    const gap = Date.now() - startedAt;

    // A wait, never a refusal: both stakes are accepted, the second one late.
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(gap).toBeGreaterThanOrEqual(2500);
  }, 20000);

  it('holds a decision to the 350 ms dead period', async () => {
    /*
     * The floor runs from the moment the *server* admits a command, not from the
     * moment its response reaches the caller: the dead period is "the gap between
     * watching and deciding", and the watching starts when the frame is produced.
     * A caller that fires the next command the instant the previous response
     * lands therefore observes the floor minus one round trip, so the interval
     * asserted here is cumulative — measured from before the first command — which
     * is exactly the claim §9.7 makes and is immune to how slow the process is.
     *
     * The A/B against an unpaced service is what separates "held" from "merely
     * slow", and it is preceded by a discarded warm-up run: without one, the
     * first grid derivation in a cold process costs a few hundred milliseconds
     * and lands entirely on whichever side goes first.
     *
     * FIXTURE_B rides to generation 18, so two generations are always there to
     * resolve, and it keeps its own round id because one round is enough.
     */
    const run = async (harness: Harness): Promise<number> => {
      const roundId = (await post(harness.base, '/api/rounds')).json.roundId as string;
      const startedAt = Date.now();
      const opened = await stake(harness.base, roundId);
      expect(opened.status).toBe(200);
      let frame = opened.json.frame;
      for (let step = 0; step < 2; step += 1) {
        const advanced = await post(harness.base, `/api/rounds/${roundId}/advance`, {
          idempotencyKey: key(),
          expectedFrameRevision: frame.revision,
        });
        expect(advanced.status).toBe(200);
        expect(advanced.json.frame.state).toBe('STAGED');
        frame = advanced.json.frame;
      }
      return Date.now() - startedAt;
    };

    await run(await start(FIXTURE_B)); // warm-up, discarded
    const unpaced = await run(await start(FIXTURE_B));
    const paced = await run(await start(FIXTURE_B, { pacing: undefined }));

    // Two dead periods after the open's own: a stake and two resolutions cannot
    // be chained inside 700 ms.
    expect(paced).toBeGreaterThanOrEqual(700);
    expect(paced - unpaced).toBeGreaterThanOrEqual(500);
  }, 20000);

  /*
   * A floor is charged for cycling a round, and a refused command has not cycled
   * one. Without the release, ten pieces of garbage cost 25 s of held connections
   * and pushed the next honest stake behind all ten cycle floors — so arguing with
   * the API was slower than playing it, and a client could hold a connection per
   * malformed request it chose to send.
   */
  it('charges no floor for a command it refuses', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));

    // Ten opens that cannot succeed: the client entropy is not 32 bytes of hex.
    const refusedAt = Date.now();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const roundId = (await post(base, '/api/rounds')).json.roundId as string;
      const refused = await post(base, `/api/rounds/${roundId}/open`, {
        idempotencyKey: key(),
        expectedFrameRevision: 0,
        stakeUnits: '1000000',
        sideBets: [],
        clientEntropy: 'not-thirty-two-bytes-of-hex',
      });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('INVALID_REQUEST');
    }
    const refusalCost = Date.now() - refusedAt;
    // Ten refusals are answered promptly rather than each waiting out a cycle.
    expect(refusalCost).toBeLessThan(2500);

    // And the first honest stake after them is not queued behind ten floors.
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    const honestAt = Date.now();
    const opened = await stake(base, roundId);
    expect(opened.status).toBe(200);
    expect(Date.now() - honestAt).toBeLessThan(2500);
  }, 30000);

  /*
   * The release must give a slot back without ever *shortening* a floor, and the
   * first implementation of it did both. A round already open can be `open`ed
   * again — a retry, or a stale fence — so a refused `open` can land on a live
   * round, and deleting that round's dead period instead of restoring it let a
   * client take its next decision immediately by getting one command deliberately
   * refused first. Measured before the fix: 4 ms against a 350 ms floor.
   *
   * The cycle gate is allowed to fall into the past first, so the refused `open`
   * is admitted with no wait of its own and cannot pay the floor it is clearing.
   */
  it('cannot be cleared by getting a command deliberately refused', async () => {
    const { base } = await start(FIXTURE_B, spread(FIXTURE_B));
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    const opened = await stake(base, roundId);
    expect(opened.status).toBe(200);

    // Let the 2,500 ms cycle gate expire, so nothing below waits on it.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const advanced = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: opened.json.frame.revision,
    });
    expect(advanced.status).toBe(200);

    // A refused `open` on this live round: it must not clear the dead period the
    // accepted `advance` above just established.
    const startedAt = Date.now();
    const refused = await post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 999,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    expect(refused.json.error.code).toBe('STALE_FRAME');

    const next = await post(base, `/api/rounds/${roundId}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: advanced.json.frame.revision,
    });
    expect(next.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
  }, 30000);

  it('still charges the floor for a command it accepts', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));
    const first = (await post(base, '/api/rounds')).json.roundId as string;
    const second = (await post(base, '/api/rounds')).json.roundId as string;

    // A refusal between two accepted stakes releases only its own slot: the floor
    // between the two real ones is untouched.
    const startedAt = Date.now();
    expect((await stake(base, first)).status).toBe(200);
    const refused = await post(base, `/api/rounds/${second}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: 'not-a-number',
      sideBets: [],
      clientEntropy: ENTROPY,
    });
    expect(refused.json.error.code).toBe('INVALID_REQUEST');
    expect((await stake(base, second)).status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
  }, 20000);
});

/**
 * `docs/DESIGN.md` §9.9. Round 2's review found this section almost entirely
 * unimplemented and undisclosed; these are the four surfaces, on the server,
 * because a limit a reload clears is not a limit.
 */
describe('the player-protection surfaces', () => {
  const spread = (fixture: { roundId: string }, extra: Record<string, unknown> = {}) => ({
    roundIdSource: (counter: number) => `${fixture.roundId}-${counter}`,
    ...extra,
  });

  const stake = async (base: string, roundId: string, units = '1000000') =>
    post(base, `/api/rounds/${roundId}/open`, {
      idempotencyKey: key(),
      expectedFrameRevision: 0,
      stakeUnits: units,
      sideBets: [],
      clientEntropy: ENTROPY,
    });

  it('refuses a stake past the budget the player set — and only a stake', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));
    await post(base, '/api/limits', { budgetUnits: '1500000' });

    const first = (await post(base, '/api/rounds')).json.roundId as string;
    const opened = await stake(base, first);
    expect(opened.status).toBe(200);

    const second = (await post(base, '/api/rounds')).json.roundId as string;
    const refused = await stake(base, second);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('LIMIT_REACHED');
    expect(refused.json.error.path).toBe('$.limits.budgetUnits');

    // A limit never interrupts a round that is already staked: the player can
    // always finish it and bank it.
    const advanced = await post(base, `/api/rounds/${first}/advance`, {
      idempotencyKey: key(),
      expectedFrameRevision: opened.json.frame.revision,
    });
    expect(advanced.status).toBe(200);
  });

  it('publishes the locked state instead of making the client provoke it', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));
    expect((await get(base, '/api/session')).json.limitReached).toBeNull();
    await post(base, '/api/limits', { budgetUnits: '0' });
    const session = (await get(base, '/api/session')).json;
    // Probed at the *smallest legal ticket*: "is a stake of nothing refused" is
    // never the question a budget answers.
    expect(session.limitReached.field).toBe('budgetUnits');
  });

  it('applies a tightening at once and holds a loosening for the cool-off', async () => {
    const harness = await start(FIXTURE_A, spread(FIXTURE_A, { limitCoolOffHours: 24 }));
    const { base, clock } = harness;

    // Off → 5.00: a tightening, and it binds now.
    await post(base, '/api/limits', { lossUnits: '5000000' });
    expect((await get(base, '/api/limits')).json.limits.lossUnits).toBe('5000000');

    // 5.00 → 10.00: a loosening, and it waits.
    const raised = (await post(base, '/api/limits', { lossUnits: '10000000' })).json;
    expect(raised.limits.lossUnits).toBe('5000000');
    expect(raised.limits.pending).toEqual([
      { field: 'lossUnits', value: '10000000', effectiveAt: clock.now + 24 * 60 * 60 * 1000 },
    ]);

    // A tightening while a loosening is pending cancels it: the player who just
    // lowered a limit is not also asking to raise it later.
    const lowered = (await post(base, '/api/limits', { lossUnits: '2000000' })).json;
    expect(lowered.limits.lossUnits).toBe('2000000');
    expect(lowered.limits.pending).toEqual([]);

    // Removing it entirely waits out the cool-off, then lands on its own.
    await post(base, '/api/limits', { lossUnits: null });
    expect((await get(base, '/api/limits')).json.limits.lossUnits).toBe('2000000');
    clock.now += 24 * 60 * 60 * 1000;
    const released = (await get(base, '/api/limits')).json;
    expect(released.limits.lossUnits).toBeNull();
    expect(released.limits.pending).toEqual([]);
  });

  it('refuses further stakes once the loss limit binds', async () => {
    const { base } = await start(FIXTURE_C, spread(FIXTURE_C));
    await post(base, '/api/limits', { lossUnits: '500000' });
    const roundId = (await post(base, '/api/rounds')).json.roundId as string;
    const opened = await stake(base, roundId);
    expect(opened.status).toBe(200);
    // FIXTURE_C goes extinct: the round returns nothing, so the session is down a
    // whole credit and past a half-credit loss limit.
    let frame = opened.json.frame;
    while (frame.state === 'STAGED') {
      const next = await post(base, `/api/rounds/${roundId}/advance`, {
        idempotencyKey: key(),
        expectedFrameRevision: frame.revision,
      });
      frame = next.json.frame;
    }
    await post(base, `/api/rounds/${roundId}/settle`, {
      idempotencyKey: key(),
      expectedFrameRevision: frame.revision,
    });
    const session = (await get(base, '/api/session')).json;
    expect(BigInt(session.netUnits)).toBeLessThan(-500000n);
    expect(session.limitReached.field).toBe('lossUnits');

    const another = (await post(base, '/api/rounds')).json.roundId as string;
    const refused = await stake(base, another);
    expect(refused.status).toBe(403);
    expect(refused.json.error.path).toBe('$.limits.lossUnits');
  });

  it('falls due for a reality check on the server clock, and restarts on acknowledgement', async () => {
    const harness = await start(FIXTURE_A, spread(FIXTURE_A, { realityCheckMinutes: 30 }));
    const { base, clock } = harness;
    const before = (await get(base, '/api/session')).json;
    expect(before.realityCheck).toMatchObject({ intervalMinutes: 30, due: false });

    clock.now += 30 * 60 * 1000 + 1;
    const due = (await get(base, '/api/session')).json;
    expect(due.realityCheck.due).toBe(true);
    expect(due.elapsedMs).toBeGreaterThanOrEqual(30 * 60 * 1000);

    const acknowledged = (await post(base, '/api/reality-check')).json;
    expect(acknowledged.realityCheck.due).toBe(false);
    expect(acknowledged.realityCheck.sinceMs).toBe(0);
    // A reload does not clear it: the clock is the server's.
    clock.now += 29 * 60 * 1000;
    expect((await get(base, '/api/session')).json.realityCheck.due).toBe(false);
    clock.now += 61 * 1000;
    expect((await get(base, '/api/session')).json.realityCheck.due).toBe(true);
  });

  it('refuses a malformed limit with a typed code and a path', async () => {
    const { base } = await start(FIXTURE_A, spread(FIXTURE_A));
    for (const [body, path] of [
      [{ timeMinutes: -5 }, '$.timeMinutes'],
      [{ timeMinutes: 1.5 }, '$.timeMinutes'],
      [{ timeMinutes: 100000 }, '$.timeMinutes'],
      [{ lossUnits: 'lots' }, '$.lossUnits'],
      [{ lossUnits: 1000000 }, '$.lossUnits'],
      [{ budgetUnits: '-1' }, '$.budgetUnits'],
      [{ budgetUnits: '9'.repeat(30) }, '$.budgetUnits'],
    ] as const) {
      const response = await post(base, '/api/limits', body);
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('INVALID_REQUEST');
      expect(response.json.error.path).toBe(path);
      expect(JSON.stringify(response.json)).not.toContain('at ');
    }
    // The limits state is untouched by every one of them.
    expect((await get(base, '/api/limits')).json.limits).toMatchObject({
      budgetUnits: null,
      lossUnits: null,
      timeMinutes: null,
    });
    const wrongMethod = await call(base, 'GET', '/api/reality-check');
    expect(wrongMethod.json.error.code).toBe('METHOD_NOT_ALLOWED');
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
