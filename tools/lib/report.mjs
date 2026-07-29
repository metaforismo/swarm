/**
 * Builds the complete SWARM paytable object from the exact model.
 *
 * `tools/enumerate.mjs` prints it, `spec/paytable.v2.json` freezes it, and
 * `tests/` re-derives it and compares it against both the frozen fixture and
 * the numbers published in docs/MATH.md. There is exactly one source of truth
 * and it is the enumeration, not the prose.
 */

import {
  ABANDONED_ROUND_TIMEOUT_HOURS,
  ADAPTER_ID,
  ADAPTER_VERSION,
  BLOOM_THRESHOLD,
  COLONY_MAX_WIN_MULTIPLE,
  CONFIG,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_SIDE_BET_STAKE_UNITS,
  MAX_STAKE_UNITS,
  MAX_TICKET_EXPOSURE_UNITS,
  MIN_SIDE_BET_STAKE_UNITS,
  MIN_STAKE_UNITS,
  OFFSPRING,
  PAYTABLE_SCHEMA,
  SEED_COUNT,
  UNITS_PER_CREDIT,
  assertConfig,
  colonyMultiplier,
  offspringPmf,
  organismValue,
  structuralMaxMultiplier,
} from './config.mjs';
import {
  POLICIES,
  assertRiskPolicy,
  bloomPayoutProfile,
  breakEvenLadder,
  enumerateWildLine,
  extremalRoundVariance,
  feedbackHonesty,
  maximumRoundPayout,
  evaluatePolicy,
  expectedGenerations,
  peakBand,
  policyOutcomeSplit,
  populationDistribution,
  proveStrategyInvariance,
  reachProbability,
  runProbabilityMass,
  runRtp,
  runTail,
  sideBets,
  survivalCurve,
  terminalCategories,
  underwaterAfterFirstGeneration,
} from './model.mjs';
import {
  ONE,
  divide,
  multiply,
  rat,
  subtract,
  toDecimal,
  toFraction,
  toOneIn,
  toScientific,
  toSqrtDecimal,
} from './rational.mjs';

const exact = (value, digits = 10) => ({
  exact: toFraction(value),
  decimal: toDecimal(value, digits),
});

const exactWithOdds = (value, digits = 12) => ({
  exact: toFraction(value),
  decimal: toDecimal(value, digits),
  scientific: toScientific(value, 6),
  oneIn: toOneIn(value, 2),
});

export const TAIL_THRESHOLDS = [1n, 2n, 5n, 10n, 25n, 50n, 100n, 250n, 500n];
export const REACH_THRESHOLDS = [4, 6, 8, 10, 12, 14, 16];
/** Populations the feedback-honesty table is published for (docs/DESIGN.md §6.5). */
export const FEEDBACK_POPULATIONS = [3, 5, 8, 12, 15];
/** The near-miss band: reached the SWARM-adjacent sizes but not FULL BLOOM. */
export const NEAR_MISS_BAND = [12, BLOOM_THRESHOLD];

export function buildPaytable() {
  assertConfig();
  const risk = assertRiskPolicy();

  const pmf = offspringPmf();
  const { terminals } = enumerateWildLine();
  const categories = terminalCategories();
  const proof = proveStrategyInvariance();
  const bloom = bloomPayoutProfile();
  const underwater = underwaterAfterFirstGeneration();
  const varianceMax = extremalRoundVariance('max');
  const varianceMin = extremalRoundVariance('min');
  const nearMiss = peakBand(NEAR_MISS_BAND[0], NEAR_MISS_BAND[1]);

  const structural = structuralMaxMultiplier();
  const structuralTerminal = terminals.find(
    (entry) => entry.generation === MAX_GENERATIONS && entry.population === MAX_POPULATION,
  );

  return {
    schema: PAYTABLE_SCHEMA,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    config: {
      drawModulus: DRAW_MODULUS.toString(),
      offspring: OFFSPRING.map((outcome) => ({
        id: outcome.id,
        children: outcome.children,
        weight: outcome.weight.toString(),
        drawBand: `${outcome.lowDraw}-${outcome.highDraw}`,
        probability: toFraction(rat(outcome.weight, DRAW_MODULUS)),
        percent: toDecimal(rat(outcome.weight * 100n, DRAW_MODULUS), 2),
      })),
      offspringMean: toFraction(CONFIG.mu),
      offspringPmf: pmf.map((value, children) => ({ children, probability: toFraction(value) })),
      seedCount: SEED_COUNT,
      maxGenerations: MAX_GENERATIONS,
      bloomThreshold: BLOOM_THRESHOLD,
      maxPopulation: MAX_POPULATION,
      drawGridSize: MAX_GENERATIONS * (BLOOM_THRESHOLD - 1),
      targetRtp: toFraction(CONFIG.targetRtp),
      targetRtpPercent: toDecimal(
        rat(CONFIG.targetRtp.numerator * 100n, CONFIG.targetRtp.denominator),
        4,
      ),
      ladderBase: toFraction(CONFIG.ladderBase),
      ladderStep: toFraction(divide(ONE, CONFIG.mu)),
      colonyMaxWinMultiple: COLONY_MAX_WIN_MULTIPLE.toString(),
      unitsPerCredit: UNITS_PER_CREDIT.toString(),
      minStakeUnits: MIN_STAKE_UNITS.toString(),
      maxStakeUnits: MAX_STAKE_UNITS.toString(),
      minSideBetStakeUnits: MIN_SIDE_BET_STAKE_UNITS.toString(),
      maxSideBetStakeUnits: MAX_SIDE_BET_STAKE_UNITS.toString(),
      maxTicketExposureUnits: MAX_TICKET_EXPOSURE_UNITS.toString(),
      abandonedRoundTimeoutHours: ABANDONED_ROUND_TIMEOUT_HOURS,
    },
    ladder: Array.from({ length: MAX_GENERATIONS }, (_unused, index) => {
      const generation = index + 1;
      return {
        generation,
        organismValue: toFraction(organismValue(generation)),
        decimal: toDecimal(organismValue(generation), 6),
        colonyOfThree: toDecimal(colonyMultiplier(generation, 3), 6),
        bloomFloor: toDecimal(colonyMultiplier(generation, BLOOM_THRESHOLD), 6),
      };
    }),
    generationOne: populationDistribution(1).map((entry) => ({
      population: entry.population,
      probability: toFraction(entry.probability),
      percent: toDecimal(
        rat(entry.probability.numerator * 100n, entry.probability.denominator),
        4,
      ),
      multiplier: toFraction(colonyMultiplier(1, entry.population)),
      multiplierDecimal: toDecimal(colonyMultiplier(1, entry.population), 6),
    })),
    survival: survivalCurve().map((entry) => ({
      generation: entry.generation,
      alive: toFraction(entry.alive),
      decimal: toDecimal(entry.alive, 10),
    })),
    terminalCategories: {
      EXTINCT: exact(categories.EXTINCT),
      BLOOM: exactWithOdds(categories.BLOOM),
      FINAL: exact(categories.FINAL),
    },
    totals: {
      probabilityMass: toFraction(runProbabilityMass()),
      rtp: toFraction(runRtp()),
      rtpPercent: toDecimal(rat(runRtp().numerator * 100n, runRtp().denominator), 6),
      terminalCount: terminals.length,
      expectedGenerations: toDecimal(expectedGenerations(), 8),
    },
    tail: runTail(TAIL_THRESHOLDS.map((value) => rat(value))).map((entry, index) => ({
      threshold: TAIL_THRESHOLDS[index].toString(),
      probability: toFraction(entry.probability),
      decimal: toDecimal(entry.probability, 12),
      scientific: toScientific(entry.probability, 6),
      oneIn: toOneIn(entry.probability, 2),
    })),
    reach: REACH_THRESHOLDS.map((threshold) => {
      const probability = reachProbability(threshold);
      return {
        threshold,
        probability: toFraction(probability),
        decimal: toDecimal(probability, 12),
        scientific: toScientific(probability, 6),
        oneIn: toOneIn(probability, 2),
      };
    }),
    policies: Object.values(POLICIES).map((policy) => {
      const evaluation = evaluatePolicy(policy.fn);
      const split = policyOutcomeSplit(policy.fn);
      if (toFraction(split.zero) !== toFraction(evaluation.zeroProbability))
        throw new Error(`Outcome split disagrees with backward induction for ${policy.id}`);
      return {
        id: policy.id,
        label: policy.label,
        rtp: toFraction(evaluation.mean),
        rtpDecimal: toDecimal(evaluation.mean, 10),
        variance: toFraction(evaluation.variance),
        standardDeviation: toSqrtDecimal(evaluation.variance, 6),
        zeroProbability: toDecimal(evaluation.zeroProbability, 10),
        // P(credit > 0): true, and on its own misleading, because a return of
        // 0.396x counts. Published next to the profit rate, never instead of it.
        hitRate: toDecimal(subtract(ONE, evaluation.zeroProbability), 10),
        subStakeProbability: toDecimal(split.subStake, 10),
        // P(credit > stake): the number that means what a player thinks "win" means.
        profitRate: toDecimal(split.profit, 10),
        profitRateExact: toFraction(split.profit),
      };
    }),
    varianceBounds: {
      note:
        'Exact extremes over every adapted decision policy, by backward induction. ' +
        'The expected continuation value is policy-independent, so the accumulated ' +
        'bank cancels out of the comparison between actions and the (t, n) recursion ' +
        'is the true extremum, not a sample over chosen policies.',
      minimum: {
        variance: toFraction(varianceMin.variance),
        standardDeviation: toSqrtDecimal(varianceMin.variance, 6),
        harvestStates: varianceMin.harvests.length,
      },
      maximum: {
        variance: toFraction(varianceMax.variance),
        standardDeviation: toSqrtDecimal(varianceMax.variance, 6),
        harvestStates: varianceMax.harvests.length,
        harvests: varianceMax.harvests.map((entry) => ({
          generation: entry.generation,
          population: entry.population,
          harvest: entry.harvest,
        })),
      },
    },
    bloom: {
      mass: toFraction(bloom.mass),
      oneIn: toOneIn(bloom.mass, 2),
      outcomeCount: bloom.outcomeCount,
      smallest: toDecimal(bloom.smallest, 6),
      smallestExact: toFraction(bloom.smallest),
      smallestGeneration: bloom.smallestGeneration,
      smallestPopulation: bloom.smallestPopulation,
      largest: toDecimal(bloom.largest, 6),
      median: toDecimal(bloom.median, 6),
      shareBelow20x: toDecimal(bloom.shareBelow20x, 6),
      shareBelow50x: toDecimal(bloom.shareBelow50x, 6),
      shareBelow100x: toDecimal(bloom.shareBelow100x, 6),
      smallestFinal: toDecimal(bloom.smallestFinal, 6),
      shareBelowSmallestFinal: toDecimal(bloom.shareBelowSmallestFinal, 6),
    },
    nearMiss: {
      band: `${NEAR_MISS_BAND[0]}-${NEAR_MISS_BAND[1] - 1}`,
      probability: toFraction(nearMiss),
      decimal: toDecimal(nearMiss, 10),
      oneIn: toOneIn(nearMiss, 2),
    },
    feedback: feedbackHonesty(FEEDBACK_POPULATIONS).map((row) => ({
      population: row.population,
      falls: toDecimal(row.falls, 6),
      flat: toDecimal(row.flat, 6),
      rises: toDecimal(row.rises, 6),
      anySplit: toDecimal(row.anySplit, 6),
      fallsWithSplit: toDecimal(row.fallsWithSplit, 6),
      fallsWithTwoSplits: toDecimal(row.fallsWithTwoSplits, 6),
      splitGivenFalls: toDecimal(row.splitGivenFalls, 6),
    })),
    breakEven: breakEvenLadder().map((row) => ({
      generation: row.generation,
      organismValue: toDecimal(row.organismValue, 6),
      atLeastStake: row.atLeast,
      aboveStake: row.above,
      colonyOfThree: toDecimal(colonyMultiplier(row.generation, 3), 6),
    })),
    underwater: {
      afterGenerationOne: toFraction(underwater.underwater),
      afterGenerationOneDecimal: toDecimal(underwater.underwater, 10),
      extinct: toFraction(underwater.extinct),
      aliveBelowStake: toFraction(underwater.aliveBelow),
      aboveStake: toFraction(underwater.aboveWater),
    },
    proof: {
      ok: proof.ok,
      statesChecked: proof.statesChecked,
      actionsChecked: proof.actionsChecked,
      optimalRtp: toFraction(proof.optimalRtp),
      failures: proof.failures.length,
    },
    sideBets: sideBets().map((bet) => ({
      id: bet.id,
      label: bet.label,
      description: bet.description,
      probability: toFraction(bet.probability),
      probabilityDecimal: toDecimal(bet.probability, 12),
      oneIn: toOneIn(bet.probability, 2),
      multiplier: toFraction(bet.multiplier),
      multiplierDecimal: toDecimal(bet.multiplier, 6),
      capMultiple: bet.capMultiple.toString(),
      rtp: toFraction(bet.rtp),
    })),
    risk: {
      basis: 'per bet line, on that line\'s own stake',
      lines: risk.lines.map((line) => ({
        line: line.line,
        basis: line.basis,
        maximumCredit: toFraction(line.maximumCredit),
        maximumCreditDecimal: toDecimal(line.maximumCredit, 6),
        capMultiple: line.capMultiple.toString(),
        headroom: toDecimal(subtract(rat(line.capMultiple), line.maximumCredit), 6),
        binds: false,
      })),
      ticket: {
        note:
          'Worst-case liability of one ticket at the declared stake bounds: the sum ' +
          'of every line at its own ceiling. An open-time admission check, never a ' +
          'settlement-time truncation.',
        worstCaseExposureUnits: risk.ticket.worstCaseExposureUnits.toString(),
        worstCaseExposureCredits: (
          risk.ticket.worstCaseExposureUnits / UNITS_PER_CREDIT
        ).toString(),
        admissionLimitUnits: risk.ticket.admissionLimitUnits.toString(),
        admissionLimitCredits: (risk.ticket.admissionLimitUnits / UNITS_PER_CREDIT).toString(),
        binds: risk.ticket.binds,
      },
    },
    structuralMaximum: {
      multiplier: toFraction(structural),
      decimal: toDecimal(structural, 6),
      generation: MAX_GENERATIONS,
      population: MAX_POPULATION,
      probability: structuralTerminal ? toFraction(structuralTerminal.probability) : '0/1',
      scientific: structuralTerminal ? toScientific(structuralTerminal.probability, 6) : '0',
      declaredMaxWinMultiple: COLONY_MAX_WIN_MULTIPLE.toString(),
      capBinds: false,
    },
    roundMaximum: {
      multiplier: toFraction(maximumRoundPayout().multiplier),
      decimal: toDecimal(maximumRoundPayout().multiplier, 6),
      note: 'Largest total the COLONY line can credit across every draw grid and every harvest policy.',
      declaredMaxWinMultiple: COLONY_MAX_WIN_MULTIPLE.toString(),
      capBinds: false,
    },
    roundingBound: {
      note:
        'Floor rounding costs at most one minor unit per credit event; a round has ' +
        'at most 18 of them. The relative bound is stated at the minimum stake, ' +
        'which is where it is largest.',
      maximumCreditEvents: MAX_GENERATIONS,
      maximumLossUnits: MAX_GENERATIONS.toString(),
      maximumLossCredits: toDecimal(rat(BigInt(MAX_GENERATIONS), UNITS_PER_CREDIT), 8),
      relativeAtMinimumStake: toScientific(
        rat(BigInt(MAX_GENERATIONS), MIN_STAKE_UNITS),
        6,
      ),
      relativeAtMinimumStakePercentagePoints: toDecimal(
        multiply(rat(BigInt(MAX_GENERATIONS), MIN_STAKE_UNITS), rat(100n)),
        6,
      ),
      relativeAtMaximumStake: toScientific(rat(BigInt(MAX_GENERATIONS), MAX_STAKE_UNITS), 6),
    },
    terminals: terminals.map((terminal) => ({
      generation: terminal.generation,
      population: terminal.population,
      reason: terminal.reason,
      probability: toFraction(terminal.probability),
      multiplier: toFraction(terminal.multiplier),
    })),
  };
}
