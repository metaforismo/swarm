import { describe, expect, it } from 'vitest';
import {
  BLOOM_THRESHOLD,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_WIN_MULTIPLE,
  OFFSPRING,
  SEED_COUNT,
  TARGET_RTP,
  UNITS_PER_CREDIT,
  assertConfig,
  colonyMultiplier,
  offspringPmf,
  organismValue,
  structuralMaxMultiplier,
} from '../tools/lib/config.mjs';
import {
  POLICIES,
  assertRiskPolicy,
  buildKernel,
  enumerateWildLine,
  evaluatePolicy,
  expectedGenerations,
  extinctionByGeneration,
  maximumRoundPayout,
  payableUnits,
  populationDistribution,
  proveStrategyInvariance,
  reachProbability,
  runProbabilityMass,
  runRtp,
  sideBets,
  survivalCurve,
  terminalCategories,
  transitionProbability,
} from '../tools/lib/model.mjs';
import {
  ONE,
  SwarmMathError,
  ZERO,
  add,
  compare,
  equal,
  multiply,
  power,
  rat,
  sum,
  toFraction,
} from '../tools/lib/rational.mjs';

describe('configuration', () => {
  it('is internally consistent', () => {
    expect(assertConfig()).toBe(true);
    expect(assertRiskPolicy()).toBe(true);
  });

  it('has offspring weights that tile the draw modulus in order', () => {
    let cursor = 0n;
    for (const outcome of OFFSPRING) {
      expect(outcome.lowDraw).toBe(cursor);
      expect(outcome.highDraw).toBe(cursor + outcome.weight - 1n);
      cursor += outcome.weight;
    }
    expect(cursor).toBe(DRAW_MODULUS);
  });

  it('derives the ladder from the RTP identity', () => {
    // c(1) * seeds * mu === target RTP
    const pmf = offspringPmf();
    const mu = add(pmf[1], multiply(rat(2n), pmf[2]));
    const entry = multiply(multiply(organismValue(1), rat(BigInt(SEED_COUNT))), mu);
    expect(toFraction(entry)).toBe(toFraction(TARGET_RTP));
    // ladder step is exactly 1/mu
    for (let t = 2; t <= MAX_GENERATIONS; t += 1)
      expect(equal(multiply(organismValue(t), mu), organismValue(t - 1))).toBe(true);
  });

  it('bounds the state space exactly', () => {
    expect(MAX_POPULATION).toBe(2 * (BLOOM_THRESHOLD - 1));
    expect(() => colonyMultiplier(1, MAX_POPULATION + 1)).toThrow(SwarmMathError);
    expect(() => organismValue(MAX_GENERATIONS + 1)).toThrow(SwarmMathError);
    expect(() => organismValue(0)).toThrow(SwarmMathError);
  });
});

describe('transition kernel', () => {
  it('rows sum to the modulus raised to the population', () => {
    const kernel = buildKernel(BLOOM_THRESHOLD - 1);
    for (let n = 0; n < BLOOM_THRESHOLD; n += 1) {
      const total = kernel[n].reduce((carry, value) => carry + value, 0n);
      expect(total).toBe(DRAW_MODULUS ** BigInt(n));
      expect(kernel[n].length).toBe(2 * n + 1);
    }
  });

  it('gives a proper probability distribution for every population', () => {
    for (let n = 1; n < BLOOM_THRESHOLD; n += 1) {
      const values = [];
      for (let m = 0; m <= 2 * n; m += 1) values.push(transitionProbability(n, m));
      expect(toFraction(sum(values))).toBe('1/1');
    }
  });

  it('has the declared mean offspring', () => {
    for (let n = 1; n < BLOOM_THRESHOLD; n += 1) {
      let mean = ZERO;
      for (let m = 0; m <= 2 * n; m += 1)
        mean = add(mean, multiply(transitionProbability(n, m), rat(BigInt(m))));
      expect(toFraction(mean)).toBe(toFraction(rat(BigInt(n) * 4n, 5n)));
    }
  });
});

describe('independent oracles', () => {
  /**
   * Brute-force path enumeration: literally expands every organism's three
   * possible outcomes, with no kernel, no convolution and no polynomial.
   */
  function bruteForceDistribution(generations) {
    let paths = new Map([[SEED_COUNT, ONE]]);
    for (let generation = 1; generation <= generations; generation += 1) {
      const next = new Map();
      const deposit = (population, probability) =>
        next.set(population, add(next.get(population) ?? ZERO, probability));
      for (const [population, probability] of paths) {
        if (population === 0) {
          deposit(0, probability);
          continue;
        }
        const expand = (index, produced, pathProbability) => {
          if (index === population) {
            deposit(produced, pathProbability);
            return;
          }
          for (const outcome of OFFSPRING)
            expand(
              index + 1,
              produced + outcome.children,
              multiply(pathProbability, rat(outcome.weight, DRAW_MODULUS)),
            );
        };
        expand(0, 0, probability);
      }
      paths = next;
    }
    return paths;
  }

  /** Polynomial composition oracle: PGF of N(t) for three ancestors is f^(t)(x)^3. */
  function generatingFunctionDistribution(generations) {
    const pmf = offspringPmf();
    const multiplyPoly = (left, right) => {
      const result = new Array(left.length + right.length - 1).fill(ZERO);
      for (let i = 0; i < left.length; i += 1)
        for (let j = 0; j < right.length; j += 1)
          result[i + j] = add(result[i + j], multiply(left[i], right[j]));
      return result;
    };
    const composeWithF = (poly) => {
      let result = [ZERO];
      for (let index = poly.length - 1; index >= 0; index -= 1) {
        result = multiplyPoly(result, pmf);
        result[0] = add(result[0], poly[index]);
      }
      return result;
    };
    let iterate = [ZERO, ONE]; // f^(0)(x) = x
    for (let step = 0; step < generations; step += 1) iterate = composeWithF(iterate);
    return multiplyPoly(multiplyPoly(iterate, iterate), iterate);
  }

  // The oracles report P(N(t) = 0) cumulatively; the model reports the mass
  // that dies *at* generation t, because extinct mass is absorbed into a
  // terminal state and never revisited. Live populations must agree exactly,
  // and the cumulative extinction is compared separately.
  const livePopulations = (model) => model.filter((entry) => entry.population > 0);

  it('reproduces the generation-1 distribution by brute force over all 27 outcome triples', () => {
    const brute = bruteForceDistribution(1);
    for (const entry of populationDistribution(1))
      expect(toFraction(entry.probability), `population ${entry.population}`).toBe(
        toFraction(brute.get(entry.population)),
      );
    expect(toFraction(sum([...brute.values()]))).toBe('1/1');
  });

  it('reproduces the generation-2 distribution by brute force over every path', () => {
    const brute = bruteForceDistribution(2);
    for (const entry of livePopulations(populationDistribution(2)))
      expect(toFraction(entry.probability), `population ${entry.population}`).toBe(
        toFraction(brute.get(entry.population) ?? ZERO),
      );
    expect(toFraction(extinctionByGeneration(2))).toBe(toFraction(brute.get(0)));
  });

  it('reproduces the generation-3 distribution from the generating function', () => {
    // Max population after three generations is 12 < BLOOM_THRESHOLD, so no
    // bloom absorption is involved and the polynomial is directly comparable.
    const coefficients = generatingFunctionDistribution(3);
    for (const entry of livePopulations(populationDistribution(3)))
      expect(toFraction(entry.probability), `population ${entry.population}`).toBe(
        toFraction(coefficients[entry.population] ?? ZERO),
      );
    expect(toFraction(extinctionByGeneration(3))).toBe(toFraction(coefficients[0]));
    expect(toFraction(sum(coefficients))).toBe('1/1');
  });

  it('matches the probability-generating-function value of early extinction', () => {
    // q(t) = f(q(t-1)) with f(s) = (8 + 8 s + 4 s^2) / 20, colony extinction = q(t)^3.
    const pmf = offspringPmf();
    let q = ZERO;
    for (let t = 1; t <= 3; t += 1)
      q = add(add(pmf[0], multiply(pmf[1], q)), multiply(pmf[2], multiply(q, q)));
    expect(toFraction(extinctionByGeneration(3))).toBe(toFraction(power(q, 3)));
  });
});

describe('outcome space', () => {
  it('is a complete probability space', () => {
    expect(toFraction(runProbabilityMass())).toBe('1/1');
  });

  it('returns exactly the target RTP', () => {
    expect(toFraction(runRtp())).toBe('19/20');
  });

  it('splits into three terminal categories that sum to one', () => {
    const categories = terminalCategories();
    expect(
      toFraction(add(add(categories.EXTINCT, categories.BLOOM), categories.FINAL)),
    ).toBe('1/1');
  });

  it('has a monotone survival curve ending at the last generation', () => {
    const curve = survivalCurve();
    expect(curve).toHaveLength(MAX_GENERATIONS);
    for (let index = 1; index < curve.length; index += 1)
      expect(compare(curve[index].alive, curve[index - 1].alive)).toBe(-1);
  });

  it('only produces terminals inside the declared state space', () => {
    const { terminals } = enumerateWildLine();
    for (const terminal of terminals) {
      expect(terminal.generation).toBeGreaterThanOrEqual(1);
      expect(terminal.generation).toBeLessThanOrEqual(MAX_GENERATIONS);
      expect(terminal.population).toBeGreaterThanOrEqual(0);
      expect(terminal.population).toBeLessThanOrEqual(MAX_POPULATION);
      if (terminal.reason === 'BLOOM') expect(terminal.population).toBeGreaterThanOrEqual(BLOOM_THRESHOLD);
      if (terminal.reason === 'FINAL') expect(terminal.generation).toBe(MAX_GENERATIONS);
      if (terminal.reason === 'EXTINCT') expect(terminal.population).toBe(0);
    }
  });

  it('has a decreasing reach probability in the threshold', () => {
    let previous = ONE;
    for (const threshold of [4, 6, 8, 10, 12, 14, 16]) {
      const probability = reachProbability(threshold);
      expect(compare(probability, previous)).toBe(-1);
      previous = probability;
    }
  });

  it('reports a plausible expected round length', () => {
    const expected = expectedGenerations();
    expect(compare(expected, rat(1n))).toBe(1);
    expect(compare(expected, rat(BigInt(MAX_GENERATIONS)))).toBe(-1);
  });
});

describe('strategy invariance', () => {
  it('proves every action at every reachable state has identical value', () => {
    const proof = proveStrategyInvariance();
    expect(proof.failures).toEqual([]);
    expect(proof.ok).toBe(true);
    expect(proof.statesChecked).toBe((MAX_GENERATIONS - 1) * (BLOOM_THRESHOLD - 1));
    expect(toFraction(proof.optimalRtp)).toBe('19/20');
  });

  it('returns exactly 19/20 for every bundled policy', () => {
    for (const policy of Object.values(POLICIES)) {
      const evaluation = evaluatePolicy(policy.fn);
      expect(toFraction(evaluation.mean), policy.id).toBe('19/20');
      expect(compare(evaluation.variance, ZERO)).toBe(1);
    }
  });

  it('returns exactly 19/20 for adversarial and pathological policies', () => {
    const policies = {
      harvestOne: (_t, n) => (n >= 2 ? 1 : 0),
      harvestAllButOne: (_t, n) => n - 1,
      alternate: (t, n) => (t % 2 === 0 ? Math.floor(n / 2) : 0),
      deterministicChaos: (t, n) => ((t * 7 + n * 13) % (n + 1)),
      bankOnPrimeGeneration: (t, n) => ([2, 3, 5, 7, 11, 13, 17].includes(t) ? n : 0),
      thirds: (_t, n) => Math.floor(n / 3),
      hoardThenDump: (t, n) => (t < 12 ? 0 : n),
    };
    for (const [name, fn] of Object.entries(policies))
      expect(toFraction(evaluatePolicy(fn).mean), name).toBe('19/20');
  });

  it('produces materially different variance across policies', () => {
    const bankFirst = evaluatePolicy(POLICIES.BANK_FIRST.fn);
    const run = evaluatePolicy(POLICIES.RUN.fn);
    expect(compare(run.variance, bankFirst.variance)).toBe(1);
    expect(compare(run.zeroProbability, bankFirst.zeroProbability)).toBe(1);
  });

  it('rejects a policy that harvests more organisms than exist', () => {
    expect(() => evaluatePolicy((_t, n) => n + 1)).toThrow(/out-of-range harvest/u);
    expect(() => evaluatePolicy(() => -1)).toThrow(/out-of-range harvest/u);
    expect(() => evaluatePolicy(() => 1.5)).toThrow(/out-of-range harvest/u);
    expect(() => evaluatePolicy('not a function')).toThrow(SwarmMathError);
  });
});

describe('caps', () => {
  it('keeps the declared cap above every reachable round total', () => {
    const { multiplier } = maximumRoundPayout();
    expect(compare(multiplier, rat(MAX_WIN_MULTIPLE))).toBe(-1);
    // A round total can exceed the largest single settlement, which is exactly
    // why the cap is set from the round maximum and not from the settlement.
    expect(compare(multiplier, structuralMaxMultiplier())).toBe(1);
  });

  it('never truncates the largest single settlement', () => {
    const payable = payableUnits(UNITS_PER_CREDIT, structuralMaxMultiplier());
    expect(payable.capped).toBe(false);
    expect(payable.credited).toBe(527355936n);
  });

  it('applies the cumulative cap on the original stake basis', () => {
    const stake = UNITS_PER_CREDIT;
    const huge = rat(MAX_WIN_MULTIPLE * 2n);
    const first = payableUnits(stake, huge);
    expect(first.capped).toBe(true);
    expect(first.credited).toBe(stake * MAX_WIN_MULTIPLE);
    const second = payableUnits(stake, huge, first.credited);
    expect(second.credited).toBe(0n);
  });

  it('floors every credit, losing less than one minor unit', () => {
    const payable = payableUnits(3n, rat(1n, 2n));
    expect(payable.credited).toBe(1n);
    expect(toFraction(payable.theoretical)).toBe('3/2');
  });

  it('rejects hostile stakes', () => {
    expect(() => payableUnits(0n, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(-5n, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(1000000, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(1n, ONE, -1n)).toThrow(SwarmMathError);
  });
});

describe('side bets', () => {
  it('prices every side bet at exactly the target RTP', () => {
    const bets = sideBets();
    expect(bets).toHaveLength(3);
    for (const bet of bets) {
      expect(toFraction(bet.rtp), bet.id).toBe('19/20');
      expect(compare(bet.multiplier, rat(MAX_WIN_MULTIPLE))).toBe(-1);
      expect(compare(bet.probability, ZERO)).toBe(1);
      expect(compare(bet.probability, ONE)).toBe(-1);
    }
  });

  it('keeps FIRST LIGHT at the exact rational the documentation quotes', () => {
    const [firstLight] = sideBets();
    expect(firstLight.id).toBe('FIRST_LIGHT');
    expect(toFraction(firstLight.probability)).toBe('1/5');
    expect(toFraction(firstLight.multiplier)).toBe('19/4');
  });

  it('resolves side bets on the wild line, independently of play', () => {
    // The wild line is a pure function of the model, so two evaluations agree
    // exactly and no policy input exists to perturb them.
    expect(toFraction(sideBets()[2].probability)).toBe(toFraction(reachProbability(10)));
  });
});
