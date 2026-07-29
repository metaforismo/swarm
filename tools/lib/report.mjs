/**
 * Builds the complete SWARM paytable object from the exact model.
 *
 * `tools/enumerate.mjs` prints it, `spec/paytable.v1.json` freezes it, and
 * `tests/` re-derives it and compares it against both the frozen fixture and
 * the numbers published in docs/MATH.md. There is exactly one source of truth
 * and it is the enumeration, not the prose.
 */

import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  BLOOM_THRESHOLD,
  CONFIG,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_STAKE_UNITS,
  MAX_WIN_MULTIPLE,
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
  enumerateWildLine,
  maximumRoundPayout,
  evaluatePolicy,
  expectedGenerations,
  populationDistribution,
  proveStrategyInvariance,
  reachProbability,
  runProbabilityMass,
  runRtp,
  runTail,
  sideBets,
  survivalCurve,
  terminalCategories,
} from './model.mjs';
import {
  ONE,
  divide,
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

export function buildPaytable() {
  assertConfig();
  assertRiskPolicy();

  const pmf = offspringPmf();
  const { terminals } = enumerateWildLine();
  const categories = terminalCategories();
  const proof = proveStrategyInvariance();

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
      maxWinMultiple: MAX_WIN_MULTIPLE.toString(),
      unitsPerCredit: UNITS_PER_CREDIT.toString(),
      minStakeUnits: MIN_STAKE_UNITS.toString(),
      maxStakeUnits: MAX_STAKE_UNITS.toString(),
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
      return {
        id: policy.id,
        label: policy.label,
        rtp: toFraction(evaluation.mean),
        rtpDecimal: toDecimal(evaluation.mean, 10),
        variance: toFraction(evaluation.variance),
        standardDeviation: toSqrtDecimal(evaluation.variance, 6),
        zeroProbability: toDecimal(evaluation.zeroProbability, 10),
        hitRate: toDecimal(subtract(ONE, evaluation.zeroProbability), 10),
      };
    }),
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
      rtp: toFraction(bet.rtp),
    })),
    structuralMaximum: {
      multiplier: toFraction(structural),
      decimal: toDecimal(structural, 6),
      generation: MAX_GENERATIONS,
      population: MAX_POPULATION,
      probability: structuralTerminal ? toFraction(structuralTerminal.probability) : '0/1',
      scientific: structuralTerminal ? toScientific(structuralTerminal.probability, 6) : '0',
      declaredMaxWinMultiple: MAX_WIN_MULTIPLE.toString(),
      capBinds: false,
    },
    roundMaximum: {
      multiplier: toFraction(maximumRoundPayout().multiplier),
      decimal: toDecimal(maximumRoundPayout().multiplier, 6),
      note: 'Largest total one round can credit across every draw grid and every harvest policy.',
      declaredMaxWinMultiple: MAX_WIN_MULTIPLE.toString(),
      capBinds: false,
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
