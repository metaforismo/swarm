/**
 * SWARM exact outcome model.
 *
 * Everything in this file is exhaustive enumeration over the truncated
 * Galton-Watson state space with exact BigInt rational arithmetic. There is no
 * sampling, no float, and no approximation anywhere in the payable path.
 *
 * State space (see docs/MATH.md):
 *   - a round is at most MAX_GENERATIONS generations;
 *   - a decision state is (generation t, population n) with 1 <= n < BLOOM_THRESHOLD;
 *   - a terminal state is n = 0 (EXTINCT), n >= BLOOM_THRESHOLD (BLOOM),
 *     or t = MAX_GENERATIONS (FINAL);
 *   - population can never exceed MAX_POPULATION = 2 * (BLOOM_THRESHOLD - 1).
 */

import {
  add,
  compare,
  divide,
  equal,
  fail,
  gcd,
  multiply,
  ONE,
  rat,
  subtract,
  toFraction,
  ZERO,
} from './rational.mjs';
import {
  BLOOM_THRESHOLD,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_TICKET_EXPOSURE_UNITS,
  SEED_COUNT,
  SIDE_BET_MAX_WIN_MULTIPLES,
  TARGET_RTP,
  colonyMultiplier,
  maximumTicketExposureUnits,
  offspringWeights,
  organismValue,
} from './config.mjs';

const B = BLOOM_THRESHOLD;
const G = MAX_GENERATIONS;
const D = DRAW_MODULUS;

/**
 * Memoization for the pure, expensive enumerations.
 *
 * Every function wrapped here is a deterministic function of the frozen
 * configuration, so caching cannot change a result — but the report builds the
 * wild line, the reach curve and the round-maximum dynamic program dozens of
 * times, and the shared-ceiling bound alone runs the program sixteen times.
 * Results are treated as read-only by every caller; nothing in this module
 * mutates a returned structure.
 */
function memoize(compute) {
  const cache = new Map();
  return (...args) => {
    const key = args.length === 0 ? '' : args.join('|');
    if (cache.has(key)) return cache.get(key);
    const value = compute(...args);
    cache.set(key, value);
    return value;
  };
}

/**
 * K[n][m] = integer coefficient of x^m in (w0 + w1*x + w2*x^2)^n.
 * P(n organisms produce m organisms) = K[n][m] / DRAW_MODULUS^n, exactly.
 */
export function buildKernel(maxOrganisms = B - 1) {
  if (!Number.isSafeInteger(maxOrganisms) || maxOrganisms < 0 || maxOrganisms > 4096)
    fail('INVALID_ARGUMENT', 'maxOrganisms out of range');
  const w = offspringWeights();
  const rows = [[1n]];
  for (let n = 1; n <= maxOrganisms; n += 1) {
    const previous = rows[n - 1];
    const next = new Array(previous.length + 2).fill(0n);
    for (let index = 0; index < previous.length; index += 1) {
      const value = previous[index];
      if (value === 0n) continue;
      next[index] += value * w[0];
      next[index + 1] += value * w[1];
      next[index + 2] += value * w[2];
    }
    rows.push(next);
  }
  return rows;
}

const KERNEL = buildKernel();
const POWERS = (() => {
  const powers = [1n];
  for (let index = 1; index <= B; index += 1) powers.push(powers[index - 1] * D);
  return powers;
})();

/** Exact transition probability P(n -> m) as a rational. */
export function transitionProbability(n, m) {
  if (!Number.isSafeInteger(n) || n < 0 || n >= B) fail('INVALID_ARGUMENT', 'n out of range');
  const row = KERNEL[n];
  if (!Number.isSafeInteger(m) || m < 0 || m >= row.length) return ZERO;
  return rat(row[m], POWERS[n]);
}

function lcm(a, b) {
  if (a === 0n) return b;
  if (b === 0n) return a;
  return (a / gcd(a, b)) * b;
}

/**
 * Exact expectation of `values[m]` (rationals indexed by population m) under the
 * offspring kernel for `j` parents. Accumulated over one common denominator so a
 * single normalization happens per call rather than one per term.
 */
function kernelExpectation(j, values) {
  if (j === 0) return ZERO;
  const row = KERNEL[j];
  let commonDenominator = 1n;
  for (let m = 0; m < row.length; m += 1) {
    if (row[m] === 0n) continue;
    const value = values[m];
    if (value === undefined || value.numerator === 0n) continue;
    commonDenominator = lcm(commonDenominator, value.denominator);
  }
  let numerator = 0n;
  for (let m = 0; m < row.length; m += 1) {
    if (row[m] === 0n) continue;
    const value = values[m];
    if (value === undefined || value.numerator === 0n) continue;
    numerator += row[m] * value.numerator * (commonDenominator / value.denominator);
  }
  return rat(numerator, commonDenominator * POWERS[j]);
}

/** Terminal payout multiplier for a resolved generation, exact. */
export function terminalMultiplier(generation, population) {
  return colonyMultiplier(generation, population);
}

function terminalReason(generation, population) {
  if (population === 0) return 'EXTINCT';
  if (population >= B) return 'BLOOM';
  if (generation === G) return 'FINAL';
  return null;
}

/**
 * Forward enumeration of the wild line: the colony as it grows when the player
 * never harvests. This is simultaneously the reference paytable of the base bet
 * under the RUN policy and the resolution source for every side bet.
 */
function enumerateWildLineUncached() {
  const step = POWERS[B - 1];
  let denominator = 1n;
  let alive = new Array(B).fill(0n);
  alive[SEED_COUNT] = 1n;

  const terminals = [];
  const generations = [];

  for (let t = 1; t <= G; t += 1) {
    const next = new Array(MAX_POPULATION + 1).fill(0n);
    const nextDenominator = denominator * step;
    for (let n = 1; n < B; n += 1) {
      const mass = alive[n];
      if (mass === 0n) continue;
      const scale = POWERS[B - 1 - n];
      const row = KERNEL[n];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        next[m] += mass * row[m] * scale;
      }
    }

    const populations = [];
    for (let m = 0; m <= MAX_POPULATION; m += 1) {
      if (next[m] === 0n) continue;
      const probability = rat(next[m], nextDenominator);
      populations.push({ population: m, probability });
      const reason = terminalReason(t, m);
      if (reason)
        terminals.push({
          generation: t,
          population: m,
          reason,
          probability,
          multiplier: terminalMultiplier(t, m),
        });
    }
    generations.push({ generation: t, populations });

    const survivors = new Array(B).fill(0n);
    if (t < G) for (let m = 1; m < B; m += 1) survivors[m] = next[m];

    // Keep the common denominator as small as the exact value allows.
    let divisor = nextDenominator;
    for (let m = 1; m < B; m += 1) if (survivors[m] !== 0n) divisor = gcd(divisor, survivors[m]);
    if (divisor > 1n) {
      for (let m = 1; m < B; m += 1) survivors[m] /= divisor;
      denominator = nextDenominator / divisor;
    } else {
      denominator = nextDenominator;
    }
    alive = survivors;
  }

  return { terminals, generations };
}

/**
 * Exact probability that the wild line ever holds at least `threshold`
 * organisms during the round. Absorbing forward pass; used to price the SWARM
 * side bet and to state the FULL BLOOM frequency.
 */
function reachProbabilityUncached(threshold) {
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > MAX_POPULATION)
    fail('INVALID_ARGUMENT', 'threshold out of range');
  const step = POWERS[B - 1];
  let denominator = 1n;
  let alive = new Array(B).fill(0n);
  if (SEED_COUNT >= threshold) return ONE;
  alive[SEED_COUNT] = 1n;
  let reached = ZERO;

  for (let t = 1; t <= G; t += 1) {
    const next = new Array(MAX_POPULATION + 1).fill(0n);
    const nextDenominator = denominator * step;
    for (let n = 1; n < B; n += 1) {
      const mass = alive[n];
      if (mass === 0n) continue;
      const scale = POWERS[B - 1 - n];
      const row = KERNEL[n];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        next[m] += mass * row[m] * scale;
      }
    }
    const survivors = new Array(B).fill(0n);
    for (let m = threshold; m <= MAX_POPULATION; m += 1)
      if (next[m] !== 0n) reached = add(reached, rat(next[m], nextDenominator));
    if (t < G) for (let m = 1; m < Math.min(threshold, B); m += 1) survivors[m] = next[m];

    let divisor = nextDenominator;
    for (let m = 1; m < B; m += 1) if (survivors[m] !== 0n) divisor = gcd(divisor, survivors[m]);
    if (divisor > 1n) {
      for (let m = 1; m < B; m += 1) survivors[m] /= divisor;
      denominator = nextDenominator / divisor;
    } else {
      denominator = nextDenominator;
    }
    alive = survivors;
  }
  return reached;
}

/** Exact probability that the wild line is extinct at or before `generation`. */
export function extinctionByGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > G)
    fail('INVALID_ARGUMENT', 'generation out of range');
  const { generations } = enumerateWildLine();
  let total = ZERO;
  for (const row of generations) {
    if (row.generation > generation) break;
    const zero = row.populations.find((entry) => entry.population === 0);
    if (zero) total = add(total, zero.probability);
  }
  return total;
}

/**
 * Exact population distribution of the wild line at `generation`.
 *
 * Entry `population: 0` is the mass that dies *at* this generation, not the
 * cumulative extinction: extinct mass is absorbed into a terminal state and
 * never revisited. Use `extinctionByGeneration()` for the cumulative figure.
 */
export function populationDistribution(generation) {
  const { generations } = enumerateWildLine();
  const row = generations.find((entry) => entry.generation === generation);
  if (!row) fail('INVALID_ARGUMENT', 'generation out of range');
  return row.populations;
}

/**
 * A policy is a pure function (generation, population) -> harvest count k in
 * [0, population]. k = 0 lets the whole colony run; k = population banks and
 * ends the round. Policies may not look at anything else: the draw grid of a
 * future generation is not observable, which is exactly the assumption of the
 * invariance theorem in docs/MATH.md.
 */
export const POLICIES = Object.freeze({
  BANK_FIRST: { id: 'BANK_FIRST', label: 'Bank at generation 1', fn: (_t, n) => n },
  RUN: { id: 'RUN', label: 'Never harvest, ride to the end', fn: () => 0 },
  HALF_EVERY: {
    id: 'HALF_EVERY',
    label: 'Harvest half every generation',
    fn: (_t, n) => Math.floor(n / 2),
  },
  STOP_AT_2X: {
    id: 'STOP_AT_2X',
    label: 'Bank everything at 2.00x or better',
    fn: (t, n) => (compare(colonyMultiplier(t, n), rat(2n)) >= 0 ? n : 0),
  },
  STOP_AT_10X: {
    id: 'STOP_AT_10X',
    label: 'Bank everything at 10.00x or better',
    fn: (t, n) => (compare(colonyMultiplier(t, n), rat(10n)) >= 0 ? n : 0),
  },
  HALF_AT_2X: {
    id: 'HALF_AT_2X',
    label: 'Harvest half whenever value is 2.00x or better',
    fn: (t, n) => (compare(colonyMultiplier(t, n), rat(2n)) >= 0 ? Math.floor(n / 2) : 0),
  },
  BANK_AT_GEN_5: {
    id: 'BANK_AT_GEN_5',
    label: 'Bank everything at generation 5',
    fn: (t, n) => (t >= 5 ? n : 0),
  },
  PANIC: {
    id: 'PANIC',
    label: 'Bank whenever the colony shrank below 3, else run',
    fn: (_t, n) => (n < 3 ? n : 0),
  },
});

function assertPolicy(policy) {
  if (typeof policy !== 'function') fail('INVALID_ARGUMENT', 'Policy must be a function');
}

/**
 * Exact first and second moments, and the exact probability of a zero round,
 * for an arbitrary Markov policy. Backward induction over the state space:
 * no path enumeration, no sampling.
 */
export function evaluatePolicy(policy) {
  assertPolicy(policy);
  // A1[m] / A2[m] / Z[m]: value of the post-resolution state of the generation
  // currently being folded backwards.
  let first = new Array(MAX_POPULATION + 1);
  let second = new Array(MAX_POPULATION + 1);
  let zero = new Array(MAX_POPULATION + 1);
  for (let m = 0; m <= MAX_POPULATION; m += 1) {
    const value = terminalMultiplier(G, m);
    first[m] = value;
    second[m] = multiply(value, value);
    zero[m] = m === 0 ? ONE : ZERO;
  }

  for (let t = G - 1; t >= 1; t -= 1) {
    const continuationFirst = new Array(B).fill(ZERO);
    const continuationSecond = new Array(B).fill(ZERO);
    const continuationZero = new Array(B).fill(ZERO);
    for (let j = 1; j < B; j += 1) {
      continuationFirst[j] = kernelExpectation(j, first);
      continuationSecond[j] = kernelExpectation(j, second);
      continuationZero[j] = kernelExpectation(j, zero);
    }
    const nextFirst = new Array(MAX_POPULATION + 1);
    const nextSecond = new Array(MAX_POPULATION + 1);
    const nextZero = new Array(MAX_POPULATION + 1);
    for (let n = 0; n <= MAX_POPULATION; n += 1) {
      if (n === 0 || n >= B) {
        const value = terminalMultiplier(t, n);
        nextFirst[n] = value;
        nextSecond[n] = multiply(value, value);
        nextZero[n] = n === 0 ? ONE : ZERO;
        continue;
      }
      const k = policy(t, n);
      if (!Number.isSafeInteger(k) || k < 0 || k > n)
        fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${n})`);
      const banked = multiply(organismValue(t), rat(BigInt(k)));
      const rest = n - k;
      const futureFirst = rest === 0 ? ZERO : continuationFirst[rest];
      const futureSecond = rest === 0 ? ZERO : continuationSecond[rest];
      nextFirst[n] = add(banked, futureFirst);
      nextSecond[n] = add(
        add(multiply(banked, banked), multiply(multiply(rat(2n), banked), futureFirst)),
        futureSecond,
      );
      nextZero[n] = k > 0 ? ZERO : rest === 0 ? ONE : continuationZero[rest];
    }
    first = nextFirst;
    second = nextSecond;
    zero = nextZero;
  }

  const mean = kernelExpectation(SEED_COUNT, first);
  const secondMoment = kernelExpectation(SEED_COUNT, second);
  const zeroProbability = kernelExpectation(SEED_COUNT, zero);
  const variance = subtract(secondMoment, multiply(mean, mean));
  return { mean, secondMoment, variance, zeroProbability };
}

/**
 * Machine-checked strategy proof.
 *
 * Backward induction that takes the maximum over *every* legal action at
 * *every* reachable state, then asserts three things:
 *   1. the continuation value of j organisms at generation t is exactly c(t)*j
 *      (the martingale identity);
 *   2. every action at every state has exactly the same value;
 *   3. the optimal value function is exactly c(t)*n.
 * Together these say: no decision rule, adaptive or not, moves the RTP.
 */
export function proveStrategyInvariance() {
  let optimal = new Array(MAX_POPULATION + 1);
  for (let m = 0; m <= MAX_POPULATION; m += 1) optimal[m] = terminalMultiplier(G, m);

  let statesChecked = 0;
  let actionsChecked = 0;
  const failures = [];

  for (let t = G - 1; t >= 1; t -= 1) {
    const continuation = new Array(B).fill(ZERO);
    for (let j = 1; j < B; j += 1) {
      continuation[j] = kernelExpectation(j, optimal);
      // Claim 1: exact martingale identity.
      if (!equal(continuation[j], colonyMultiplier(t, j)))
        failures.push({ kind: 'CONTINUATION', generation: t, population: j });
    }
    const next = new Array(MAX_POPULATION + 1);
    for (let n = 0; n <= MAX_POPULATION; n += 1) {
      if (n === 0 || n >= B) {
        next[n] = terminalMultiplier(t, n);
        continue;
      }
      const expected = colonyMultiplier(t, n);
      let best = null;
      for (let k = 0; k <= n; k += 1) {
        const rest = n - k;
        const value = add(
          multiply(organismValue(t), rat(BigInt(k))),
          rest === 0 ? ZERO : continuation[rest],
        );
        actionsChecked += 1;
        // Claim 2: every action ties.
        if (!equal(value, expected))
          failures.push({ kind: 'ACTION', generation: t, population: n, harvest: k });
        if (best === null || compare(value, best) > 0) best = value;
      }
      // Claim 3: the optimal value function is the colony multiplier.
      if (best === null || !equal(best, expected))
        failures.push({ kind: 'OPTIMAL', generation: t, population: n });
      statesChecked += 1;
      next[n] = best;
    }
    optimal = next;
  }

  const optimalRtp = kernelExpectation(SEED_COUNT, optimal);
  return { ok: failures.length === 0, statesChecked, actionsChecked, failures, optimalRtp };
}

/**
 * The largest total a single round can ever credit, over every draw grid and
 * every policy. This is NOT the largest single settlement: because a harvest
 * converts organisms to credit at the current ladder value while the rest of
 * the colony keeps climbing, a player who trims the colony to stay under the
 * FULL BLOOM threshold can out-pay any single settlement. The declared
 * max-win multiple must sit above this number, otherwise the cap would clip a
 * reachable payout and the RTP would stop being policy-invariant.
 *
 * Exact deterministic dynamic program: the player maximizes over harvests, the
 * grid is maximized over reachable populations (a supremum, not an expectation).
 */
function maximumRoundPayoutUncached() {
  let value = new Array(MAX_POPULATION + 1);
  for (let m = 0; m <= MAX_POPULATION; m += 1) value[m] = terminalMultiplier(G, m);

  for (let t = G - 1; t >= 1; t -= 1) {
    const continuation = new Array(B).fill(ZERO);
    for (let j = 1; j < B; j += 1) {
      let best = ZERO;
      for (let m = 0; m <= 2 * j && m <= MAX_POPULATION; m += 1)
        if (compare(value[m], best) > 0) best = value[m];
      continuation[j] = best;
    }
    const next = new Array(MAX_POPULATION + 1);
    for (let n = 0; n <= MAX_POPULATION; n += 1) {
      if (n === 0 || n >= B) {
        next[n] = terminalMultiplier(t, n);
        continue;
      }
      let best = ZERO;
      for (let k = 0; k <= n; k += 1) {
        const rest = n - k;
        const candidate = add(
          multiply(organismValue(t), rat(BigInt(k))),
          rest === 0 ? ZERO : continuation[rest],
        );
        if (compare(candidate, best) > 0) best = candidate;
      }
      next[n] = best;
    }
    value = next;
  }

  let best = ZERO;
  for (let m = 0; m <= 2 * SEED_COUNT; m += 1) if (compare(value[m], best) > 0) best = value[m];
  return { multiplier: best };
}

/** Exact payout distribution of the base bet under the RUN policy, grouped by multiplier. */
export function runPayoutDistribution() {
  const { terminals } = enumerateWildLine();
  const buckets = new Map();
  for (const terminal of terminals) {
    const key = `${terminal.multiplier.numerator}/${terminal.multiplier.denominator}`;
    const existing = buckets.get(key);
    if (existing) existing.probability = add(existing.probability, terminal.probability);
    else buckets.set(key, { multiplier: terminal.multiplier, probability: terminal.probability });
  }
  return [...buckets.values()].sort((a, b) => compare(a.multiplier, b.multiplier));
}

/** Exact P(payout multiplier >= threshold) under the RUN policy. */
export function runTail(thresholds) {
  const distribution = runPayoutDistribution();
  return thresholds.map((threshold) => {
    let probability = ZERO;
    for (const entry of distribution)
      if (compare(entry.multiplier, threshold) >= 0)
        probability = add(probability, entry.probability);
    return { threshold, probability };
  });
}

/**
 * Side bets. Each resolves on the wild line, which is a function of the
 * committed draw grid alone: no player decision can move a side-bet result.
 * Every side bet is priced at exactly TARGET_RTP by construction:
 *   multiplier = TARGET_RTP / probability.
 */
function sideBetsUncached() {
  const distribution = populationDistribution(1);
  const firstLight = distribution
    .filter((entry) => entry.population >= 4)
    .reduce((total, entry) => add(total, entry.probability), ZERO);
  const darkVent = extinctionByGeneration(3);
  const swarmThreshold = 10;
  const swarm = reachProbability(swarmThreshold);

  const bets = [
    {
      id: 'FIRST_LIGHT',
      label: 'FIRST LIGHT',
      description: 'The wild line holds 4 or more organisms after generation 1.',
      probability: firstLight,
    },
    {
      id: 'DARK_VENT',
      label: 'DARK VENT',
      description: 'The wild line is extinct at or before generation 3.',
      probability: darkVent,
    },
    {
      id: 'SWARM',
      label: 'SWARM',
      description: `The wild line reaches ${swarmThreshold} or more organisms during the round.`,
      probability: swarm,
    },
  ];

  return bets.map((bet) => {
    const multiplier = divide(rat(19n, 20n), bet.probability);
    const capMultiple = SIDE_BET_MAX_WIN_MULTIPLES[bet.id];
    if (capMultiple === undefined)
      fail('INVALID_CONFIG', `Side bet ${bet.id} has no declared cap`, '$.sideBets');
    return { ...bet, multiplier, capMultiple, rtp: multiply(multiplier, bet.probability) };
  });
}

/**
 * The payable boundary: integer minor units, floor rounding, cap applied at
 * every credit. Mirrors `payable()` in the engine so the spec and the engine
 * cannot drift.
 *
 * `stakeUnits` is *this bet line's own stake* and `capMultiple` is that line's
 * own declared ceiling. Lines never share a cap basis: a side-bet credit is not
 * charged against the colony's ceiling and vice versa. See docs/MATH.md §11.
 */
export function payableUnits(
  stakeUnits,
  multiplier,
  alreadyCreditedUnits = 0n,
  capMultiple = COLONY_MAX_WIN_MULTIPLE,
) {
  if (typeof stakeUnits !== 'bigint' || stakeUnits <= 0n)
    fail('INVALID_ARGUMENT', 'Stake must be a positive BigInt of minor units');
  if (typeof alreadyCreditedUnits !== 'bigint' || alreadyCreditedUnits < 0n)
    fail('INVALID_ARGUMENT', 'Already-credited units must be a non-negative BigInt');
  if (typeof capMultiple !== 'bigint' || capMultiple <= 0n)
    fail('INVALID_ARGUMENT', 'Cap multiple must be a positive BigInt');
  const theoretical = multiply(rat(stakeUnits), multiplier);
  const uncapped = theoretical.numerator / theoretical.denominator;
  const ceiling = stakeUnits * capMultiple;
  const remaining = ceiling > alreadyCreditedUnits ? ceiling - alreadyCreditedUnits : 0n;
  const credited = uncapped > remaining ? remaining : uncapped;
  return { theoretical, credited, capped: uncapped > remaining };
}

/**
 * Proves every declared risk ceiling is a ceiling and not a clip.
 *
 * Each bet line is capped on its own stake, so the proof obligation is per line:
 *   - COLONY: the maximum *cumulative* total the colony can credit across a
 *     whole round (harvest-farming included) is strictly below its cap;
 *   - each side bet: its exact multiplier is strictly below its own cap.
 * Then the worst ticket the declared stake bounds allow is compared against the
 * operator admission limit, which is an open-time refusal and never a
 * settlement-time truncation. Returns the disclosure the documentation quotes.
 */
export function assertRiskPolicy() {
  const { multiplier } = maximumRoundPayout();
  if (compare(multiplier, rat(COLONY_MAX_WIN_MULTIPLE)) >= 0)
    fail(
      'INVALID_CONFIG',
      'Declared colony max-win multiple would truncate a reachable round total',
      '$.risk.colonyMaxWinMultiple',
    );
  const lines = [
    {
      line: 'COLONY',
      maximumCredit: multiplier,
      capMultiple: COLONY_MAX_WIN_MULTIPLE,
      basis: 'colony stake',
    },
  ];
  for (const bet of sideBets()) {
    if (compare(bet.multiplier, rat(bet.capMultiple)) >= 0)
      fail('INVALID_CONFIG', `Side bet ${bet.id} prices at or above its own cap`, '$.sideBets');
    lines.push({
      line: bet.id,
      maximumCredit: bet.multiplier,
      capMultiple: bet.capMultiple,
      basis: `${bet.id} stake`,
    });
  }
  const worstTicket = maximumTicketExposureUnits();
  if (worstTicket >= MAX_TICKET_EXPOSURE_UNITS)
    fail(
      'INVALID_CONFIG',
      'The stake bounds admit a ticket at or above the operator exposure limit',
      '$.risk.maxTicketExposureUnits',
    );
  return {
    ok: true,
    lines,
    ticket: {
      worstCaseExposureUnits: worstTicket,
      admissionLimitUnits: MAX_TICKET_EXPOSURE_UNITS,
      binds: false,
    },
  };
}

/** Exact expected total across every terminal of the wild line; must equal TARGET_RTP. */
export function runRtp() {
  const { terminals } = enumerateWildLine();
  let total = ZERO;
  for (const terminal of terminals)
    total = add(total, multiply(terminal.probability, terminal.multiplier));
  return total;
}

/** Sum of every terminal probability; must be exactly 1. */
export function runProbabilityMass() {
  const { terminals } = enumerateWildLine();
  let total = ZERO;
  for (const terminal of terminals) total = add(total, terminal.probability);
  return total;
}

/** Exact P(colony still alive immediately after generation t), t = 1..MAX_GENERATIONS. */
export function survivalCurve() {
  const { generations } = enumerateWildLine();
  return generations.map((row) => ({
    generation: row.generation,
    alive: row.populations
      .filter((entry) => entry.population > 0)
      .reduce((total, entry) => add(total, entry.probability), ZERO),
  }));
}

/** Exact probability mass of each terminal category under the RUN policy. */
export function terminalCategories() {
  const { terminals } = enumerateWildLine();
  const totals = { EXTINCT: ZERO, BLOOM: ZERO, FINAL: ZERO };
  for (const terminal of terminals)
    totals[terminal.reason] = add(totals[terminal.reason], terminal.probability);
  return totals;
}

/** Exact expected number of resolved generations in a RUN round (a pacing number, not a money number). */
export function expectedGenerations() {
  const { terminals } = enumerateWildLine();
  let total = ZERO;
  for (const terminal of terminals)
    total = add(total, multiply(terminal.probability, rat(BigInt(terminal.generation))));
  return total;
}

/**
 * Exact three-way split of a policy's round total: nothing, something but not
 * more than the stake, and an actual profit.
 *
 * A "hit rate" of `1 - P(total = 0)` counts a 0.396x return as a hit. That is
 * true and misleading at the same time, so this function publishes the honest
 * decomposition and the paytable prints the profit rate first.
 *
 * Method: forward enumeration over `(population, banked)` with the whole
 * "already above the threshold" region collapsed into one absorbing mass. The
 * collapse is what keeps the state space finite and exact: future credits are
 * never negative, so once the banked amount passes the threshold the outcome is
 * decided. Every harvest adds at least `c(1)` of a stake, so only a handful of
 * banked values can remain at or below one stake at all.
 */
export function policyOutcomeSplit(policy, threshold = ONE) {
  assertPolicy(policy);
  let live = new Map([
    [`${SEED_COUNT}|0/1`, { population: SEED_COUNT, banked: ZERO, probability: ONE }],
  ]);
  let zero = ZERO;
  let subStake = ZERO;
  let profit = ZERO;
  let peakStates = 1;

  const settle = (total, probability) => {
    if (total.numerator === 0n) zero = add(zero, probability);
    else if (compare(total, threshold) <= 0) subStake = add(subStake, probability);
    else profit = add(profit, probability);
  };

  for (let t = 1; t <= G; t += 1) {
    const next = new Map();
    for (const state of live.values()) {
      const row = KERNEL[state.population];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        const probability = multiply(
          state.probability,
          rat(row[m], POWERS[state.population]),
        );
        if (m === 0) {
          settle(state.banked, probability);
          continue;
        }
        if (m >= B || t === G) {
          settle(add(state.banked, colonyMultiplier(t, m)), probability);
          continue;
        }
        const k = policy(t, m);
        if (!Number.isSafeInteger(k) || k < 0 || k > m)
          fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${m})`);
        const banked = add(state.banked, multiply(organismValue(t), rat(BigInt(k))));
        const rest = m - k;
        if (rest === 0) {
          settle(banked, probability);
          continue;
        }
        if (compare(banked, threshold) > 0) {
          // Absorbing: the round already pays more than the threshold.
          profit = add(profit, probability);
          continue;
        }
        const key = `${rest}|${toFraction(banked)}`;
        const existing = next.get(key);
        if (existing) existing.probability = add(existing.probability, probability);
        else next.set(key, { population: rest, banked, probability });
      }
    }
    live = next;
    if (live.size > peakStates) peakStates = live.size;
  }

  if (live.size !== 0) fail('INVALID_MODEL', 'Rounds survived past the last generation');
  const mass = add(add(zero, subStake), profit);
  if (!equal(mass, ONE)) fail('INVALID_MODEL', 'Outcome split does not sum to one');
  return { zero, subStake, profit, hitRate: subtract(ONE, zero), peakStates };
}

/**
 * How a round *ends*, per policy, as exact probabilities.
 *
 * The four terminals partition the outcome space: `EXTINCT`, `BLOOM` (the
 * population reached the FULL BLOOM threshold and force-settled), `FINAL`
 * (survived to the last generation) and `BANKED` (the player took the whole
 * colony). Forward enumeration over `(generation, population)`; the policy is a
 * function of that pair alone, so the chain is Markov and the walk is exact.
 *
 * This exists because FULL BLOOM is a *terminal of the player's own colony*, not
 * a property of the grid, and harvesting changes how often the player reaches
 * it — to exactly zero for any policy that halves the colony every generation.
 * The published bloom frequency therefore belongs to a policy, and this is the
 * function that says which.
 */
export function policyTerminalProfile(policy) {
  assertPolicy(policy);
  let live = new Array(B).fill(ZERO);
  live[SEED_COUNT] = ONE;
  const totals = { EXTINCT: ZERO, BLOOM: ZERO, FINAL: ZERO, BANKED: ZERO };

  for (let t = 1; t <= G; t += 1) {
    const next = new Array(B).fill(ZERO);
    for (let n = 1; n < B; n += 1) {
      const mass = live[n];
      if (mass.numerator === 0n) continue;
      const row = KERNEL[n];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        const probability = multiply(mass, rat(row[m], POWERS[n]));
        if (m === 0) {
          totals.EXTINCT = add(totals.EXTINCT, probability);
          continue;
        }
        if (m >= B) {
          totals.BLOOM = add(totals.BLOOM, probability);
          continue;
        }
        if (t === G) {
          totals.FINAL = add(totals.FINAL, probability);
          continue;
        }
        const k = policy(t, m);
        if (!Number.isSafeInteger(k) || k < 0 || k > m)
          fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${m})`);
        const rest = m - k;
        if (rest === 0) {
          totals.BANKED = add(totals.BANKED, probability);
          continue;
        }
        next[rest] = add(next[rest], probability);
      }
    }
    live = next;
  }

  for (let n = 1; n < B; n += 1)
    if (live[n].numerator !== 0n) fail('INVALID_MODEL', 'Rounds survived past the last generation');
  let mass = ZERO;
  for (const value of Object.values(totals)) mass = add(mass, value);
  if (!equal(mass, ONE)) fail('INVALID_MODEL', 'Terminal profile does not sum to one');
  return totals;
}

/**
 * Exact probability that a round under `policy` ever *shows* a colony worth at
 * least `threshold` stake multiples.
 *
 * A frame is displayed at every resolution, so the quantity is the peak of
 * `c(t) * m` over the resolutions the round actually reaches. Crossing is
 * absorbing, which keeps the walk over `(generation, population)` exact and
 * finite. docs/DESIGN.md §7.2 keys the environment reveal to a colony *value*
 * rather than to a population, so this is the function that prices it.
 */
export function valuePeakReachProbability(policy, threshold) {
  assertPolicy(policy);
  let live = new Array(B).fill(ZERO);
  live[SEED_COUNT] = ONE;
  let reached = ZERO;

  for (let t = 1; t <= G; t += 1) {
    const next = new Array(B).fill(ZERO);
    for (let n = 1; n < B; n += 1) {
      const mass = live[n];
      if (mass.numerator === 0n) continue;
      const row = KERNEL[n];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        const probability = multiply(mass, rat(row[m], POWERS[n]));
        if (m === 0) continue;
        if (compare(colonyMultiplier(t, m), threshold) >= 0) {
          reached = add(reached, probability);
          continue;
        }
        if (m >= B || t === G) continue;
        const k = policy(t, m);
        if (!Number.isSafeInteger(k) || k < 0 || k > m)
          fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${m})`);
        const rest = m - k;
        if (rest === 0) continue;
        next[rest] = add(next[rest], probability);
      }
    }
    live = next;
  }
  return reached;
}

/**
 * The largest number of COLONY credit events one round can produce, over every
 * draw grid and every policy — the exact quantity docs/MATH.md §13 bounds the
 * floor-rounding loss with.
 *
 * Each credit event floors an exact rational to integer minor units and so
 * costs strictly less than one unit, which makes "how many can there be" the
 * whole of the payable-boundary claim. It used to be asserted by hand as
 * `MAX_GENERATIONS`; it is now a deterministic dynamic program, because a
 * hand-asserted bound on a money path is exactly the kind of number that is
 * wrong without anything noticing.
 *
 * `commitsPerStage = 1` is the shipped protocol (docs/ENGINE.md §5.3): a stage
 * accepts one harvest commitment, so a stage produces at most one credit.
 * `Infinity` prices the rejected alternative, in which a stage accepts an
 * unbounded sequence of harvests and the player can farm floor crumbs by
 * shedding organisms one at a time.
 */
function maximumCreditEventsUncached(commitsPerStage = 1) {
  const unlimited = commitsPerStage === Infinity;
  if (!unlimited && (!Number.isSafeInteger(commitsPerStage) || commitsPerStage < 1))
    fail('INVALID_ARGUMENT', 'commitsPerStage must be a positive integer or Infinity');

  // best[r] = maximum credit events from generation t onward, given r organisms
  // entering generation t. Folded backwards from the last generation.
  let best = new Array(B).fill(0);
  // Generation G resolves and force-settles: one credit event whenever a single
  // organism survives, and a settlement of an extinct colony credits nothing.
  for (let r = 1; r < B; r += 1) best[r] = 1;

  for (let t = G - 1; t >= 1; t -= 1) {
    const next = new Array(B).fill(0);
    for (let r = 1; r < B; r += 1) {
      let top = 0;
      for (let m = 0; m <= 2 * r; m += 1) {
        if (m === 0) continue;
        // FULL BLOOM force-settles: exactly one credit event, no decision.
        if (m >= B) {
          if (top < 1) top = 1;
          continue;
        }
        for (let k = 0; k <= m; k += 1) {
          // Under the shipped protocol a stage commits once, so a harvest of k
          // is one event. Under the rejected alternative the same k can be taken
          // one organism at a time, which is k events.
          const events = k === 0 ? 0 : unlimited ? k : 1;
          const rest = m - k;
          const total = events + (rest === 0 ? 0 : best[rest]);
          if (total > top) top = total;
        }
      }
      next[r] = top;
    }
    best = next;
  }
  return best[SEED_COUNT];
}

/**
 * The joint offspring kernel of the player's colony and the wild line it sits
 * inside: `occupied` slots carry the player's whole colony and `spare` slots
 * carry the rest of the wild line, so one row produces `a` children for the
 * player and `a + b` for the wild line. Memoized because the ticket walk hits
 * the same (occupied, spare) pair thousands of times.
 */
const jointKernelRow = memoize((occupied, spare) => {
  const playerRow = KERNEL[occupied];
  const spareRow = KERNEL[spare];
  // Weights are integers over DRAW_MODULUS^(occupied + spare); the walk scales
  // every row up to the same power, so one denominator serves a generation.
  const scale = POWERS[B - 1 - occupied - spare];
  const entries = [];
  for (let a = 0; a < playerRow.length; a += 1) {
    if (playerRow[a] === 0n) continue;
    for (let b = 0; b < spareRow.length; b += 1) {
      if (spareRow[b] === 0n) continue;
      entries.push({ player: a, wild: a + b, weight: playerRow[a] * spareRow[b] * scale });
    }
  }
  return entries;
});

/**
 * The exact joint law of a two-line ticket: one COLONY bet and one side bet, at
 * equal stakes.
 *
 * docs/DESIGN.md §9.3 makes the profit rate `P(return > stake)` the binding
 * "how often do I win" figure, and §9.4 defends pairing DARK VENT with the base
 * bet on an RTP argument. RTP is the wrong statistic for that claim and it was
 * the only one published: a ticket's profit rate is not the average of its
 * lines' profit rates, because the wild line and the player's colony are drawn
 * from the *same* rows — the player's organisms occupy a prefix of the wild
 * line's slots (docs/MATH.md §7.3), so the two lines are strongly dependent.
 *
 * The joint kernel is exactly that containment: with `n` of the wild line's `w`
 * slots occupied, the first `n` slots produce `a` children — which is the
 * player's whole next population — and the remaining `w - n` produce `b`, so the
 * wild line's next population is `a + b`. Both factors are the offspring kernel,
 * so the walk is exact.
 *
 * Every side-bet multiplier exceeds the two-line ticket stake, so a won side bet
 * is a profitable ticket whatever the colony did; the function asserts that
 * rather than assuming it, and refuses to answer if a future price broke it.
 *
 * Ticket RTP needs no enumeration: expectation is linear and every line returns
 * exactly `19/20` of its own stake, so any ticket returns exactly `19/20` of the
 * total staked. What is *not* linear, and is what this function computes, is
 * `P(the ticket returns more than the ticket stake)`.
 */
export function ticketProfile(policy, sideBetId) {
  assertPolicy(policy);
  const bet = sideBets().find((entry) => entry.id === sideBetId);
  if (bet === undefined) fail('INVALID_ARGUMENT', `No such side bet: ${sideBetId}`);
  const LINES = 2;
  const threshold = rat(BigInt(LINES));
  if (compare(bet.multiplier, threshold) <= 0)
    fail(
      'INVALID_MODEL',
      `Side bet ${sideBetId} pays less than a ${LINES}-line ticket stake, so a win is not a profit`,
    );

  /** Where the side bet stands once generation `t` of the wild line has resolved. */
  const decideSide = (generation, wildPopulation, wildTerminated) => {
    if (sideBetId === 'FIRST_LIGHT')
      return generation === 1 ? (wildPopulation >= 4 ? 'WON' : 'LOST') : 'PENDING';
    if (sideBetId === 'DARK_VENT') {
      if (wildPopulation === 0 && generation <= 3) return 'WON';
      return generation >= 3 || wildTerminated ? 'LOST' : 'PENDING';
    }
    if (sideBetId === 'SWARM') {
      if (wildPopulation >= 10) return 'WON';
      return wildTerminated ? 'LOST' : 'PENDING';
    }
    return fail('INVALID_ARGUMENT', `No predicate for side bet ${sideBetId}`);
  };

  let nothing = ZERO;
  let below = ZERO;
  let profit = ZERO;
  let peakStates = 1;

  // Probabilities are carried as BigInt numerators over one common denominator
  // per generation. Every transition consumes at most `B - 1` slots, so scaling
  // each kernel row up to `DRAW_MODULUS^(B-1)` gives the whole generation one
  // denominator and turns state merging into integer addition. Exactly the
  // accumulator `enumerateWildLine()` uses, for exactly the same reason: without
  // it every merge is a gcd over a denominator hundreds of digits long.
  const SLOT_POWER = POWERS[B - 1];
  let denominator = 1n;
  let live = new Map([
    ['B|3|3|0/1', { kind: 'BOTH', n: SEED_COUNT, w: SEED_COUNT, banked: ZERO, numerator: 1n }],
  ]);

  for (let t = 1; t <= G; t += 1) {
    const nextDenominator = denominator * SLOT_POWER;
    const next = new Map();
    let nothingWeight = 0n;
    let belowWeight = 0n;
    let profitWeight = 0n;

    /** Classify a finished ticket whose side bet lost: the colony total is all of it. */
    const settleLost = (total, weight) => {
      if (total.numerator === 0n) nothingWeight += weight;
      else if (compare(total, threshold) <= 0) belowWeight += weight;
      else profitWeight += weight;
    };
    const push = (state) => {
      const key =
        state.kind === 'BOTH'
          ? `B|${state.n}|${state.w}|${toFraction(state.banked)}`
          : state.kind === 'PLAYER'
            ? `P|${state.n}|${toFraction(state.banked)}`
            : `W|${state.w}|${state.colony}`;
      const existing = next.get(key);
      if (existing) existing.numerator += state.numerator;
      else next.set(key, state);
    };

    for (const state of live.values()) {
      if (state.kind === 'WILD') {
        // The player's line is finished and the side bet is still open. The wild
        // line is autonomous — it consumes slots 1 .. w of each row — so it walks
        // on alone.
        const row = KERNEL[state.w];
        const scale = POWERS[B - 1 - state.w];
        for (let m = 0; m < row.length; m += 1) {
          if (row[m] === 0n) continue;
          const weight = state.numerator * row[m] * scale;
          const terminated = m === 0 || m >= B || t === G;
          const side = decideSide(t, m, terminated);
          if (side === 'WON') profitWeight += weight;
          else if (side === 'LOST') {
            if (state.colony === 'ZERO') nothingWeight += weight;
            else belowWeight += weight;
          } else push({ kind: 'WILD', w: m, colony: state.colony, numerator: weight });
        }
        continue;
      }

      if (state.kind === 'PLAYER') {
        // The side bet has lost, so the ticket is decided by the colony alone.
        const row = KERNEL[state.n];
        const scale = POWERS[B - 1 - state.n];
        for (let m = 0; m < row.length; m += 1) {
          if (row[m] === 0n) continue;
          const weight = state.numerator * row[m] * scale;
          if (m === 0) {
            settleLost(state.banked, weight);
            continue;
          }
          if (m >= B || t === G) {
            settleLost(add(state.banked, colonyMultiplier(t, m)), weight);
            continue;
          }
          const k = policy(t, m);
          if (!Number.isSafeInteger(k) || k < 0 || k > m)
            fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${m})`);
          const banked = add(state.banked, multiply(organismValue(t), rat(BigInt(k))));
          const rest = m - k;
          if (rest === 0) {
            settleLost(banked, weight);
            continue;
          }
          if (compare(banked, threshold) > 0) {
            profitWeight += weight;
            continue;
          }
          push({ kind: 'PLAYER', n: rest, banked, numerator: weight });
        }
        continue;
      }

      // BOTH lines live. The joint kernel is the containment: the player's
      // organisms are the first `n` of the wild line's `w` slots.
      for (const entry of jointKernelRow(state.n, state.w - state.n)) {
        const weight = state.numerator * entry.weight;
        const wildPopulation = entry.wild;
        const wildTerminated = wildPopulation === 0 || wildPopulation >= B || t === G;
        const side = decideSide(t, wildPopulation, wildTerminated);
        if (side === 'WON') {
          profitWeight += weight;
          continue;
        }
        if (side === 'PENDING' && wildTerminated)
          fail('INVALID_MODEL', 'The wild line ended with its side bet undecided');

        // Now the player's own line, from the same draws.
        const resolved = entry.player;
        let banked = state.banked;
        let alive = false;
        let rest = 0;
        if (resolved === 0) {
          // The player's colony is extinct and keeps whatever it banked. The
          // wild line can still be alive: containment runs the other way.
        } else if (resolved >= B || t === G) {
          banked = add(banked, colonyMultiplier(t, resolved));
        } else {
          const k = policy(t, resolved);
          if (!Number.isSafeInteger(k) || k < 0 || k > resolved)
            fail('INVALID_POLICY', `Policy returned an out-of-range harvest at (${t}, ${resolved})`);
          banked = add(banked, multiply(organismValue(t), rat(BigInt(k))));
          rest = resolved - k;
          alive = rest > 0;
        }

        if (compare(banked, threshold) > 0) {
          // The colony alone already beats the whole ticket stake, and future
          // credits are never negative.
          profitWeight += weight;
          continue;
        }
        if (side === 'LOST') {
          if (alive) push({ kind: 'PLAYER', n: rest, banked, numerator: weight });
          else settleLost(banked, weight);
          continue;
        }
        if (alive) {
          push({ kind: 'BOTH', n: rest, w: wildPopulation, banked, numerator: weight });
          continue;
        }
        push({
          kind: 'WILD',
          w: wildPopulation,
          colony: banked.numerator === 0n ? 'ZERO' : 'SUB',
          numerator: weight,
        });
      }
    }

    if (nothingWeight !== 0n) nothing = add(nothing, rat(nothingWeight, nextDenominator));
    if (belowWeight !== 0n) below = add(below, rat(belowWeight, nextDenominator));
    if (profitWeight !== 0n) profit = add(profit, rat(profitWeight, nextDenominator));

    // Keep the common denominator as small as the exact value allows.
    let divisor = nextDenominator;
    for (const state of next.values()) divisor = gcd(divisor, state.numerator);
    if (divisor > 1n) {
      for (const state of next.values()) state.numerator /= divisor;
      denominator = nextDenominator / divisor;
    } else {
      denominator = nextDenominator;
    }

    live = next;
    if (live.size > peakStates) peakStates = live.size;
  }

  if (live.size !== 0) fail('INVALID_MODEL', 'A ticket survived past the last generation');
  const mass = add(add(nothing, below), profit);
  if (!equal(mass, ONE)) fail('INVALID_MODEL', 'Ticket outcome split does not sum to one');
  return {
    lines: LINES,
    sideBetId,
    nothing,
    belowStake: below,
    profit,
    sideProbability: bet.probability,
    peakStates,
  };
}

/**
 * The exact extremes of round variance over *every* adapted decision policy.
 *
 * The published volatility range must be a proven interval, not the spread of a
 * handful of sampled policies. Because the expected continuation value of `j`
 * organisms is exactly `c(t) * j` whatever the player does later (the invariance
 * theorem), the second moment of a round decomposes as
 *
 *   E[(b + a + R)^2] = b^2 + 2b*(a + E[R]) + E[(a + R)^2]
 *
 * and `a + E[R] = c(t) * n` is the same for every harvest `k`. The bank `b`
 * therefore drops out of the comparison between actions, the optimal action
 * depends only on `(t, n)`, and this backward induction over `(t, n)` is the
 * exact extremum over all history-dependent policies. Randomized policies are
 * mixtures and cannot exceed a deterministic extreme.
 */
export function extremalRoundVariance(mode = 'max') {
  if (mode !== 'max' && mode !== 'min') fail('INVALID_ARGUMENT', 'mode must be "max" or "min"');
  const direction = mode === 'max' ? 1 : -1;
  let second = new Array(MAX_POPULATION + 1);
  for (let m = 0; m <= MAX_POPULATION; m += 1) {
    const value = terminalMultiplier(G, m);
    second[m] = multiply(value, value);
  }
  const harvests = [];

  for (let t = G - 1; t >= 1; t -= 1) {
    const continuationSecond = new Array(B).fill(ZERO);
    for (let j = 1; j < B; j += 1) continuationSecond[j] = kernelExpectation(j, second);
    const next = new Array(MAX_POPULATION + 1);
    for (let n = 0; n <= MAX_POPULATION; n += 1) {
      if (n === 0 || n >= B) {
        const value = terminalMultiplier(t, n);
        next[n] = multiply(value, value);
        continue;
      }
      let best = null;
      let bestHarvest = 0;
      for (let k = 0; k <= n; k += 1) {
        const banked = multiply(organismValue(t), rat(BigInt(k)));
        const rest = n - k;
        const futureFirst = rest === 0 ? ZERO : colonyMultiplier(t, rest);
        const futureSecond = rest === 0 ? ZERO : continuationSecond[rest];
        const value = add(
          add(multiply(banked, banked), multiply(multiply(rat(2n), banked), futureFirst)),
          futureSecond,
        );
        if (best === null || compare(value, best) * direction > 0) {
          best = value;
          bestHarvest = k;
        }
      }
      if (bestHarvest > 0) harvests.push({ generation: t, population: n, harvest: bestHarvest });
      next[n] = best;
    }
    second = next;
  }

  const secondMoment = kernelExpectation(SEED_COUNT, second);
  const variance = subtract(secondMoment, multiply(TARGET_RTP, TARGET_RTP));
  return { mode, secondMoment, variance, harvests };
}

/**
 * The exact conditional payout distribution of FULL BLOOM under RUN.
 *
 * FULL BLOOM is the game's designated celebration, so how much it actually pays
 * is a design input, not trivia: the smallest bloom pays less than the smallest
 * possible generation-18 settlement, and most blooms are ordinary wins.
 */
export function bloomPayoutProfile() {
  const { terminals } = enumerateWildLine();
  const blooms = terminals
    .filter((entry) => entry.reason === 'BLOOM')
    .sort((a, b) => compare(a.multiplier, b.multiplier));
  if (blooms.length === 0) fail('INVALID_MODEL', 'No bloom terminals enumerated');
  let mass = ZERO;
  for (const bloom of blooms) mass = add(mass, bloom.probability);

  const shareBelow = (bound) => {
    let total = ZERO;
    for (const bloom of blooms)
      if (compare(bloom.multiplier, bound) < 0) total = add(total, bloom.probability);
    return divide(total, mass);
  };

  let cumulative = ZERO;
  let median = null;
  for (const bloom of blooms) {
    cumulative = add(cumulative, divide(bloom.probability, mass));
    if (median === null && compare(cumulative, rat(1n, 2n)) >= 0) median = bloom.multiplier;
  }

  const smallest = blooms[0];
  const largest = blooms[blooms.length - 1];
  const smallestFinal = colonyMultiplier(G, 1);
  return {
    mass,
    outcomeCount: blooms.length,
    smallest: smallest.multiplier,
    smallestGeneration: smallest.generation,
    smallestPopulation: smallest.population,
    largest: largest.multiplier,
    median,
    shareBelow20x: shareBelow(rat(20n)),
    shareBelow50x: shareBelow(rat(50n)),
    shareBelow100x: shareBelow(rat(100n)),
    smallestFinal,
    shareBelowSmallestFinal: shareBelow(smallestFinal),
  };
}

function factorial(value) {
  let result = 1n;
  for (let index = 2n; index <= value; index += 1n) result *= index;
  return result;
}

/**
 * Exact joint frequency of "the colony lost value this generation" and "at least
 * one organism split this generation".
 *
 * Colony value is `n * c(t)` and `c(t)` rises by exactly 25% per generation, so
 * a generation loses value exactly when `5m < 4n`, whatever the ladder position.
 * A generation can therefore contain several splits and still be worth less than
 * the one before it. This table is the evidence behind the feedback rule in
 * docs/DESIGN.md §6.5: celebration is keyed to the signed value change, never to
 * the event type.
 */
export function feedbackHonesty(populations = [3, 5, 8, 12, 15]) {
  const weights = offspringWeights();
  return populations.map((n) => {
    if (!Number.isSafeInteger(n) || n < 1 || n >= B)
      fail('INVALID_ARGUMENT', 'population out of range');
    const denominator = POWERS[n];
    const numeratorOf = BigInt(n);
    let falls = 0n;
    let flat = 0n;
    let rises = 0n;
    let fallsWithSplit = 0n;
    let fallsWithTwoSplits = 0n;
    let anySplit = 0n;
    for (let splits = 0; splits <= n; splits += 1)
      for (let holds = 0; holds + splits <= n; holds += 1) {
        const deaths = n - holds - splits;
        const weight =
          (factorial(numeratorOf) /
            (factorial(BigInt(deaths)) * factorial(BigInt(holds)) * factorial(BigInt(splits)))) *
          weights[0] ** BigInt(deaths) *
          weights[1] ** BigInt(holds) *
          weights[2] ** BigInt(splits);
        const children = holds + 2 * splits;
        const direction = 5 * children - 4 * n;
        if (direction < 0) {
          falls += weight;
          if (splits >= 1) fallsWithSplit += weight;
          if (splits >= 2) fallsWithTwoSplits += weight;
        } else if (direction === 0) flat += weight;
        else rises += weight;
        if (splits >= 1) anySplit += weight;
      }
    if (falls + flat + rises !== denominator)
      fail('INVALID_MODEL', 'Feedback enumeration lost mass');
    const fallsRational = rat(falls, denominator);
    return {
      population: n,
      falls: fallsRational,
      flat: rat(flat, denominator),
      rises: rat(rises, denominator),
      anySplit: rat(anySplit, denominator),
      fallsWithSplit: rat(fallsWithSplit, denominator),
      fallsWithTwoSplits: rat(fallsWithTwoSplits, denominator),
      splitGivenFalls: falls === 0n ? ZERO : divide(rat(fallsWithSplit, denominator), fallsRational),
    };
  });
}

/**
 * The break-even colony at every generation: the smallest population whose exact
 * value is strictly above one stake, and the smallest whose value reaches it.
 *
 * Published because the value process is not monotone: a player can be below
 * their stake at a decision point, which is the state docs/DESIGN.md §9.2 writes
 * the copy rules for.
 */
export function breakEvenLadder() {
  const rows = [];
  for (let t = 1; t <= G; t += 1) {
    const value = organismValue(t);
    let atLeast = null;
    let above = null;
    for (let n = 1; n <= MAX_POPULATION; n += 1) {
      const multiplier = multiply(value, rat(BigInt(n)));
      if (atLeast === null && compare(multiplier, ONE) >= 0) atLeast = n;
      if (above === null && compare(multiplier, ONE) > 0) above = n;
      if (atLeast !== null && above !== null) break;
    }
    rows.push({ generation: t, organismValue: value, atLeast, above });
  }
  return rows;
}

/**
 * Exact probability that the mandatory first generation leaves the player below
 * their stake, split by whether the colony is already dead. No decision exists
 * before this point, so this is a state the player is placed in, never one they
 * choose.
 */
export function underwaterAfterFirstGeneration() {
  const distribution = populationDistribution(1);
  let extinct = ZERO;
  let aliveBelow = ZERO;
  let aboveWater = ZERO;
  for (const entry of distribution) {
    const multiplier = colonyMultiplier(1, entry.population);
    if (entry.population === 0) extinct = add(extinct, entry.probability);
    else if (compare(multiplier, ONE) <= 0) aliveBelow = add(aliveBelow, entry.probability);
    else aboveWater = add(aboveWater, entry.probability);
  }
  return { extinct, aliveBelow, underwater: add(extinct, aliveBelow), aboveWater };
}

/** Exact probability that the peak population lands inside `[low, high)`. */
export function peakBand(low, high) {
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low >= high)
    fail('INVALID_ARGUMENT', 'band bounds out of range');
  return subtract(reachProbability(low), reachProbability(high));
}

/**
 * Exact occupancy of the wild line: `alive[t][n]` is the probability that the
 * colony holds exactly `n` organisms (1 <= n < BLOOM_THRESHOLD) immediately
 * after generation `t` has resolved, with `t = 0` the seeded state. Terminal
 * mass (extinction, FULL BLOOM) is absorbed and never re-enters.
 *
 * Exported because the presentation layer prices its feedback bands against the
 * states a player is actually in, not against a uniform sweep of the state space.
 */
function aliveOccupancyUncached() {
  const rows = [];
  let alive = new Array(B).fill(ZERO);
  alive[SEED_COUNT] = ONE;
  rows.push(alive.slice());
  for (let t = 1; t <= G; t += 1) {
    const next = new Array(MAX_POPULATION + 1).fill(ZERO);
    for (let n = 1; n < B; n += 1) {
      if (alive[n].numerator === 0n) continue;
      const row = KERNEL[n];
      for (let m = 0; m < row.length; m += 1) {
        if (row[m] === 0n) continue;
        next[m] = add(next[m], multiply(alive[n], rat(row[m], POWERS[n])));
      }
    }
    const survivors = new Array(B).fill(ZERO);
    for (let m = 1; m < B; m += 1) survivors[m] = next[m];
    rows.push(survivors.slice());
    alive = survivors;
  }
  return rows;
}

/**
 * The largest total the COLONY line can credit in one round *given that the
 * population never reaches `peakLimit` organisms*.
 *
 * Same deterministic dynamic program as `maximumRoundPayout()` — the player
 * maximizes over harvests and the grid is maximized over reachable populations —
 * with every state at or above `peakLimit` deleted from the reachable set. It
 * exists to turn "how likely is a shared ticket ceiling to bind" into an exactly
 * computable bound (see `sharedCapBinding()`), rather than a guess.
 */
function maximumRoundPayoutBelowPeakUncached(peakLimit) {
  if (!Number.isSafeInteger(peakLimit) || peakLimit < 1 || peakLimit > MAX_POPULATION + 1)
    fail('INVALID_ARGUMENT', 'peakLimit out of range');
  let value = new Array(MAX_POPULATION + 1);
  for (let m = 0; m <= MAX_POPULATION; m += 1)
    value[m] = m >= peakLimit ? null : terminalMultiplier(G, m);

  for (let t = G - 1; t >= 1; t -= 1) {
    const continuation = new Array(B).fill(ZERO);
    for (let j = 1; j < B; j += 1) {
      let best = ZERO;
      for (let m = 0; m <= 2 * j && m <= MAX_POPULATION; m += 1) {
        if (m >= peakLimit || value[m] === null) continue;
        if (compare(value[m], best) > 0) best = value[m];
      }
      continuation[j] = best;
    }
    const next = new Array(MAX_POPULATION + 1);
    for (let n = 0; n <= MAX_POPULATION; n += 1) {
      if (n >= peakLimit) {
        next[n] = null;
        continue;
      }
      if (n === 0 || n >= B) {
        next[n] = terminalMultiplier(t, n);
        continue;
      }
      let best = ZERO;
      for (let k = 0; k <= n; k += 1) {
        const rest = n - k;
        const candidate = add(
          multiply(organismValue(t), rat(BigInt(k))),
          rest === 0 ? ZERO : continuation[rest],
        );
        if (compare(candidate, best) > 0) best = candidate;
      }
      next[n] = best;
    }
    value = next;
  }

  let best = ZERO;
  for (let m = 0; m <= 2 * SEED_COUNT && m <= MAX_POPULATION; m += 1)
    if (m < peakLimit && value[m] !== null && compare(value[m], best) > 0) best = value[m];
  return best;
}

/**
 * What would happen if the ticket had a single shared ceiling instead of one cap
 * basis per line — and how likely it would be to bite.
 *
 * On equal stakes the four lines can jointly owe `combined`; against a shared
 * ceiling equal to the COLONY cap the COLONY line alone would have to credit
 * more than `colonyThreshold` for the ceiling to bind. Two exact statements
 * bound that event:
 *
 *   - under RUN it is impossible, because RUN's largest total is the largest
 *     single settlement and that is below the threshold;
 *   - over *every* adapted policy it requires the colony to reach
 *     `minimumPeak` organisms, because the maximum total attainable without ever
 *     reaching that size is below the threshold. The player's population never
 *     exceeds the wild line's (the colony occupies a prefix of the wild line's
 *     slots), so `reachProbability(minimumPeak)` is an upper bound on it.
 *
 * docs/MATH.md §12.1 publishes both. The previous text attached the SWARM side
 * bet's `1 in 261.89` frequency to this event, which was the frequency of a
 * different scenario entirely.
 */
export function sharedCapBinding() {
  const colonyMaximum = maximumRoundPayout().multiplier;
  let sideTotal = ZERO;
  for (const bet of sideBets()) sideTotal = add(sideTotal, bet.multiplier);
  const combined = add(colonyMaximum, sideTotal);
  const ceiling = rat(COLONY_MAX_WIN_MULTIPLE);
  const shortfall = subtract(combined, ceiling);
  const colonyThreshold = subtract(ceiling, sideTotal);

  // RUN never harvests, so its round total *is* its single settlement, and the
  // largest settlement in the enumerated terminal space is the largest total it
  // can produce.
  let runMaximum = ZERO;
  for (const entry of runPayoutDistribution())
    if (compare(entry.multiplier, runMaximum) > 0) runMaximum = entry.multiplier;
  const runCanBind = compare(runMaximum, colonyThreshold) > 0;

  // The tightest population bound: the *largest* limit whose reachable maximum
  // still sits below the threshold. `maximumRoundPayoutBelowPeak(L)` forbids
  // every population at or above `L`, so "peak < L cannot bind" is the same
  // statement as "binding requires peak >= L", and a larger `L` is a rarer event
  // and therefore a stronger bound.
  let minimumPeak = null;
  let attainableBelowPeak = null;
  for (let limit = B; limit >= 1; limit -= 1) {
    const attainable = maximumRoundPayoutBelowPeak(limit);
    if (compare(attainable, colonyThreshold) <= 0) {
      minimumPeak = limit;
      attainableBelowPeak = attainable;
      break;
    }
  }
  if (minimumPeak === null)
    fail('INVALID_MODEL', 'No population bound rules out a shared-ceiling bind');

  return {
    colonyMaximum,
    sideTotal,
    combined,
    ceiling,
    shortfall,
    colonyThreshold,
    runMaximum,
    runCanBind,
    minimumPeak,
    attainableBelowPeak,
    bound: reachProbability(minimumPeak),
  };
}

/**
 * Proof that a round can never settle at *exactly* one stake, so the boundary
 * between "returned less than you staked" and "returned more" is unambiguous and
 * every round total falls on one side of it.
 *
 * Every credit is `c(t) * k = 19 * 5^(t-1) * k / (3 * 2^(2t+2))`. The 19 in the
 * numerator can never cancel, because the denominator is a product of 2s and a 3.
 * A sum of such values is therefore `19a/b` with `19` not dividing `b`, and
 * `19a/b = 1` would need `19a = b`. This function checks the invariant
 * mechanically over every reachable single credit rather than trusting the
 * argument, and `docs/MATH.md §13.1` states it.
 */
export function stakeBoundaryIsUnreachable() {
  let checked = 0;
  for (let t = 1; t <= G; t += 1)
    for (let k = 1; k <= MAX_POPULATION; k += 1) {
      const value = multiply(organismValue(t), rat(BigInt(k)));
      if (value.numerator % 19n !== 0n)
        fail('INVALID_MODEL', `Credit c(${t}) * ${k} lost the factor 19 from its numerator`);
      if (value.denominator % 19n === 0n)
        fail('INVALID_MODEL', `Credit c(${t}) * ${k} carries 19 in its denominator`);
      checked += 1;
    }
  return { ok: true, creditsChecked: checked, factor: 19 };
}


// Cached public entry points. Each is a pure function of the frozen
// configuration; see `memoize` above for why that makes caching safe.
export const enumerateWildLine = memoize(enumerateWildLineUncached);
export const reachProbability = memoize(reachProbabilityUncached);
export const maximumRoundPayout = memoize(maximumRoundPayoutUncached);
export const sideBets = memoize(sideBetsUncached);
export const maximumRoundPayoutBelowPeak = memoize(maximumRoundPayoutBelowPeakUncached);
export const aliveOccupancy = memoize(aliveOccupancyUncached);
export const maximumCreditEvents = memoize(maximumCreditEventsUncached);
