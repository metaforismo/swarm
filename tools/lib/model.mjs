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
export function enumerateWildLine() {
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
export function reachProbability(threshold) {
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
export function maximumRoundPayout() {
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
export function sideBets() {
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

