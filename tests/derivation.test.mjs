import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_CHAIN_DOMAIN,
  BODY_COMMITMENT_VERSION,
  DRAW_LABEL,
  SAMPLER_DOMAIN,
  SEED_COMMITMENT_VERSION,
  actionChain,
  adapterFingerprint,
  constantTimeHexEqual,
  drawIndex,
  encodeFields,
  normalizeClientEntropy,
  normalizeSeed,
  playRound,
  proofBundle,
  resolveDraw,
  resolveSideBets,
  roundContext,
  seedCommitment,
  settleTicket,
  simulate,
  uniformBigInt,
  verifyRound,
  wildLine,
} from '../tools/simulate.mjs';
import {
  BLOOM_THRESHOLD,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_STAKE_UNITS,
  OFFSPRING,
  SIDE_BET_MAX_WIN_MULTIPLES,
} from '../tools/lib/config.mjs';
import { POLICIES } from '../tools/lib/model.mjs';
import { compare, rat, subtract, toDecimal, toFraction } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const engineDoc = readFileSync(`${root}docs/ENGINE.md`, 'utf8');

// ---------------------------------------------------------------------------
// Frozen wire-format vectors. These pin the derivation: any change to the
// canonical encoding, the domain separation, the client-entropy contribution,
// the draw bands, the slot discipline or the ladder breaks them, which is the
// point.
// ---------------------------------------------------------------------------
const VECTOR = {
  seed: '8aab6a6a82cf229e5ae45a72dc909c902dae5fbd145153625eeefa5195d03b6f',
  clientEntropy: 'b'.repeat(64),
  roundId: 'swarm-vector-1',
  fingerprint: 'e0bd79dff89e025d62a41bf611c2f456f6e6375fa8201af40c6ee0d988e34ecc',
  seedCommitment: 'd138a171d7652c1ccd98e9407478f7e4b19aee5f911950fbb1f1aa8ac6102d74',
  firstDraws: [12, 1, 10, 19, 6, 13, 10, 18, 9, 7, 19, 8, 6, 6, 9],
  run: {
    populations: [2, 2, 3, 2, 3, 0],
    reason: 'EXTINCT',
    total: '0/1',
  },
  half: {
    actions: [
      { generation: 1, kind: 'HARVEST', units: 1 },
      { generation: 2, kind: 'CONTINUE', units: 0 },
      { generation: 3, kind: 'HARVEST', units: 1 },
      { generation: 4, kind: 'CONTINUE', units: 0 },
      { generation: 5, kind: 'HARVEST', units: 1 },
    ],
    populations: [2, 1, 2, 1, 2, 0],
    reason: 'EXTINCT',
    total: '8113/4096',
  },
  bank: { reason: 'BANKED', total: '19/24', actions: [{ generation: 1, kind: 'BANK', units: 2 }] },
};

/**
 * A frozen winning ticket. The colony line pays nothing and the side bets pay
 * 27.25 credits on 2.10 staked — the exact configuration a single round-level
 * cap on the colony stake would have short-paid.
 */
const TICKET = {
  seed: 'a1053cf9d4e7158153247cb389f5879ed90ff85a6dc0fa12a88249dd9a8df595',
  clientEntropy: 'c'.repeat(64),
  roundId: 'swarm-vector-side',
  wildPopulations: [4, 4, 7, 6, 7, 8, 11, 12, 13, 9, 11, 7, 6, 4, 1, 2, 3, 0],
  seedCommitment: 'b00b982f4460d7d6a7d86bab61695248eba600e02106279ce0a0a785dec662d4',
  bodyCommitment: '880a22fc1cdf1118ea921f47384d669ef459a65205ac0d9d72369dacd194e5f6',
  actionChain: '0a8e3db9f2be7637168f8e39ace0e6d3b47f778f2fee5e82d4c46bcaa17c1e1d',
  ledger: [
    [1, 'OPEN', 'COLONY', 'DEBIT', 1000000n, null],
    [2, 'OPEN', 'FIRST_LIGHT', 'DEBIT', 500000n, null],
    [3, 'OPEN', 'DARK_VENT', 'DEBIT', 500000n, null],
    [4, 'OPEN', 'SWARM', 'DEBIT', 100000n, null],
    [5, 'SETTLE', 'COLONY', 'CREDIT', 0n, null],
    [6, 'SIDE_BET', 'FIRST_LIGHT', 'CREDIT', 2375000n, 'WON'],
    [7, 'SIDE_BET', 'DARK_VENT', 'CREDIT', 0n, 'LOST'],
    [8, 'SIDE_BET', 'SWARM', 'CREDIT', 24879850n, 'WON'],
  ],
  stakedUnits: 2100000n,
  creditedUnits: 27254850n,
};

const vectorContext = () => roundContext(VECTOR.roundId, VECTOR.clientEntropy);
const ticketContext = () => roundContext(TICKET.roundId, TICKET.clientEntropy);

const settleVector = (overrides = {}) =>
  settleTicket({
    seedHex: TICKET.seed,
    roundId: TICKET.roundId,
    clientEntropy: TICKET.clientEntropy,
    stakeUnits: 1000000n,
    sideBetStakes: { FIRST_LIGHT: 500000n, DARK_VENT: 500000n, SWARM: 100000n },
    policy: POLICIES.RUN.fn,
    ...overrides,
  });

describe('canonical encoding', () => {
  it('is unambiguous across field boundaries', () => {
    expect(encodeFields(['ab', 'c'])).not.toEqual(encodeFields(['a', 'bc']));
    expect(encodeFields(['a', 'b'])).not.toEqual(encodeFields(['ab']));
    expect(encodeFields([1, '1'])).toEqual(encodeFields(['1', 1]));
    expect(encodeFields([1n])).toEqual(encodeFields(['1']));
  });

  it('length-prefixes the field count and every field', () => {
    const encoded = encodeFields(['ab']);
    expect(encoded.readUInt32BE(0)).toBe(1);
    expect(encoded.readUInt32BE(4)).toBe(2);
    expect(encoded.subarray(8).toString('utf8')).toBe('ab');
  });

  it('refuses unsafe numbers', () => {
    expect(() => encodeFields([1.5])).toThrow(/not safe/u);
  });
});

describe('seed and client entropy handling', () => {
  it('accepts exactly 32 bytes of hex and lowercases it', () => {
    expect(normalizeSeed('A'.repeat(64))).toBe('a'.repeat(64));
    expect(normalizeClientEntropy('B'.repeat(64))).toBe('b'.repeat(64));
  });

  it('rejects anything else, and says which value it is complaining about', () => {
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42, null, `0x${'a'.repeat(62)}`]) {
      expect(() => normalizeSeed(bad)).toThrow(/Seed must be exactly 32 bytes of hexadecimal/u);
      expect(() => normalizeClientEntropy(bad)).toThrow(
        /Client entropy must be exactly 32 bytes of hexadecimal/u,
      );
    }
  });

  it('will not build a round context without both halves', () => {
    expect(() => roundContext('', VECTOR.clientEntropy)).toThrow(/Round id/u);
    expect(() => roundContext('x'.repeat(129), VECTOR.clientEntropy)).toThrow(/Round id/u);
    expect(() => roundContext(VECTOR.roundId, undefined)).toThrow(/Client entropy/u);
  });

  it('compares digests in constant time, and only equal-length ones', () => {
    expect(constantTimeHexEqual('ab12', 'ab12')).toBe(true);
    expect(constantTimeHexEqual('ab12', 'ab13')).toBe(false);
    expect(constantTimeHexEqual('ab12', 'ab1234')).toBe(false);
    expect(constantTimeHexEqual('ab12', 42)).toBe(false);
  });
});

describe('draw derivation', () => {
  it('reproduces the frozen adapter fingerprint and seed pre-commitment', () => {
    // The fingerprint binds the economics *and* the proof surface; the seed
    // pre-commitment binds the seed, the fingerprint and the grid shape.
    // docs/ENGINE.md sections 2 and 4.2.
    expect(adapterFingerprint()).toBe(VECTOR.fingerprint);
    expect(seedCommitment(VECTOR.seed, VECTOR.roundId)).toBe(VECTOR.seedCommitment);
    expect(SEED_COMMITMENT_VERSION).toBe('reveal-engine/stage-seed-commit-v1');
    expect(BODY_COMMITMENT_VERSION).toBe('reveal-engine/stage-body-commit-v1');
    expect(SAMPLER_DOMAIN).toBe('reveal-engine/stage-draw-v2');
    // The specification and the reference implementation must not drift.
    for (const value of [
      SEED_COMMITMENT_VERSION,
      BODY_COMMITMENT_VERSION,
      SAMPLER_DOMAIN,
      ACTION_CHAIN_DOMAIN,
      VECTOR.fingerprint,
    ])
      expect(engineDoc, value).toContain(value);
  });

  it('reproduces the frozen draw grid prefix', () => {
    const context = vectorContext();
    const draws = [];
    for (let generation = 1; generation <= 3; generation += 1)
      for (let slot = 1; slot <= 5; slot += 1)
        draws.push(
          Number(
            uniformBigInt(VECTOR.seed, context, DRAW_LABEL, drawIndex(generation, slot), DRAW_MODULUS),
          ),
        );
    expect(draws).toEqual(VECTOR.firstDraws);
  });

  it('is deterministic and domain separated, client entropy included', () => {
    const context = vectorContext();
    const draw = (ctx, index) => uniformBigInt(VECTOR.seed, ctx, DRAW_LABEL, index, DRAW_MODULUS);
    expect(draw(context, 0)).toBe(draw(context, 0));
    expect(draw(roundContext('other-round', VECTOR.clientEntropy), 0)).not.toBe(draw(context, 0));
    expect(draw(context, 1)).not.toBe(draw(context, 0));
    expect(uniformBigInt(VECTOR.seed, context, 'other-label', 0, DRAW_MODULUS)).not.toBe(
      draw(context, 0),
    );
    // The round-3 addition: the player's entropy is part of the payload, so a
    // different client seed is a different grid. This is what makes grinding the
    // server seed against a known grid impossible (docs/ENGINE.md §4.5).
    expect(draw(roundContext(VECTOR.roundId, 'd'.repeat(64)), 0)).not.toBe(draw(context, 0));
  });

  it('gives a different whole round for a different client seed', () => {
    const mine = playRound(VECTOR.seed, vectorContext(), () => 0);
    const theirs = playRound(VECTOR.seed, roundContext(VECTOR.roundId, 'd'.repeat(64)), () => 0);
    expect(mine.trace.map((entry) => entry.population)).not.toEqual(
      theirs.trace.map((entry) => entry.population),
    );
    // ...and the seed pre-commitment is unchanged by it, because it was
    // published before the client seed existed.
    expect(seedCommitment(VECTOR.seed, VECTOR.roundId)).toBe(VECTOR.seedCommitment);
  });

  it('stays inside the modulus for a long prefix of the grid', () => {
    const context = vectorContext();
    for (let index = 0; index < 270; index += 1) {
      const value = uniformBigInt(VECTOR.seed, context, DRAW_LABEL, index, DRAW_MODULUS);
      expect(value >= 0n && value < DRAW_MODULUS).toBe(true);
    }
  });

  it('indexes the grid without collisions', () => {
    const seen = new Set();
    for (let generation = 1; generation <= MAX_GENERATIONS; generation += 1)
      for (let slot = 1; slot < BLOOM_THRESHOLD; slot += 1) {
        const index = drawIndex(generation, slot);
        expect(seen.has(index)).toBe(false);
        seen.add(index);
      }
    expect(seen.size).toBe(MAX_GENERATIONS * (BLOOM_THRESHOLD - 1));
  });

  it('rejects out-of-range coordinates and moduli', () => {
    const context = vectorContext();
    expect(() => drawIndex(0, 1)).toThrow(/Generation out of range/u);
    expect(() => drawIndex(MAX_GENERATIONS + 1, 1)).toThrow(/Generation out of range/u);
    expect(() => drawIndex(1, 0)).toThrow(/Slot out of range/u);
    expect(() => drawIndex(1, BLOOM_THRESHOLD)).toThrow(/Slot out of range/u);
    expect(() => uniformBigInt(VECTOR.seed, context, DRAW_LABEL, 0, 0n)).toThrow(/Modulus/u);
    expect(() => uniformBigInt(VECTOR.seed, context, DRAW_LABEL, -1, DRAW_MODULUS)).toThrow(/Counter/u);
  });

  it('maps every draw to the documented band', () => {
    for (let draw = 0n; draw < DRAW_MODULUS; draw += 1n) {
      const band = resolveDraw(draw);
      const expected = OFFSPRING.find((outcome) => draw >= outcome.lowDraw && draw <= outcome.highDraw);
      expect(band.id).toBe(expected.id);
      expect(band.children).toBe(expected.children);
    }
    expect(() => resolveDraw(DRAW_MODULUS)).toThrow(/outside the declared bands/u);
  });
});

describe('round replay and the action log', () => {
  it('reproduces the frozen RUN round', () => {
    const result = playRound(VECTOR.seed, vectorContext(), () => 0);
    expect(result.trace.map((entry) => entry.population)).toEqual(VECTOR.run.populations);
    expect(result.reason).toBe(VECTOR.run.reason);
    expect(toFraction(result.total)).toBe(VECTOR.run.total);
  });

  it('reproduces the frozen HALF round, which consumes different draws', () => {
    const result = playRound(VECTOR.seed, vectorContext(), (_t, n) => Math.floor(n / 2));
    expect(result.trace.map((entry) => entry.population)).toEqual(VECTOR.half.populations);
    expect(result.actions.map(({ generation, kind, units }) => ({ generation, kind, units }))).toEqual(
      VECTOR.half.actions,
    );
    expect(result.reason).toBe(VECTOR.half.reason);
    expect(toFraction(result.total)).toBe(VECTOR.half.total);
    // Harvesting really does change the future: on the same committed grid the
    // harvested colony meets different draws and follows a different path.
    expect(result.trace.map((entry) => entry.population)).not.toEqual(VECTOR.run.populations);
  });

  it('reproduces the frozen BANK round and labels it a BANK', () => {
    const result = playRound(VECTOR.seed, vectorContext(), (_t, n) => n);
    expect(result.reason).toBe(VECTOR.bank.reason);
    expect(toFraction(result.total)).toBe(VECTOR.bank.total);
    expect(result.actions.map(({ generation, kind, units }) => ({ generation, kind, units }))).toEqual(
      VECTOR.bank.actions,
    );
  });

  it('accepts every legal harvest quantum, not only floor(n/2)', () => {
    // docs/ENGINE.md §3 sets thinning.clientQuantum to 'any' precisely so the
    // maximum-variance policy in MATH.md §11 is expressible.
    const context = vectorContext();
    for (let k = 0; k <= 2; k += 1) {
      const result = playRound(VECTOR.seed, context, (_t, n) => Math.min(k, n));
      expect(result.actions.every((action) => action.units <= action.population)).toBe(true);
    }
    const one = playRound(VECTOR.seed, context, (_t, n) => (n >= 2 ? 1 : 0));
    expect(one.actions.filter((action) => action.kind === 'HARVEST').length).toBeGreaterThan(0);
  });

  it('rejects an illegal harvest from a policy', () => {
    const context = vectorContext();
    expect(() => playRound(VECTOR.seed, context, (_t, n) => n + 1)).toThrow(/illegal harvest/u);
    expect(() => playRound(VECTOR.seed, context, () => -1)).toThrow(/illegal harvest/u);
    expect(() => playRound(VECTOR.seed, context, null)).toThrow(/decision source/u);
  });
});

describe('the action chain', () => {
  it('starts at the seed pre-commitment and extends, never rewrites', () => {
    const round = playRound(VECTOR.seed, vectorContext(), (_t, n) => Math.floor(n / 2));
    const chain = actionChain(VECTOR.seedCommitment, round.events);
    expect(chain.values[0]).toBe(VECTOR.seedCommitment);
    expect(chain.values).toHaveLength(round.events.length + 1);
    expect(chain.terminal).toBe(chain.values.at(-1));
    // A client that stopped watching at event k holds a value that the full
    // chain still begins with: the operator cannot rewrite a witnessed prefix.
    const partial = actionChain(VECTOR.seedCommitment, round.events.slice(0, 3));
    expect(chain.values.slice(0, 4)).toEqual(partial.values);
  });

  it('changes if any observed event changes', () => {
    const round = playRound(VECTOR.seed, vectorContext(), (_t, n) => Math.floor(n / 2));
    const base = actionChain(VECTOR.seedCommitment, round.events).terminal;
    const mutated = round.events.map((event, index) =>
      index === 2 ? { ...event, value: event.value + 1 } : event,
    );
    expect(actionChain(VECTOR.seedCommitment, mutated).terminal).not.toBe(base);
  });

  it('refuses a malformed anchor', () => {
    expect(() => actionChain('nope', [])).toThrow(/Seed commitment/u);
  });
});

describe('wild line and side-bet resolution', () => {
  it('reproduces the frozen wild line', () => {
    const line = wildLine(TICKET.seed, ticketContext());
    expect(line.populations).toEqual(TICKET.wildPopulations);
    expect(line.peak).toBe(13);
    expect(line.terminal).toBe('EXTINCT');
    expect(line.extinctGeneration).toBe(18);
  });

  it('is exactly the RUN replay of the same committed grid', () => {
    const run = playRound(TICKET.seed, ticketContext(), POLICIES.RUN.fn);
    expect(wildLine(TICKET.seed, ticketContext()).populations).toEqual(
      run.trace.map((entry) => entry.population),
    );
  });

  it('does not move when the player harvests', () => {
    // The whole point of the wild line: the base bet's actions cannot touch it.
    const before = resolveSideBets(TICKET.seed, ticketContext()).map((bet) => bet.won);
    playRound(TICKET.seed, ticketContext(), (_t, n) => Math.floor(n / 2));
    playRound(TICKET.seed, ticketContext(), (_t, n) => n);
    const after = resolveSideBets(TICKET.seed, ticketContext()).map((bet) => bet.won);
    expect(after).toEqual(before);
    expect(after).toEqual([true, false, true]);
  });

  it('exposes a peak only through the generations already resolved', () => {
    // docs/ENGINE.md §5.2: a frame may carry the wild line through the stage the
    // player has resolved, and never one stage further. `peakThrough` is the
    // accessor a frame is allowed to use, and it is monotone.
    const line = wildLine(TICKET.seed, ticketContext());
    let previous = 0;
    for (let generation = 1; generation <= line.populations.length; generation += 1) {
      const peak = line.peakThrough(generation);
      expect(peak).toBeGreaterThanOrEqual(previous);
      expect(peak).toBeLessThanOrEqual(line.peak);
      previous = peak;
    }
    expect(line.peakThrough(line.populations.length)).toBe(line.peak);
    // SWARM is decided at the first generation the peak reaches 10, and that is
    // knowable from generations already resolved.
    const decidedAt = line.populations.findIndex((value) => value >= 10) + 1;
    expect(line.peakThrough(decidedAt)).toBeGreaterThanOrEqual(10);
    expect(line.peakThrough(decidedAt - 1)).toBeLessThan(10);
  });
});

describe('ticket settlement ledger', () => {
  it('reproduces the frozen receipt ledger', () => {
    const { receipts, stakedUnits, creditedUnits } = settleVector();
    expect(
      receipts.map((receipt) => [
        receipt.sequence,
        receipt.kind,
        receipt.line,
        receipt.direction,
        receipt.amountUnits,
        receipt.resolved ?? null,
      ]),
    ).toEqual(TICKET.ledger);
    expect(stakedUnits).toBe(TICKET.stakedUnits);
    expect(creditedUnits).toBe(TICKET.creditedUnits);
  });

  it('names a line on every movement, so a side-bet credit is recordable', () => {
    const { receipts } = settleVector();
    for (const receipt of receipts) {
      expect(typeof receipt.line).toBe('string');
      expect(['DEBIT', 'CREDIT']).toContain(receipt.direction);
      expect(receipt.amountUnits >= 0n).toBe(true);
      expect(receipt.capped).toBe(false);
    }
    // One debit per selected line, and every side bet resolves exactly once.
    expect(receipts.filter((receipt) => receipt.kind === 'OPEN')).toHaveLength(4);
    expect(receipts.filter((receipt) => receipt.kind === 'SIDE_BET')).toHaveLength(3);
  });

  it('resolves side bets only after the colony line has settled', () => {
    const { receipts } = settleVector();
    const lastColony = receipts.findLastIndex((receipt) => receipt.line === 'COLONY');
    const firstSideBet = receipts.findIndex((receipt) => receipt.kind === 'SIDE_BET');
    expect(firstSideBet).toBeGreaterThan(lastColony);
  });

  it('pays every line in full at the most hostile stake ratio', () => {
    // 0.10 credits on the colony, 100.00 on SWARM: the shared-basis failure case.
    const { receipts, creditedUnits } = settleVector({
      stakeUnits: 100000n,
      sideBetStakes: { SWARM: 100000000n },
    });
    const swarm = receipts.find((receipt) => receipt.line === 'SWARM' && receipt.kind === 'SIDE_BET');
    expect(swarm.resolved).toBe('WON');
    expect(swarm.capped).toBe(false);
    expect(swarm.amountUnits).toBe(24879850562n);
    // A single 906x cap on the 0.10 colony stake would have paid 90,600,000.
    expect(creditedUnits).toBeGreaterThan(100000n * COLONY_MAX_WIN_MULTIPLE);
  });

  it('never credits more than the disclosed worst-case exposure', () => {
    const { creditedUnits, exposureUnits } = settleVector();
    expect(creditedUnits).toBeLessThan(exposureUnits);
    expect(exposureUnits).toBe(
      1000000n * COLONY_MAX_WIN_MULTIPLE +
        500000n * SIDE_BET_MAX_WIN_MULTIPLES.FIRST_LIGHT +
        500000n * SIDE_BET_MAX_WIN_MULTIPLES.DARK_VENT +
        100000n * SIDE_BET_MAX_WIN_MULTIPLES.SWARM,
    );
  });

  it('refuses a ticket outside the declared stake bounds before any money moves', () => {
    expect(() => settleVector({ stakeUnits: MAX_STAKE_UNITS + 1n })).toThrow(
      /outside the declared bounds/u,
    );
    expect(() => settleVector({ sideBetStakes: { SWARM: 1n } })).toThrow(/outside the declared bounds/u);
    expect(() => settleVector({ sideBetStakes: { NOPE: 1000000n } })).toThrow(/No such side bet/u);
  });

  it('records a harvesting round as one credit per harvest, in order', () => {
    const { receipts } = settleVector({
      policy: POLICIES.HALF_EVERY.fn,
      sideBetStakes: {},
    });
    const harvests = receipts.filter((receipt) => receipt.kind === 'HARVEST');
    expect(harvests.length).toBeGreaterThan(0);
    for (let index = 1; index < harvests.length; index += 1)
      expect(harvests[index].stage).toBeGreaterThan(harvests[index - 1].stage);
    expect(receipts.filter((receipt) => receipt.kind === 'SIDE_BET')).toHaveLength(0);
  });

  it('emits a zero SETTLE receipt after a full bank, because settle() is still required', () => {
    // docs/ENGINE.md §5.3: a full BANK reaches AWAITING_SETTLEMENT, and only
    // settle() reveals the seed and resolves the side bets. The ledger therefore
    // has one shape on every path.
    const { receipts, round } = settleVector({ policy: POLICIES.BANK_FIRST.fn });
    expect(round.reason).toBe('BANKED');
    const settle = receipts.find((receipt) => receipt.kind === 'SETTLE');
    expect(settle).toBeDefined();
    expect(settle.line).toBe('COLONY');
    expect(settle.amountUnits).toBe(0n);
    expect(receipts.filter((receipt) => receipt.kind === 'SIDE_BET')).toHaveLength(3);
  });
});

describe('two-phase commitment and verification', () => {
  it('reproduces the frozen proof bundle', () => {
    const settlement = settleVector();
    expect(settlement.proof.seedCommitment).toBe(TICKET.seedCommitment);
    expect(settlement.proof.bodyCommitment).toBe(TICKET.bodyCommitment);
    expect(settlement.proof.actionChain).toBe(TICKET.actionChain);
    expect(settlement.proof.adapterFingerprint).toBe(VECTOR.fingerprint);
  });

  it('verifies an honest settlement', () => {
    const result = verifyRound(proofBundle(settleVector()));
    expect(result).toMatchObject({ ok: true, code: 'VERIFIED' });
  });

  // ---------------------------------------------------------------------------
  // The blocker this scheme exists for. Round 2 committed only the seed and the
  // grid shape, so one published commitment could be settled under any number of
  // mutually inconsistent action logs and every artifact still verified.
  // ---------------------------------------------------------------------------
  it('produces different bodies for two settlements of one seed pre-commitment', () => {
    const a = settleVector({ policy: POLICIES.RUN.fn });
    const b = settleVector({ policy: POLICIES.HALF_EVERY.fn });
    expect(a.proof.seedCommitment).toBe(b.proof.seedCommitment);
    expect(a.proof.bodyCommitment).not.toBe(b.proof.bodyCommitment);
    expect(a.proof.actionChain).not.toBe(b.proof.actionChain);
  });

  it('rejects one settlement re-published under the other settlement log', () => {
    const a = settleVector({ policy: POLICIES.RUN.fn });
    const b = settleVector({ policy: POLICIES.HALF_EVERY.fn });
    // Guard against a vacuous pass: if the two policies happened to make the
    // same decisions on this grid, swapping the logs would not be a forgery at
    // all and the assertion below would prove nothing.
    expect(a.proof.actionLog).not.toEqual(b.proof.actionLog);
    const swapped = { ...proofBundle(a), actionLog: b.proof.actionLog };
    const result = verifyRound(swapped);
    expect(result.ok).toBe(false);
    expect(['TRANSCRIPT_MISMATCH', 'COMMITMENT_MISMATCH', 'DERIVATION_FAILED']).toContain(result.code);
  });

  it('rejects an action log rewritten in place, keeping the published body', () => {
    const settlement = settleVector({ policy: POLICIES.HALF_EVERY.fn, sideBetStakes: {} });
    const forged = {
      ...proofBundle(settlement),
      actionLog: settlement.proof.actionLog.map((entry) => ({
        ...entry,
        kind: 'CONTINUE',
        units: 0,
      })),
    };
    expect(verifyRound(forged).ok).toBe(false);
  });

  it('rejects a log that is honest but attached to a rewritten ledger', () => {
    const settlement = settleVector();
    const bundle = proofBundle(settlement);
    const receipts = bundle.receipts.map((receipt) =>
      receipt.line === 'SWARM' && receipt.kind === 'SIDE_BET'
        ? { ...receipt, amountUnits: receipt.amountUnits * 2n }
        : receipt,
    );
    expect(verifyRound({ ...bundle, receipts })).toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
  });

  it('rejects a tampered population list, terminal, chain or body', () => {
    const bundle = proofBundle(settleVector());
    expect(
      verifyRound({ ...bundle, populations: bundle.populations.map((value) => value + 1) }).code,
    ).toBe('TRANSCRIPT_MISMATCH');
    expect(verifyRound({ ...bundle, terminal: 'BLOOM' }).code).toBe('TRANSCRIPT_MISMATCH');
    expect(verifyRound({ ...bundle, actionChain: 'f'.repeat(64) }).code).toBe('COMMITMENT_MISMATCH');
    expect(verifyRound({ ...bundle, bodyCommitment: 'f'.repeat(64) }).code).toBe(
      'COMMITMENT_MISMATCH',
    );
  });

  it('rejects a swapped seed, client seed, round id or fingerprint', () => {
    const bundle = proofBundle(settleVector());
    expect(verifyRound({ ...bundle, revealedSeed: 'a'.repeat(64) }).code).toBe('COMMITMENT_MISMATCH');
    expect(verifyRound({ ...bundle, roundId: 'someone-elses-round' }).code).toBe(
      'COMMITMENT_MISMATCH',
    );
    // A different client seed is a different grid, so the replay diverges first.
    expect(verifyRound({ ...bundle, clientEntropy: 'd'.repeat(64) }).ok).toBe(false);
    expect(verifyRound({ ...bundle, adapterFingerprint: 'f'.repeat(64) }).code).toBe(
      'ADAPTER_MISMATCH',
    );
  });

  it('rejects a side-bet result that does not re-derive', () => {
    const bundle = proofBundle(settleVector());
    const sideBetResults = bundle.sideBetResults.map((entry) =>
      entry.id === 'DARK_VENT' ? { ...entry, resolved: 'WON' } : entry,
    );
    expect(verifyRound({ ...bundle, sideBetResults }).code).toBe('TRANSCRIPT_MISMATCH');
  });

  it('fails closed on hostile input, and never throws a stack trace at the caller', () => {
    for (const hostile of [null, 42, 'nope', {}, { actionLog: 'x' }, { adapterFingerprint: null }]) {
      const result = verifyRound(hostile);
      expect(result.ok).toBe(false);
      expect(typeof result.code).toBe('string');
      expect(
        ['INVALID_TRANSCRIPT', 'ADAPTER_MISMATCH', 'DERIVATION_FAILED', 'COMMITMENT_MISMATCH'],
      ).toContain(result.code);
    }
    const bundle = proofBundle(settleVector());
    expect(verifyRound({ ...bundle, actionLog: new Array(MAX_GENERATIONS + 1).fill({}) }).code).toBe(
      'INVALID_TRANSCRIPT',
    );
    expect(verifyRound({ ...bundle, receipts: undefined }).code).toBe('INVALID_TRANSCRIPT');
  });
});

describe('Monte Carlo cross-check', () => {
  // Sanity only: the enumeration is the proof. Seeded, so a failure reproduces.
  const seed = '00'.repeat(31) + '2a';

  it('agrees with the exact RTP for a low-variance policy', () => {
    const result = simulate({ rounds: 20000, seed, policy: 'BANK_FIRST' });
    const error = subtract(result.empiricalRtp, rat(19n, 20n));
    // 5 standard errors of a policy with sd 0.513058 over 20000 rounds.
    const bound = rat(182n, 10000n);
    expect(compare(error, bound) <= 0 && compare(error, rat(-182n, 10000n)) >= 0).toBe(true);
  });

  it('agrees with the exact RTP and hit rate for a harvesting policy', () => {
    const result = simulate({ rounds: 20000, seed, policy: 'HALF_EVERY' });
    const error = subtract(result.empiricalRtp, rat(19n, 20n));
    const bound = rat(514n, 10000n); // 5 standard errors of sd 1.453021
    expect(compare(error, bound) <= 0 && compare(error, rat(-514n, 10000n)) >= 0).toBe(true);
    // Exact hit rate is 0.8080000219; 20000 samples put the 5-sigma band at ~0.014.
    const hitError = subtract(result.hitRate, rat(808n, 1000n));
    expect(compare(hitError, rat(14n, 1000n)) <= 0 && compare(hitError, rat(-14n, 1000n)) >= 0).toBe(true);
  });

  it('reproduces the simulation figures quoted in docs/MATH.md', () => {
    const result = simulate({ rounds: 50000, seed, policy: 'RUN' });
    const math = readFileSync(`${root}docs/MATH.md`, 'utf8');
    const rtp = toDecimal(result.empiricalRtp, 6);
    const generations = toDecimal(result.meanGenerations, 4);
    expect(math).toContain(rtp);
    expect(math).toContain(generations);
    // Generation-1 extinction converges on the exact 8/125 = 0.064.
    expect(Number(toDecimal(result.generationOneExtinctionRate, 4))).toBeCloseTo(0.064, 2);
  }, 120000);

  it('rejects hostile simulation parameters', () => {
    expect(() => simulate({ rounds: 1, seed, policy: 'NOPE' })).toThrow(/Unknown policy/u);
    expect(() => simulate({ rounds: 1, seed: 'zz', policy: 'RUN' })).toThrow(/hexadecimal/u);
  });
});
