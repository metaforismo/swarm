/**
 * The server's proof stack, pinned against the reference implementation.
 *
 * `tools/simulate.mjs` is the reference derivation, the reference two-phase
 * commitment and the published verifier — every frozen digest in this repository
 * came out of it. The service is a separate implementation in a separate
 * language, so the only claim worth making about it is that it produces the same
 * bytes, and that the *published* verifier accepts what it settles.
 */
import { describe, expect, it } from 'vitest';
import {
  GRID_SIZE,
  SLOTS,
  SWARM,
  adapterFingerprint,
  cohortValue,
  ladderValue,
} from '../src/server/adapter.ts';
import { encodeFields } from '../src/server/canonical.ts';
import { actionChain, bodyCommitment, seedCommitment } from '../src/server/commitment.ts';
import {
  deriveGrid,
  drawIndex,
  replayRound,
  roundContext,
  stageDraw,
  wildLineOf,
} from '../src/server/derivation.ts';
import { sealSettlement } from '../src/server/settlement.ts';
import { verifyRound } from '../src/server/verify.ts';
import * as reference from '../tools/simulate.mjs';
import { organismValue } from '../tools/lib/config.mjs';
import { toFraction } from '../tools/lib/rational.mjs';

const SEED = 'dc33ba04fda908c673650e88419ab5378c52c21333103f7a90717be45909f981';
const ENTROPY = 'c'.repeat(64);
const ROUND_ID = 'swarm-vector-side';

const context = roundContext(ROUND_ID, ENTROPY);
const referenceContext = reference.roundContext(ROUND_ID, ENTROPY);

describe('canonical encoding', () => {
  it('is byte-identical to the encoder every published digest came from', () => {
    const vectors: unknown[][] = [
      [],
      [''],
      ['a', 'b'],
      ['ab', ''],
      [0, 1, 2],
      [1n, 20n, 906n],
      [Buffer.from(SEED, 'hex')],
      ['swarm-colony-v1', '1.3.0', 18, 15, 20n, Buffer.from('00', 'hex')],
    ];
    for (const fields of vectors)
      expect(encodeFields(fields as never).toString('hex')).toBe(
        reference.encodeFields(fields).toString('hex'),
      );
  });

  it('refuses an unsafe number rather than silently truncating it', () => {
    expect(() => encodeFields([Number.MAX_SAFE_INTEGER + 1])).toThrow();
  });
});

describe('the adapter', () => {
  it('reproduces the frozen fingerprint of swarm-colony-v1 @ 1.3.0', () => {
    expect(adapterFingerprint()).toBe(
      '3fc7b96ea3546f14169032d070aa48f103de7db048cc8a306cf99227d33d36cf',
    );
    expect(adapterFingerprint()).toBe(reference.adapterFingerprint());
  });

  it('declares the shape docs/ENGINE.md §3.2 declares', () => {
    expect(SWARM.id).toBe('swarm-colony-v1');
    expect(SWARM.adapterVersion).toBe('1.3.0');
    expect(SWARM.apiVersion).toBe('reveal-engine/staged-survival-v1');
    expect(SWARM.seedUnits).toBe(3);
    expect(SWARM.ladder.stages).toBe(18);
    expect(SWARM.thresholds.settleAtOrAbove).toBe(16);
    expect(SWARM.thresholds.maxUnits).toBe(30);
    expect(SWARM.thinning.commitsPerStage).toBe(1);
    expect(SWARM.thinning.clientQuantum).toBe('any');
    expect(SWARM.entropy.clientEntropyBytes).toBe(32);
    expect(SLOTS).toBe(15);
    expect(GRID_SIZE).toBe(270);
  });

  it('prices the ladder exactly as docs/MATH.md §4 publishes it', () => {
    expect(toFraction(ladderValue(1))).toBe('19/48');
    expect(toFraction(ladderValue(2))).toBe('95/192');
    expect(toFraction(ladderValue(18))).toBe('14495849609375/824633720832');
    expect(toFraction(cohortValue(3, 16))).toBe('475/48');
    for (let stage = 1; stage <= 18; stage += 1)
      expect(toFraction(ladderValue(stage))).toBe(toFraction(organismValue(stage)));
  });

  it('has no ladder value at stage 0, deliberately', () => {
    expect(() => ladderValue(0)).toThrow();
    expect(() => ladderValue(19)).toThrow();
  });
});

describe('draw derivation', () => {
  it('reproduces the reference grid, draw for draw', () => {
    const grid = deriveGrid(SEED, context);
    expect(grid.length).toBe(GRID_SIZE);
    for (let stage = 1; stage <= 18; stage += 1)
      for (let slot = 1; slot <= 15; slot += 1) {
        const index = drawIndex(stage, slot);
        expect(index).toBe(reference.drawIndex(stage, slot));
        expect(BigInt(grid[index] as number)).toBe(
          reference.uniformBigInt(SEED, referenceContext, reference.DRAW_LABEL, index, 20n),
        );
      }
  });

  it('stays inside the declared modulus', () => {
    for (const draw of deriveGrid(SEED, context)) expect(draw).toBeLessThan(20);
  });

  it('moves with the client entropy, so the operator cannot grind a grid alone', () => {
    const other = deriveGrid(SEED, roundContext(ROUND_ID, 'd'.repeat(64)));
    const mine = deriveGrid(SEED, context);
    expect(Buffer.from(other).equals(Buffer.from(mine))).toBe(false);
  });

  it('refuses entropy that is not exactly 32 bytes of hex', () => {
    for (const bad of ['', 'zz', 'c'.repeat(63), 'c'.repeat(65), 42 as unknown as string])
      expect(() => roundContext(ROUND_ID, bad)).toThrow();
  });

  it('agrees with the reference on the replayed round and the wild line', () => {
    const grid = deriveGrid(SEED, context);
    const half = (_stage: number, units: number): number => Math.floor(units / 2);
    const mine = replayRound(grid, half);
    const theirs = reference.playRound(SEED, referenceContext, half);
    expect(mine.trace.map((entry) => entry.population)).toEqual(
      theirs.trace.map((entry: { population: number }) => entry.population),
    );
    expect(mine.reason).toBe(theirs.reason);
    expect(mine.actions).toEqual(theirs.actions.map((action: { generation: number; kind: string; units: number }) => ({
      generation: action.generation,
      kind: action.kind,
      units: action.units,
    })));
    const wild = wildLineOf(grid);
    const referenceWild = reference.wildLine(SEED, referenceContext);
    expect(wild.populations).toEqual(referenceWild.populations);
    expect(wild.peak).toBe(referenceWild.peak);
    expect(wild.extinctGeneration).toBe(referenceWild.extinctGeneration);
  });

  it('consumes exactly one draw per organism per generation', () => {
    const grid = deriveGrid(SEED, context);
    // Row 1 slots 1..3 decide the mandatory generation; slot 4 belongs to nobody
    // until the colony grows into it, which is what makes the wild line a prefix.
    const first = stageDraw(SEED, context, 1, 1);
    expect(BigInt(grid[0] as number)).toBe(first);
    expect(() => stageDraw(SEED, context, 1, 16)).toThrow();
    expect(() => stageDraw(SEED, context, 19, 1)).toThrow();
  });
});

describe('the two-phase commitment', () => {
  it('reproduces the reference seed pre-commitment', () => {
    expect(seedCommitment(SEED, ROUND_ID)).toBe(reference.seedCommitment(SEED, ROUND_ID));
  });

  it('starts the action chain at the seed pre-commitment and only ever extends it', () => {
    const grid = deriveGrid(SEED, context);
    const round = replayRound(grid, () => 0);
    const phaseOne = seedCommitment(SEED, ROUND_ID);
    const chain = actionChain(phaseOne, round.events);
    const referenceChain = reference.actionChain(phaseOne, round.events);
    expect(chain.values).toEqual(referenceChain.values);
    expect(chain.values[0]).toBe(phaseOne);
    expect(chain.terminal).toBe(chain.values[chain.values.length - 1]);
  });

  it('reproduces the reference settlement body, field for field', () => {
    const grid = deriveGrid(SEED, context);
    const round = replayRound(grid, (_stage, units) => Math.floor(units / 2));
    const wild = wildLineOf(grid);
    const phaseOne = seedCommitment(SEED, ROUND_ID);
    const sealed = sealSettlement({
      seedHex: SEED,
      context,
      seedCommitment: phaseOne,
      stakeUnits: 1_000_000n,
      sideBetStakes: { SWARM: 100_000n },
      round,
      wild,
      settlementMode: 'PLAYER',
    });
    const referenceSettlement = reference.settleTicket({
      seedHex: SEED,
      roundId: ROUND_ID,
      clientEntropy: ENTROPY,
      stakeUnits: 1_000_000n,
      sideBetStakes: { SWARM: 100_000n },
      policy: (_stage: number, units: number) => Math.floor(units / 2),
    });
    expect(sealed.proof.bodyCommitment).toBe(referenceSettlement.proof.bodyCommitment);
    expect(sealed.proof.actionChain).toBe(referenceSettlement.proof.actionChain);
    expect(sealed.receipts.map((receipt) => receipt.amountUnits)).toEqual(
      referenceSettlement.receipts.map((receipt: { amountUnits: bigint }) => receipt.amountUnits),
    );
    expect(sealed.creditedUnits).toBe(referenceSettlement.creditedUnits);
  });

  it('binds the settlement mode, so a reconciled round is a different digest', () => {
    const grid = deriveGrid(SEED, context);
    const round = replayRound(grid, (_stage, units) => units);
    const wild = wildLineOf(grid);
    const phaseOne = seedCommitment(SEED, ROUND_ID);
    const common = {
      seedHex: SEED,
      context,
      seedCommitment: phaseOne,
      stakeUnits: 1_000_000n,
      sideBetStakes: {},
      round,
      wild,
    };
    const player = sealSettlement({ ...common, settlementMode: 'PLAYER' as const });
    const reconciled = sealSettlement({ ...common, settlementMode: 'RECONCILED' as const });
    expect(player.proof.terminal).toBe('BANKED');
    expect(reconciled.proof.terminal).toBe('RECONCILED');
    expect(player.proof.bodyCommitment).not.toBe(reconciled.proof.bodyCommitment);
  });

  it('is a commitment: two decision logs on one seed give two bodies', () => {
    const grid = deriveGrid(SEED, context);
    const wild = wildLineOf(grid);
    const phaseOne = seedCommitment(SEED, ROUND_ID);
    const seal = (policy: (stage: number, units: number) => number) =>
      sealSettlement({
        seedHex: SEED,
        context,
        seedCommitment: phaseOne,
        stakeUnits: 1_000_000n,
        sideBetStakes: {},
        round: replayRound(grid, policy),
        wild,
        settlementMode: 'PLAYER',
      });
    const half = seal((_stage, units) => Math.floor(units / 2));
    const run = seal(() => 0);
    expect(half.proof.actionLog).not.toEqual(run.proof.actionLog);
    expect(half.proof.seedCommitment).toBe(run.proof.seedCommitment);
    expect(half.proof.bodyCommitment).not.toBe(run.proof.bodyCommitment);

    // The attack phase 2 exists to close: one body, the other log.
    const swapped = verifyRound({
      ...run.proof,
      actionLog: half.proof.actionLog,
      receipts: run.receipts,
    });
    expect(swapped.ok).toBe(false);
    expect(['TRANSCRIPT_MISMATCH', 'COMMITMENT_MISMATCH', 'DERIVATION_FAILED']).toContain(
      swapped.code,
    );
  });
});

describe('the verifier', () => {
  const grid = deriveGrid(SEED, context);
  const round = replayRound(grid, (_stage, units) => Math.floor(units / 2));
  const settlement = sealSettlement({
    seedHex: SEED,
    context,
    seedCommitment: seedCommitment(SEED, ROUND_ID),
    stakeUnits: 1_000_000n,
    sideBetStakes: { FIRST_LIGHT: 100_000n },
    round,
    wild: wildLineOf(grid),
    settlementMode: 'PLAYER',
  });
  const bundle = { ...settlement.proof, receipts: settlement.receipts };

  it('verifies an honest settlement, step by step', () => {
    const result = verifyRound(bundle);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('VERIFIED');
    expect(result.steps).toHaveLength(8);
    expect(result.steps.every((step) => step.ok)).toBe(true);
  });

  it('is accepted by the published reference verifier', () => {
    const asReference = {
      ...bundle,
      actionLog: bundle.actionLog.map((action) => ({ ...action })),
      populations: [...bundle.populations],
      sideBetResults: bundle.sideBetResults.map((entry) => ({ ...entry })),
      receipts: bundle.receipts.map((receipt) => ({ ...receipt })),
    };
    expect(reference.verifyRound(asReference).code).toBe('VERIFIED');
  });

  it('rejects a tampered population list, terminal, chain, body or fingerprint', () => {
    const tampered = [
      { populations: [...bundle.populations.slice(0, -1), 99] },
      { terminal: 'FINAL' },
      { actionChain: '0'.repeat(64) },
      { bodyCommitment: '0'.repeat(64) },
      { adapterFingerprint: '0'.repeat(64) },
      { settlementMode: 'INVENTED' },
      { clientEntropy: 'd'.repeat(64) },
    ];
    for (const patch of tampered) {
      const result = verifyRound({ ...bundle, ...(patch as object) });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('rejects a transcript that commits one stage twice', () => {
    const harvest = bundle.actionLog.find((action) => action.kind === 'HARVEST');
    if (harvest === undefined) throw new Error('fixture has no harvest');
    const result = verifyRound({
      ...bundle,
      actionLog: [{ ...harvest, units: 1, kind: 'HARVEST' as const }, ...bundle.actionLog],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DERIVATION_FAILED');
  });

  it('fails closed on hostile input and never throws at the caller', () => {
    for (const hostile of [null, 42, 'transcript', {}, { actionLog: 'not an array' }])
      expect(() => verifyRound(hostile as never)).not.toThrow();
    expect(verifyRound(null as never).ok).toBe(false);
  });
});

describe('body commitment field discipline', () => {
  it('refuses a settlement mode it does not know', () => {
    const grid = deriveGrid(SEED, context);
    const round = replayRound(grid, () => 0);
    expect(() =>
      bodyCommitment({
        seedCommitment: seedCommitment(SEED, ROUND_ID),
        revealedSeed: SEED,
        context,
        stakeUnits: 1n,
        sideBetStakes: {},
        round,
        wild: wildLineOf(grid),
        sideBetResults: [],
        receipts: [],
        chainTerminal: '0'.repeat(64),
        settlementMode: 'MADE_UP' as never,
      }),
    ).toThrow();
  });
});
