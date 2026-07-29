/**
 * SWARM reference configuration — the single source of truth for every number
 * published in docs/MATH.md, docs/DESIGN.md and README.md.
 *
 * Nothing here is tuneable at runtime. A change to any field is a new
 * `adapterVersion` and a new frozen paytable fixture (see docs/ENGINE.md).
 */

import { rat, multiply, divide, add, power, compare, fail, ONE } from './rational.mjs';

/** Wire identity of this configuration. Bumped whenever any number below changes. */
export const ADAPTER_ID = 'swarm-colony-v1';
export const ADAPTER_VERSION = '1.0.0';
export const PAYTABLE_SCHEMA = 'swarm/paytable-v1';
/** The Reveal Engine lifecycle module this adapter targets (docs/ENGINE.md). */
export const MODULE_API = 'reveal-engine/staged-survival-v1';
/** Adapter-owned promise: unchanged identity means unchanged draw behaviour. */
export const COHORT_MODEL_VERSION = 'swarm-cohort/v1';

/**
 * One uniform draw per organism per generation, over a modulus of 20.
 * Draw d in [0,20): d < 8 -> DIE, 8 <= d < 16 -> HOLD, d >= 16 -> SPLIT.
 */
export const DRAW_MODULUS = 20n;

export const OFFSPRING = Object.freeze([
  Object.freeze({ id: 'DIE', children: 0, weight: 8n, lowDraw: 0n, highDraw: 7n }),
  Object.freeze({ id: 'HOLD', children: 1, weight: 8n, lowDraw: 8n, highDraw: 15n }),
  Object.freeze({ id: 'SPLIT', children: 2, weight: 4n, lowDraw: 16n, highDraw: 19n }),
]);

/** Organisms seeded at t = 0. */
export const SEED_COUNT = 3;
/** Hard round length. Generation `MAX_GENERATIONS` force-settles the colony. */
export const MAX_GENERATIONS = 18;
/** FULL BLOOM: a population of at least this many organisms force-settles the round. */
export const BLOOM_THRESHOLD = 16;
/** Largest population the state space can hold: 2 * (BLOOM_THRESHOLD - 1). */
export const MAX_POPULATION = 2 * (BLOOM_THRESHOLD - 1);

/** Target theoretical return to player. Every bet type is priced to exactly this. */
export const TARGET_RTP = rat(19n, 20n);

/**
 * Declared risk ceiling, as a multiple of the stake, applied to the cumulative
 * credit of one round. It is the smallest integer strictly above the exact
 * maximum total a round can pay (905.776494...x, see `maximumRoundPayout()`),
 * so it is a real contractual ceiling that provably never truncates a payout.
 * `assertRiskPolicy()` in tools/lib/model.mjs re-proves this from the model.
 */
export const MAX_WIN_MULTIPLE = 906n;

/** Money is integer minor units. 1 credit = 10^6 units, so a floor crumb is 1e-6 credits. */
export const UNITS_PER_CREDIT = 1000000n;
export const MIN_STAKE_UNITS = UNITS_PER_CREDIT / 10n; // 0.10 credits
export const MAX_STAKE_UNITS = 1000n * UNITS_PER_CREDIT; // 1000 credits

/** Mean offspring per organism, exact. */
export const MU = (() => {
  const weighted = OFFSPRING.reduce((total, o) => total + o.weight * BigInt(o.children), 0n);
  return rat(weighted, DRAW_MODULUS);
})();

/** Value of one organism at generation 1, exact: RTP / (SEED_COUNT * MU). */
export const LADDER_BASE = divide(TARGET_RTP, multiply(rat(BigInt(SEED_COUNT)), MU));

/**
 * Value of one organism at generation t (t >= 1), exact:
 *   c(t) = LADDER_BASE * (1/MU)^(t-1)
 * The ladder step 1/MU is exactly the drift of the colony, which is what makes
 * colony value a martingale from generation 1 onward. See docs/MATH.md.
 */
export function organismValue(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATIONS)
    fail('INVALID_GENERATION', `Generation ${generation} is outside [1, ${MAX_GENERATIONS}]`);
  return multiply(LADDER_BASE, power(divide(ONE, MU), generation - 1));
}

/** Colony multiplier for `population` organisms at `generation`, exact. */
export function colonyMultiplier(generation, population) {
  if (!Number.isSafeInteger(population) || population < 0 || population > MAX_POPULATION)
    fail('INVALID_POPULATION', `Population ${population} is outside [0, ${MAX_POPULATION}]`);
  if (population === 0) return rat(0n);
  return multiply(organismValue(generation), rat(BigInt(population)));
}

/** The largest multiplier the paytable can produce. Reached only by a full-bloom final generation. */
export function structuralMaxMultiplier() {
  return colonyMultiplier(MAX_GENERATIONS, MAX_POPULATION);
}

/** Validates every internal consistency claim the documentation makes. Throws on any violation. */
export function assertConfig() {
  const weightTotal = OFFSPRING.reduce((total, o) => total + o.weight, 0n);
  if (weightTotal !== DRAW_MODULUS)
    fail('INVALID_CONFIG', 'Offspring weights must sum to the draw modulus');
  let cursor = 0n;
  for (const outcome of OFFSPRING) {
    if (outcome.lowDraw !== cursor || outcome.highDraw !== cursor + outcome.weight - 1n)
      fail('INVALID_CONFIG', `Draw band for ${outcome.id} is not contiguous`);
    cursor += outcome.weight;
  }
  if (compare(MU, ONE) >= 0)
    fail('INVALID_CONFIG', 'Mean offspring must be < 1 so the value ladder climbs');
  // RTP identity: expected colony value after the mandatory first generation.
  const entry = multiply(
    multiply(LADDER_BASE, rat(BigInt(SEED_COUNT))),
    MU,
  );
  if (compare(entry, TARGET_RTP) !== 0)
    fail('INVALID_CONFIG', 'Entry price does not reproduce the target RTP');
  // The declared cap must sit above the structural maximum so it can never truncate a payout.
  if (compare(structuralMaxMultiplier(), rat(MAX_WIN_MULTIPLE)) >= 0)
    fail('INVALID_CONFIG', 'Declared max-win multiple would truncate the paytable');
  if (MIN_STAKE_UNITS <= 0n || MAX_STAKE_UNITS < MIN_STAKE_UNITS)
    fail('INVALID_CONFIG', 'Stake bounds are inconsistent');
  return true;
}

/** Offspring probability mass function as exact rationals, indexed by child count. */
export function offspringPmf() {
  const pmf = [rat(0n), rat(0n), rat(0n)];
  for (const outcome of OFFSPRING)
    pmf[outcome.children] = add(pmf[outcome.children], rat(outcome.weight, DRAW_MODULUS));
  return Object.freeze(pmf);
}

/** Integer numerators of the offspring pmf over `DRAW_MODULUS`, indexed by child count. */
export function offspringWeights() {
  const weights = [0n, 0n, 0n];
  for (const outcome of OFFSPRING) weights[outcome.children] += outcome.weight;
  return Object.freeze(weights);
}

export const CONFIG = Object.freeze({
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  paytableSchema: PAYTABLE_SCHEMA,
  drawModulus: DRAW_MODULUS,
  offspring: OFFSPRING,
  seedCount: SEED_COUNT,
  maxGenerations: MAX_GENERATIONS,
  bloomThreshold: BLOOM_THRESHOLD,
  maxPopulation: MAX_POPULATION,
  targetRtp: TARGET_RTP,
  maxWinMultiple: MAX_WIN_MULTIPLE,
  unitsPerCredit: UNITS_PER_CREDIT,
  minStakeUnits: MIN_STAKE_UNITS,
  maxStakeUnits: MAX_STAKE_UNITS,
  mu: MU,
  ladderBase: LADDER_BASE,
});
