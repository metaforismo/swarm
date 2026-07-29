/**
 * Presentation contracts derived from the exact model.
 *
 * docs/DESIGN.md makes numeric promises about what the player sees and hears:
 * which verdict band a generation lands in, which note of the chord sounds, how
 * often a round settles below the stake, and how the colony is laid out on
 * screen. Round 2 shipped those numbers as hand-written prose outside any
 * generated block, and one of them — an audio band that was provably unreachable
 * at populations 13, 14 and 15 — was wrong for exactly that reason.
 *
 * Everything in this file is exact, enumerated, and published through
 * `tools/lib/doctables.mjs`, so a presentation promise the model cannot keep
 * fails the build like any other wrong number.
 */

import {
  BLOOM_THRESHOLD,
  MAX_GENERATIONS,
  MAX_POPULATION,
  SEED_COUNT,
  TARGET_RTP,
  colonyMultiplier,
} from './config.mjs';
import { POLICIES, aliveOccupancy, buildKernel, policyOutcomeSplit } from './model.mjs';
import {
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fail,
  isqrt,
  multiply,
  power,
  rat,
  subtract,
} from './rational.mjs';
import { DRAW_MODULUS } from './config.mjs';

const B = BLOOM_THRESHOLD;
const G = MAX_GENERATIONS;
const KERNEL = buildKernel();
const POWERS = (() => {
  const powers = [1n];
  for (let index = 1; index <= B; index += 1) powers.push(powers[index - 1] * DRAW_MODULUS);
  return powers;
})();

/**
 * The verdict beat is keyed to `D`, the signed change in colony value measured in
 * *stake multiples* — the money the balance would move by — and never to the
 * ratio `V(t+1)/V(t)`.
 *
 * That is the round-3 correction. A ratio band is not reachable uniformly: with
 * a FULL BLOOM threshold of 16, `V(t+1)/V(t) > 1.5` requires `m > 1.2n`, and at
 * `n = 13, 14, 15` every such `m` is at least 16, which ends the round. The top
 * ratio band was therefore silent in exactly the biggest colonies. `D` has no
 * such hole: `c(t)` climbs 25% a generation, so a large absolute gain is
 * reachable from every live population.
 */

/** The generation-1 baseline: what the colony was worth the instant it was bought. */
export const ENTRY_VALUE = TARGET_RTP;

/** The chord climbs one semitone per `3/2` of gain, from `+0` at a one-stake gain. */
export const CHORD_RATIO = Object.freeze(rat(3n, 2n));
/** Notes `+0 .. +7`. `CHORD_STEPS - 1` is the top note. */
export const CHORD_STEPS = 8;
/** MEDUSA, the large-gain treatment: the generation put at least one stake on the table. */
export const MEDUSA_THRESHOLD = ONE;
/** The heavy-loss mark: the generation took at least one stake off it. */
export const HEAVY_LOSS_THRESHOLD = Object.freeze(rat(-1n));

/** `D` threshold of chord note `step` (0-based), exact: `(3/2)^step` stake multiples. */
export function chordThreshold(step) {
  if (!Number.isSafeInteger(step) || step < 0 || step >= CHORD_STEPS)
    fail('INVALID_ARGUMENT', `Chord step ${step} is outside [0, ${CHORD_STEPS})`);
  return power(CHORD_RATIO, step);
}

/**
 * Every verdict beat the game can produce, with its exact probability.
 *
 * A verdict beat exists only where a generation resolves *without* ending the
 * round: `1 <= m <= 15` and `t < 18`. Extinction, FULL BLOOM and generation 18
 * go to their terminal screens and skip the beat entirely (docs/DESIGN.md §6.5),
 * which is precisely the fact the round-2 audio spec failed to check.
 *
 * Probabilities are the wild-line occupancy, so the table answers "how often
 * does a player hear this" rather than "how many cells of the state space
 * contain it". They sum to the expected number of verdict beats in a RUN round,
 * which is the expected round length minus its one terminal generation.
 */
export function verdictBeats() {
  const occupancy = aliveOccupancy();
  const beats = [];
  for (let generation = 1; generation < G; generation += 1) {
    const sources =
      generation === 1 ? [SEED_COUNT] : Array.from({ length: B - 1 }, (_x, i) => i + 1);
    for (const from of sources) {
      const mass = generation === 1 ? ONE : occupancy[generation - 1][from];
      if (mass.numerator === 0n) continue;
      const row = KERNEL[from];
      const bound = Math.min(B, row.length);
      for (let to = 1; to < bound; to += 1) {
        if (row[to] === 0n) continue;
        const probability = multiply(mass, rat(row[to], POWERS[from]));
        const baseline =
          generation === 1 ? ENTRY_VALUE : colonyMultiplier(generation - 1, from);
        beats.push({
          generation,
          from,
          to,
          probability,
          delta: subtract(colonyMultiplier(generation, to), baseline),
        });
      }
    }
  }
  return beats;
}

/** Total verdict-beat mass in a RUN round: the expected number of beats per round. */
export function verdictBeatMass(beats = verdictBeats()) {
  return beats.reduce((total, beat) => add(total, beat.probability), ZERO);
}

function shareAtLeast(beats, total, threshold) {
  let mass = ZERO;
  for (const beat of beats)
    if (compare(beat.delta, threshold) >= 0) mass = add(mass, beat.probability);
  return { mass, share: divide(mass, total) };
}

/**
 * The five verdict bands, with the exact share of beats that lands in each.
 * Bands partition the real line at `-1`, `0` and `+1` stake multiples, so they
 * are exhaustive and monotone in `D`, which is what makes docs/DESIGN.md §6.5's
 * rule R4 checkable rather than aspirational.
 */
export function verdictBands() {
  const beats = verdictBeats();
  const total = verdictBeatMass(beats);
  const buckets = {
    HEAVY_LOSS: ZERO,
    LOSS: ZERO,
    FLAT: ZERO,
    GAIN: ZERO,
    LARGE_GAIN: ZERO,
  };
  for (const beat of beats) {
    const key =
      compare(beat.delta, HEAVY_LOSS_THRESHOLD) <= 0
        ? 'HEAVY_LOSS'
        : compare(beat.delta, ZERO) < 0
          ? 'LOSS'
          : compare(beat.delta, ZERO) === 0
            ? 'FLAT'
            : compare(beat.delta, MEDUSA_THRESHOLD) < 0
              ? 'GAIN'
              : 'LARGE_GAIN';
    buckets[key] = add(buckets[key], beat.probability);
  }
  let mass = ZERO;
  for (const value of Object.values(buckets)) mass = add(mass, value);
  if (compare(mass, total) !== 0) fail('INVALID_MODEL', 'Verdict bands lost mass');
  return Object.entries(buckets).map(([band, value]) => ({
    band,
    mass: value,
    share: divide(value, total),
  }));
}

/**
 * The chord ladder, note by note, with a mechanical reachability proof.
 *
 * `reachable` is the number of `(generation, population)` cells from which the
 * note can sound at all, and `share` is the exact fraction of verdict beats that
 * produce it. Both are asserted strictly positive: a note that no state can
 * produce is a specification bug, and it is the specification bug round 2
 * shipped.
 */
export function chordLadder() {
  const beats = verdictBeats();
  const total = verdictBeatMass(beats);
  const rows = [];
  for (let step = 0; step < CHORD_STEPS; step += 1) {
    const threshold = chordThreshold(step);
    const { mass, share } = shareAtLeast(beats, total, threshold);
    let reachable = 0;
    let earliestGeneration = null;
    for (let generation = 2; generation <= G - 1; generation += 1)
      for (let from = 1; from < B; from += 1) {
        const best = Math.min(2 * from, B - 1);
        const delta = subtract(
          colonyMultiplier(generation, best),
          colonyMultiplier(generation - 1, from),
        );
        if (compare(delta, threshold) < 0) continue;
        reachable += 1;
        if (earliestGeneration === null) earliestGeneration = generation;
      }
    if (reachable === 0 || mass.numerator === 0n)
      fail(
        'INVALID_PRESENTATION',
        `Chord note +${step} is unreachable: no verdict beat can produce a gain of ${threshold.numerator}/${threshold.denominator} stakes`,
      );
    rows.push({ step, threshold, mass, share, reachable, earliestGeneration });
  }
  return rows;
}

/**
 * The largest gain a verdict beat can carry at each live population, and whether
 * the MEDUSA treatment is reachable there at all.
 *
 * Published because this is the exact table round 2 did not compute: under the
 * old ratio bands, `bestDelta` at `n = 13, 14, 15` was structurally incapable of
 * clearing the top band, and nothing in the build noticed.
 */
export function verdictReach() {
  const rows = [];
  for (let population = 1; population < B; population += 1) {
    const best = Math.min(2 * population, B - 1);
    let firstMedusaGeneration = null;
    let bestDelta = null;
    for (let generation = 2; generation <= G - 1; generation += 1) {
      const delta = subtract(
        colonyMultiplier(generation, best),
        colonyMultiplier(generation - 1, population),
      );
      if (bestDelta === null || compare(delta, bestDelta) > 0) bestDelta = delta;
      if (firstMedusaGeneration === null && compare(delta, MEDUSA_THRESHOLD) >= 0)
        firstMedusaGeneration = generation;
    }
    if (firstMedusaGeneration === null)
      fail(
        'INVALID_PRESENTATION',
        `The large-gain band is unreachable at population ${population}`,
      );
    rows.push({ population, bestOffspring: best, bestDelta, firstMedusaGeneration });
  }
  return rows;
}

/**
 * How a round settles, as the player experiences it: nothing, something less
 * than the stake, or a profit.
 *
 * The middle column is the one docs/DESIGN.md §7.1 exists for. It is the most
 * common outcome class in the game under the two policies a new player is most
 * likely to use, and a settlement ceremony that counts it up into the balance
 * chip like a win is a loss disguised as a win.
 *
 * `X = 1` exactly is unreachable (`stakeBoundaryIsUnreachable()` in
 * `model.mjs`), so the two classes are separated by a boundary no round can land
 * on and the split is unambiguous.
 */
export function settlementClasses() {
  return Object.values(POLICIES).map((policy) => {
    const split = policyOutcomeSplit(policy.fn);
    return {
      id: policy.id,
      label: policy.label,
      nothing: split.zero,
      belowStake: split.subStake,
      profit: split.profit,
    };
  });
}

/** Populations the layout table is published for (docs/DESIGN.md §6.4). */
export const LAYOUT_POPULATIONS = Object.freeze([1, 3, 8, 12, 15, 16, 17, 30]);
/** Largest body radius, in points, at the smallest colonies. */
export const BODY_RADIUS_MAX = Object.freeze(rat(34n));
/** Smallest body radius, in points. Below this the colony reads as a mass. */
export const BODY_RADIUS_MIN = Object.freeze(rat(12n));
/** Points of radius given up per additional organism above the seeded three. */
export const BODY_RADIUS_SLOPE = Object.freeze(rat(8n, 5n));
/** Layout radius `R(n) = 44 + (15/2) * sqrt(n)` points. */
export const LAYOUT_RADIUS_BASE = Object.freeze(rat(44n));
export const LAYOUT_RADIUS_SCALE = Object.freeze(rat(15n, 2n));

/** Body radius at population `n`, exact: `clamp(34 - (8/5)(n - 3), 12, 34)` points. */
export function bodyRadius(population) {
  if (!Number.isSafeInteger(population) || population < 1 || population > MAX_POPULATION)
    fail('INVALID_ARGUMENT', 'population out of range');
  const raw = subtract(
    BODY_RADIUS_MAX,
    multiply(BODY_RADIUS_SLOPE, rat(BigInt(population - SEED_COUNT))),
  );
  if (compare(raw, BODY_RADIUS_MAX) > 0) return { radius: BODY_RADIUS_MAX, raw, clamped: true };
  if (compare(raw, BODY_RADIUS_MIN) < 0) return { radius: BODY_RADIUS_MIN, raw, clamped: true };
  return { radius: raw, raw, clamped: false };
}

/**
 * Layout radius at population `n`, as an exact rational bound plus its truncated
 * decimal: `R(n) = 44 + (15/2) * sqrt(n)`. `sqrt(n)` is irrational for most `n`,
 * so the decimal is produced by integer square root and truncated, never by a
 * float.
 */
export function layoutRadiusDecimal(population, digits = 3) {
  if (!Number.isSafeInteger(population) || population < 1 || population > MAX_POPULATION)
    fail('INVALID_ARGUMENT', 'population out of range');
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 32)
    fail('INVALID_ARGUMENT', 'digits out of range');
  const scale = 10n ** BigInt(digits);
  // 44 + (15/2) sqrt(n), scaled by 10^digits and truncated: 44*S + 15*isqrt(n*S^2)/2.
  const root = isqrt(BigInt(population) * scale * scale);
  const scaled = 44n * scale + (15n * root) / 2n;
  const text = scaled.toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits) || '0';
  return digits === 0 ? whole : `${whole}.${text.slice(text.length - digits)}`;
}

/**
 * The colony layout contract: one body radius and one layout radius per
 * population, plus the exact population at which the radius clamp first bites.
 *
 * The clamp threshold is published as a derived number rather than a sentence
 * because the round-2 text asserted one by hand and it was argued over: the
 * unclamped radius first falls below the floor at the population this function
 * returns, and nowhere else.
 */
export function colonyLayout(populations = LAYOUT_POPULATIONS) {
  let firstClamped = null;
  for (let population = 1; population <= MAX_POPULATION; population += 1) {
    const { raw } = bodyRadius(population);
    if (compare(raw, BODY_RADIUS_MIN) < 0) {
      firstClamped = population;
      break;
    }
  }
  if (firstClamped === null) fail('INVALID_PRESENTATION', 'The body-radius clamp is unreachable');
  return {
    firstClampedPopulation: firstClamped,
    rows: populations.map((population) => {
      const body = bodyRadius(population);
      return {
        population,
        bodyRadius: body.radius,
        bodyRadiusRaw: body.raw,
        clamped: body.clamped,
        layoutRadius: layoutRadiusDecimal(population),
        // Golden-angle phyllotaxis places body i at r_i = R(n) * sqrt(i / n), so
        // the outermost body sits at exactly R(n) and the innermost at R(n)/sqrt(n).
        innermostRadius: layoutRadiusInner(population),
      };
    }),
  };
}

/** `R(n)/sqrt(n)` — where the first body of the phyllotaxis spiral sits, truncated. */
function layoutRadiusInner(population, digits = 3) {
  const scale = 10n ** BigInt(digits);
  // (44 + (15/2) sqrt(n)) / sqrt(n) = 44/sqrt(n) + 15/2.
  const root = isqrt(BigInt(population) * scale * scale);
  const scaled = (44n * scale * scale) / root + (15n * scale) / 2n;
  const text = scaled.toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits) || '0';
  return `${whole}.${text.slice(text.length - digits)}`;
}
