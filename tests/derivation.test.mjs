import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMITMENT_VERSION,
  DRAW_LABEL,
  commitment,
  drawIndex,
  encodeFields,
  normalizeSeed,
  playRound,
  resolveDraw,
  simulate,
  uniformBigInt,
} from '../tools/simulate.mjs';
import {
  BLOOM_THRESHOLD,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  OFFSPRING,
} from '../tools/lib/config.mjs';
import { compare, rat, subtract, toDecimal, toFraction } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Frozen wire-format vectors. These pin the derivation: any change to the
// canonical encoding, the domain separation, the draw bands, the slot
// discipline or the ladder breaks them, which is the point.
// ---------------------------------------------------------------------------
const VECTOR = {
  seed: 'a'.repeat(64),
  roundId: 'swarm-vector-1',
  commitment: 'c2322343a155613e4530c328ece9d26a39726559772cd73d7694d197b4d8ce38',
  firstDraws: [18, 8, 7, 6, 15, 2, 17, 14, 6, 7, 2, 3, 15, 13, 9],
  run: {
    populations: [3, 3, 1, 2, 1, 1, 1, 0],
    reason: 'EXTINCT',
    total: '0/1',
  },
  half: {
    trace: [
      { generation: 1, population: 3, harvest: 1 },
      { generation: 2, population: 2, harvest: 1 },
      { generation: 3, population: 0 },
    ],
    reason: 'EXTINCT',
    total: '57/64',
  },
  bank: { reason: 'BANKED', total: '19/16' },
};

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

describe('seed handling', () => {
  it('accepts exactly 32 bytes of hex and lowercases it', () => {
    expect(normalizeSeed('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42, null, `0x${'a'.repeat(62)}`])
      expect(() => normalizeSeed(bad)).toThrow(/32 bytes of hexadecimal/u);
  });
});

describe('draw derivation', () => {
  it('reproduces the frozen commitment', () => {
    expect(commitment(VECTOR.seed, VECTOR.roundId)).toBe(VECTOR.commitment);
    expect(COMMITMENT_VERSION).toBe('swarm/commit-v1');
  });

  it('reproduces the frozen draw grid prefix', () => {
    const draws = [];
    for (let generation = 1; generation <= 3; generation += 1)
      for (let slot = 1; slot <= 5; slot += 1)
        draws.push(
          Number(uniformBigInt(VECTOR.seed, VECTOR.roundId, DRAW_LABEL, drawIndex(generation, slot), DRAW_MODULUS)),
        );
    expect(draws).toEqual(VECTOR.firstDraws);
  });

  it('is deterministic and domain separated', () => {
    const draw = (roundId, index) => uniformBigInt(VECTOR.seed, roundId, DRAW_LABEL, index, DRAW_MODULUS);
    expect(draw(VECTOR.roundId, 0)).toBe(draw(VECTOR.roundId, 0));
    expect(draw('other-round', 0)).not.toBe(draw(VECTOR.roundId, 0));
    expect(draw(VECTOR.roundId, 1)).not.toBe(draw(VECTOR.roundId, 0));
    expect(uniformBigInt(VECTOR.seed, VECTOR.roundId, 'other-label', 0, DRAW_MODULUS)).not.toBe(
      draw(VECTOR.roundId, 0),
    );
  });

  it('stays inside the modulus for a long prefix of the grid', () => {
    for (let index = 0; index < 270; index += 1) {
      const value = uniformBigInt(VECTOR.seed, VECTOR.roundId, DRAW_LABEL, index, DRAW_MODULUS);
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
    expect(() => drawIndex(0, 1)).toThrow(/Generation out of range/u);
    expect(() => drawIndex(MAX_GENERATIONS + 1, 1)).toThrow(/Generation out of range/u);
    expect(() => drawIndex(1, 0)).toThrow(/Slot out of range/u);
    expect(() => drawIndex(1, BLOOM_THRESHOLD)).toThrow(/Slot out of range/u);
    expect(() => uniformBigInt(VECTOR.seed, VECTOR.roundId, DRAW_LABEL, 0, 0n)).toThrow(/Modulus/u);
    expect(() => uniformBigInt(VECTOR.seed, VECTOR.roundId, DRAW_LABEL, -1, DRAW_MODULUS)).toThrow(/Counter/u);
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

describe('round replay', () => {
  it('reproduces the frozen RUN round', () => {
    const result = playRound(VECTOR.seed, VECTOR.roundId, () => 0);
    expect(result.trace.map((entry) => entry.population)).toEqual(VECTOR.run.populations);
    expect(result.reason).toBe(VECTOR.run.reason);
    expect(toFraction(result.total)).toBe(VECTOR.run.total);
  });

  it('reproduces the frozen HALF round, which consumes different draws', () => {
    const result = playRound(VECTOR.seed, VECTOR.roundId, (_t, n) => Math.floor(n / 2));
    expect(result.trace).toEqual(VECTOR.half.trace);
    expect(result.reason).toBe(VECTOR.half.reason);
    expect(toFraction(result.total)).toBe(VECTOR.half.total);
    // Harvesting really does change the future: the RUN line survived to
    // generation 8 on the same seed, the harvested line died at generation 3.
    expect(result.trace.length).not.toBe(VECTOR.run.populations.length);
  });

  it('reproduces the frozen BANK round', () => {
    const result = playRound(VECTOR.seed, VECTOR.roundId, (_t, n) => n);
    expect(result.reason).toBe(VECTOR.bank.reason);
    expect(toFraction(result.total)).toBe(VECTOR.bank.total);
  });

  it('rejects an illegal harvest from a policy', () => {
    expect(() => playRound(VECTOR.seed, VECTOR.roundId, (_t, n) => n + 1)).toThrow(/illegal harvest/u);
    expect(() => playRound(VECTOR.seed, VECTOR.roundId, () => -1)).toThrow(/illegal harvest/u);
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
    expect(rtp).toBe('0.965665');
    expect(generations).toBe('5.8415');
    expect(math).toContain(rtp);
    expect(math).toContain(generations);
    // Generation-1 extinction converges on the exact 8/125 = 0.064.
    expect(toDecimal(result.generationOneExtinctionRate, 4)).toBe('0.0639');
  }, 60000);

  it('rejects hostile simulation parameters', () => {
    expect(() => simulate({ rounds: 1, seed, policy: 'NOPE' })).toThrow(/Unknown policy/u);
    expect(() => simulate({ rounds: 1, seed: 'zz', policy: 'RUN' })).toThrow(/hexadecimal/u);
  });
});
