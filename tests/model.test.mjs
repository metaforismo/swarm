import { describe, expect, it } from 'vitest';
import {
  BLOOM_THRESHOLD,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_SIDE_BET_STAKE_UNITS,
  MAX_STAKE_UNITS,
  MAX_TICKET_EXPOSURE_UNITS,
  MIN_STAKE_UNITS,
  OFFSPRING,
  SEED_COUNT,
  SIDE_BET_MAX_WIN_MULTIPLES,
  TARGET_RTP,
  UNITS_PER_CREDIT,
  assertConfig,
  colonyMultiplier,
  maximumTicketExposureUnits,
  offspringPmf,
  organismValue,
  structuralMaxMultiplier,
  ticketExposureUnits,
} from '../tools/lib/config.mjs';
import {
  POLICIES,
  assertRiskPolicy,
  maximumRoundPayoutBelowPeak,
  sharedCapBinding,
  stakeBoundaryIsUnreachable,
  bloomPayoutProfile,
  breakEvenLadder,
  buildKernel,
  enumerateWildLine,
  evaluatePolicy,
  expectedGenerations,
  extinctionByGeneration,
  extremalRoundVariance,
  feedbackHonesty,
  maximumRoundPayout,
  payableUnits,
  peakBand,
  policyOutcomeSplit,
  populationDistribution,
  proveStrategyInvariance,
  reachProbability,
  runProbabilityMass,
  runRtp,
  sideBets,
  survivalCurve,
  terminalCategories,
  transitionProbability,
  underwaterAfterFirstGeneration,
} from '../tools/lib/model.mjs';
import {
  CHORD_STEPS,
  MEDUSA_THRESHOLD,
  bodyRadius,
  chordLadder,
  chordThreshold,
  colonyLayout,
  layoutRadiusDecimal,
  settlementClasses,
  verdictBands,
  verdictBeatMass,
  verdictBeats,
  verdictReach,
} from '../tools/lib/presentation.mjs';
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
  subtract,
  sum,
  toFraction,
} from '../tools/lib/rational.mjs';

describe('configuration', () => {
  it('is internally consistent', () => {
    expect(assertConfig()).toBe(true);
    expect(assertRiskPolicy().ok).toBe(true);
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

describe('caps, one basis per bet line', () => {
  it('keeps the declared colony cap above every reachable round total', () => {
    const { multiplier } = maximumRoundPayout();
    expect(compare(multiplier, rat(COLONY_MAX_WIN_MULTIPLE))).toBe(-1);
    // A round total can exceed the largest single settlement, which is exactly
    // why the cap is set from the round maximum and not from the settlement.
    expect(compare(multiplier, structuralMaxMultiplier())).toBe(1);
  });

  it('keeps every side bet strictly below its own cap', () => {
    for (const bet of sideBets()) {
      expect(compare(bet.multiplier, rat(bet.capMultiple)), bet.id).toBe(-1);
      expect(bet.capMultiple).toBe(SIDE_BET_MAX_WIN_MULTIPLES[bet.id]);
    }
  });

  it('would bind if the lines shared one basis, which is why they do not', () => {
    // The regression this exists for: summing the lines against the colony cap
    // owes more than 906x on equal stakes, so a shared basis short-pays.
    let owed = maximumRoundPayout().multiplier;
    for (const bet of sideBets()) owed = add(owed, bet.multiplier);
    expect(compare(owed, rat(COLONY_MAX_WIN_MULTIPLE))).toBe(1);
    // Per line, every one of them has strictly positive headroom.
    for (const line of assertRiskPolicy().lines)
      expect(compare(subtract(rat(line.capMultiple), line.maximumCredit), ZERO), line.line).toBe(1);
  });

  it('pays a side bet in full even when the colony line is at its maximum', () => {
    // The 99.6% short-pay from a shared basis: a small colony bet next to a
    // large side bet. Each line is settled on its own stake, so both pay fully.
    const colonyStake = MIN_STAKE_UNITS; // 0.10 credits
    const swarm = sideBets().find((bet) => bet.id === 'SWARM');
    const swarmStake = MAX_SIDE_BET_STAKE_UNITS; // 100.00 credits
    const colony = payableUnits(
      colonyStake,
      maximumRoundPayout().multiplier,
      0n,
      COLONY_MAX_WIN_MULTIPLE,
    );
    const side = payableUnits(swarmStake, swarm.multiplier, 0n, swarm.capMultiple);
    expect(colony.capped).toBe(false);
    expect(side.capped).toBe(false);
    // The full exact price of the line, floored — not 90.60 credits, which is
    // what a shared 906x basis on a 0.10 colony stake would have paid.
    const exact = multiply(rat(swarmStake), swarm.multiplier);
    expect(side.credited).toBe(exact.numerator / exact.denominator);
    expect(side.credited).toBeGreaterThan(colonyStake * COLONY_MAX_WIN_MULTIPLE);
  });

  it('applies the cumulative cap on that line\'s own stake basis', () => {
    const stake = UNITS_PER_CREDIT;
    const huge = rat(COLONY_MAX_WIN_MULTIPLE * 2n);
    const first = payableUnits(stake, huge, 0n, COLONY_MAX_WIN_MULTIPLE);
    expect(first.capped).toBe(true);
    expect(first.credited).toBe(stake * COLONY_MAX_WIN_MULTIPLE);
    const second = payableUnits(stake, huge, first.credited, COLONY_MAX_WIN_MULTIPLE);
    expect(second.credited).toBe(0n);
  });

  it('never truncates the largest single settlement', () => {
    const payable = payableUnits(UNITS_PER_CREDIT, structuralMaxMultiplier());
    expect(payable.capped).toBe(false);
    expect(payable.credited).toBe(527355936n);
  });

  it('floors every credit, losing less than one minor unit', () => {
    const payable = payableUnits(3n, rat(1n, 2n));
    expect(payable.credited).toBe(1n);
    expect(toFraction(payable.theoretical)).toBe('3/2');
  });

  it('rejects hostile stakes and cap multiples', () => {
    expect(() => payableUnits(0n, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(-5n, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(1000000, ONE)).toThrow(SwarmMathError);
    expect(() => payableUnits(1n, ONE, -1n)).toThrow(SwarmMathError);
    expect(() => payableUnits(1n, ONE, 0n, 0n)).toThrow(SwarmMathError);
    expect(() => payableUnits(1n, ONE, 0n, 906)).toThrow(SwarmMathError);
  });
});

describe('ticket exposure', () => {
  it('sums each line at its own ceiling', () => {
    const stake = UNITS_PER_CREDIT;
    expect(ticketExposureUnits(stake, {})).toBe(stake * COLONY_MAX_WIN_MULTIPLE);
    expect(ticketExposureUnits(stake, { SWARM: stake })).toBe(
      stake * COLONY_MAX_WIN_MULTIPLE + stake * SIDE_BET_MAX_WIN_MULTIPLES.SWARM,
    );
  });

  it('keeps the worst admissible ticket strictly below the operator limit', () => {
    expect(maximumTicketExposureUnits()).toBeLessThan(MAX_TICKET_EXPOSURE_UNITS);
    expect(maximumTicketExposureUnits()).toBe(
      MAX_STAKE_UNITS * COLONY_MAX_WIN_MULTIPLE +
        MAX_SIDE_BET_STAKE_UNITS *
          Object.values(SIDE_BET_MAX_WIN_MULTIPLES).reduce((total, cap) => total + cap, 0n),
    );
  });

  it('rejects out-of-bounds and unknown lines', () => {
    expect(() => ticketExposureUnits(0n, {})).toThrow(SwarmMathError);
    expect(() => ticketExposureUnits(MAX_STAKE_UNITS + 1n, {})).toThrow(SwarmMathError);
    expect(() => ticketExposureUnits(UNITS_PER_CREDIT, { NOPE: UNITS_PER_CREDIT })).toThrow(
      /No such side bet/u,
    );
    expect(() => ticketExposureUnits(UNITS_PER_CREDIT, { SWARM: 1n })).toThrow(SwarmMathError);
    expect(() =>
      ticketExposureUnits(UNITS_PER_CREDIT, { SWARM: MAX_SIDE_BET_STAKE_UNITS + 1n }),
    ).toThrow(SwarmMathError);
  });
});

describe('side bets', () => {
  it('prices every side bet at exactly the target RTP', () => {
    const bets = sideBets();
    expect(bets).toHaveLength(3);
    for (const bet of bets) {
      expect(toFraction(bet.rtp), bet.id).toBe('19/20');
      expect(compare(bet.multiplier, rat(bet.capMultiple))).toBe(-1);
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

describe('profit rate versus hit rate', () => {
  it('splits every bundled policy into zero, sub-stake and profit, summing to one', () => {
    for (const policy of Object.values(POLICIES)) {
      const split = policyOutcomeSplit(policy.fn);
      expect(toFraction(add(add(split.zero, split.subStake), split.profit)), policy.id).toBe('1/1');
      // The forward split and the backward induction must agree on P(zero).
      expect(toFraction(split.zero), policy.id).toBe(
        toFraction(evaluatePolicy(policy.fn).zeroProbability),
      );
      // A profit is a strict subset of a hit.
      expect(compare(split.profit, split.hitRate), policy.id).toBeLessThanOrEqual(0);
    }
  });

  it('shows the gap the published hit rate used to hide', () => {
    const split = policyOutcomeSplit(POLICIES.BANK_FIRST.fn);
    // 8/125 nothing, 60/125 a fraction of the stake, 57/125 an actual profit.
    expect(toFraction(split.zero)).toBe('8/125');
    expect(toFraction(split.subStake)).toBe('12/25');
    expect(toFraction(split.profit)).toBe('57/125');
    expect(toFraction(split.hitRate)).toBe('117/125');
  });

  it('collapses the above-threshold region so the enumeration stays finite', () => {
    // Every harvest adds at least c(1) of a stake, so only a handful of banked
    // values can sit at or below one stake. If this ever explodes, the exactness
    // claim is at risk and the test says so.
    for (const policy of Object.values(POLICIES))
      expect(policyOutcomeSplit(policy.fn).peakStates, policy.id).toBeLessThan(64);
  });

  it('agrees with a brute-force distribution for a single-credit policy', () => {
    // BANK_FIRST pays exactly c(1)*n for the generation-1 population, so the
    // profit rate is the mass of populations worth more than the stake.
    let profit = ZERO;
    for (const entry of populationDistribution(1))
      if (compare(colonyMultiplier(1, entry.population), ONE) > 0)
        profit = add(profit, entry.probability);
    expect(toFraction(profit)).toBe(toFraction(policyOutcomeSplit(POLICIES.BANK_FIRST.fn).profit));
  });

  it('rejects an illegal policy', () => {
    expect(() => policyOutcomeSplit((_t, n) => n + 1)).toThrow(/out-of-range harvest/u);
    expect(() => policyOutcomeSplit('nope')).toThrow(SwarmMathError);
  });
});

describe('volatility is a proven interval, not a sample', () => {
  const maximum = extremalRoundVariance('max');
  const minimum = extremalRoundVariance('min');

  it('brackets every bundled policy', () => {
    for (const policy of Object.values(POLICIES)) {
      const { variance } = evaluatePolicy(policy.fn);
      expect(compare(variance, minimum.variance), policy.id).toBeGreaterThanOrEqual(0);
      expect(compare(variance, maximum.variance), policy.id).toBeLessThanOrEqual(0);
    }
  });

  it('brackets adversarial policies the bundle does not contain', () => {
    const policies = {
      trimBelowBloom: (_t, n) => (n >= 15 ? 1 : 0),
      harvestAllButOne: (_t, n) => n - 1,
      bankIfGrew: (_t, n) => (n > 3 ? 0 : n),
      greedyTail: (t, n) => (t > 14 ? 0 : Math.floor(n / 4)),
      randomLooking: (t, n) => (t * 7 + n * 13) % (n + 1),
    };
    for (const [name, fn] of Object.entries(policies)) {
      const { variance } = evaluatePolicy(fn);
      expect(compare(variance, minimum.variance), name).toBeGreaterThanOrEqual(0);
      expect(compare(variance, maximum.variance), name).toBeLessThanOrEqual(0);
    }
  });

  it('is strictly wider than the RUN policy at the top and equals BANK_FIRST at the bottom', () => {
    // RUN is close to the maximum but is not the maximum: trimming one organism
    // at 15 dodges the FULL BLOOM force-settle and buys a heavier tail.
    expect(compare(maximum.variance, evaluatePolicy(POLICIES.RUN.fn).variance)).toBe(1);
    expect(toFraction(minimum.variance)).toBe(
      toFraction(evaluatePolicy(POLICIES.BANK_FIRST.fn).variance),
    );
    expect(maximum.harvests.every((entry) => entry.population === BLOOM_THRESHOLD - 1)).toBe(true);
    expect(maximum.harvests.every((entry) => entry.harvest === 1)).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(() => extremalRoundVariance('sideways')).toThrow(SwarmMathError);
  });
});

describe('the value process is not monotone', () => {
  it('leaves 68/125 of rounds below the stake after the mandatory generation', () => {
    const underwater = underwaterAfterFirstGeneration();
    expect(toFraction(underwater.underwater)).toBe('68/125');
    expect(toFraction(underwater.extinct)).toBe('8/125');
    expect(toFraction(underwater.aliveBelow)).toBe('12/25');
    expect(
      toFraction(add(underwater.underwater, underwater.aboveWater)),
    ).toBe('1/1');
  });

  it('agrees with the break-even ladder', () => {
    const ladder = breakEvenLadder();
    expect(ladder).toHaveLength(MAX_GENERATIONS);
    // Three organisms is the break-even colony at generations 1 and 2, which is
    // exactly why a first generation of 1 or 2 leaves the player underwater.
    expect(ladder[0].above).toBe(3);
    expect(ladder[1].above).toBe(3);
    expect(ladder[5].above).toBe(1);
    for (const row of ladder) {
      expect(compare(multiply(row.organismValue, rat(BigInt(row.above))), ONE), row.generation)
        .toBe(1);
      if (row.above > 1)
        expect(compare(multiply(row.organismValue, rat(BigInt(row.above - 1))), ONE)).toBeLessThan(1);
    }
  });

  it('fires a split on a value-losing generation often enough to matter', () => {
    const rows = feedbackHonesty([3, 5, 8, 12, 15]);
    for (const row of rows) {
      expect(toFraction(add(add(row.falls, row.flat), row.rises)), `n=${row.population}`).toBe('1/1');
      // The joint can never exceed either marginal.
      expect(compare(row.fallsWithSplit, row.falls)).toBeLessThanOrEqual(0);
      expect(compare(row.fallsWithSplit, row.anySplit)).toBeLessThanOrEqual(0);
      expect(compare(row.fallsWithTwoSplits, row.fallsWithSplit)).toBeLessThanOrEqual(0);
    }
    // The specific figure docs/DESIGN.md §6.5 is built on.
    const eight = rows.find((row) => row.population === 8);
    expect(compare(eight.fallsWithSplit, rat(36n, 100n))).toBe(1);
    expect(compare(eight.splitGivenFalls, rat(69n, 100n))).toBe(1);
  });

  it('computes the value direction from the exact ladder step, not a threshold', () => {
    // A generation loses value exactly when 5m < 4n. Cross-check n = 4 by hand:
    // it falls for m in {0, 1, 2, 3} and rises from m = 4 upward.
    const [row] = feedbackHonesty([4]);
    let falls = ZERO;
    for (let m = 0; m <= 3; m += 1) falls = add(falls, transitionProbability(4, m));
    expect(toFraction(row.falls)).toBe(toFraction(falls));
  });
});

describe('what FULL BLOOM actually pays', () => {
  const bloom = bloomPayoutProfile();

  it('starts an order of magnitude below the headline', () => {
    expect(toFraction(bloom.smallest)).toBe(toFraction(colonyMultiplier(3, BLOOM_THRESHOLD)));
    expect(bloom.smallestGeneration).toBe(3);
    expect(bloom.smallestPopulation).toBe(BLOOM_THRESHOLD);
    expect(compare(bloom.smallest, rat(10n))).toBe(-1);
    expect(toFraction(bloom.largest)).toBe(toFraction(structuralMaxMultiplier()));
  });

  it('is mostly ordinary wins, which is why the ceremony cannot key on it', () => {
    expect(compare(bloom.shareBelow50x, rat(1n, 2n))).toBe(1);
    expect(compare(bloom.shareBelow20x, ZERO)).toBe(1);
    expect(compare(bloom.shareBelow20x, bloom.shareBelow50x)).toBe(-1);
    // Some blooms pay less than the smallest possible generation-18 settlement.
    expect(compare(bloom.shareBelowSmallestFinal, ZERO)).toBe(1);
    expect(toFraction(bloom.smallestFinal)).toBe(toFraction(colonyMultiplier(MAX_GENERATIONS, 1)));
  });

  it('matches the bloom terminal mass and the reach probability', () => {
    expect(toFraction(bloom.mass)).toBe(toFraction(terminalCategories().BLOOM));
    expect(toFraction(bloom.mass)).toBe(toFraction(reachProbability(BLOOM_THRESHOLD)));
  });

  it('separates the near-miss band from the reach probability', () => {
    const band = peakBand(12, BLOOM_THRESHOLD);
    expect(toFraction(band)).toBe(
      toFraction(subtract(reachProbability(12), reachProbability(BLOOM_THRESHOLD))),
    );
    // Strictly rarer than "reaches 12", which is the mislabelling this fixes.
    expect(compare(band, reachProbability(12))).toBe(-1);
    expect(() => peakBand(16, 12)).toThrow(SwarmMathError);
  });
});

// ---------------------------------------------------------------------------
// Round-3 additions: the model behind the presentation contracts and the two
// arithmetic claims docs/MATH.md added (§12.1 and §13.1).
// ---------------------------------------------------------------------------

describe('the maximum round payout under a population ceiling', () => {
  it('is monotone in the ceiling and bounded by the unrestricted maximum', () => {
    const unrestricted = maximumRoundPayout().multiplier;
    let previous = ZERO;
    for (let limit = 2; limit <= BLOOM_THRESHOLD; limit += 1) {
      const value = maximumRoundPayoutBelowPeak(limit);
      expect(compare(value, previous) >= 0, `limit ${limit}`).toBe(true);
      expect(compare(value, unrestricted) <= 0, `limit ${limit}`).toBe(true);
      previous = value;
    }
    // Forbidding every population makes the round worth nothing, which is the
    // degenerate end of the same recursion rather than a special case.
    expect(toFraction(maximumRoundPayoutBelowPeak(1))).toBe('0/1');
  });

  it('rejects a ceiling outside the state space', () => {
    expect(() => maximumRoundPayoutBelowPeak(0)).toThrow(SwarmMathError);
    expect(() => maximumRoundPayoutBelowPeak(MAX_POPULATION + 2)).toThrow(SwarmMathError);
    expect(() => maximumRoundPayoutBelowPeak(1.5)).toThrow(SwarmMathError);
  });
});

describe('the shared-ticket-ceiling counterfactual', () => {
  const shared = sharedCapBinding();

  it('costs the rejected design exactly', () => {
    // The four lines on equal stakes, against one 906x ceiling.
    expect(toFraction(shared.combined)).toBe(
      toFraction(add(shared.colonyMaximum, shared.sideTotal)),
    );
    expect(compare(shared.combined, shared.ceiling)).toBe(1);
    expect(toFraction(shared.shortfall)).toBe(
      toFraction(subtract(shared.combined, shared.ceiling)),
    );
  });

  it('bounds how often it would bind, rather than guessing', () => {
    // RUN cannot reach the threshold at all: its largest total is its largest
    // single settlement, which is below it.
    expect(shared.runCanBind).toBe(false);
    expect(compare(shared.runMaximum, shared.colonyThreshold)).toBe(-1);
    // The bound is a real bound: the maximum attainable below the peak really is
    // under the threshold, and the peak above it really is attainable.
    expect(compare(shared.attainableBelowPeak, shared.colonyThreshold)).toBeLessThanOrEqual(0);
    expect(
      compare(maximumRoundPayoutBelowPeak(shared.minimumPeak + 1), shared.colonyThreshold),
    ).toBe(1);
    // And it is the wild line's reach probability, which dominates the player's.
    expect(toFraction(shared.bound)).toBe(toFraction(reachProbability(shared.minimumPeak)));
    // Orders of magnitude away from the 1-in-261.89 the round-2 text quoted.
    expect(compare(shared.bound, reachProbability(10))).toBe(-1);
  });
});

describe('the stake boundary', () => {
  it('is unreachable, so a round is never exactly its own stake', () => {
    const result = stakeBoundaryIsUnreachable();
    expect(result.ok).toBe(true);
    expect(result.factor).toBe(19);
    expect(result.creditsChecked).toBe(MAX_GENERATIONS * MAX_POPULATION);
  });

  it('is what makes the two settlement classes exhaustive', () => {
    // policyOutcomeSplit uses `<= 1` for "below the stake" and `> 1` for a
    // profit; the lemma is why those two are a partition with no ambiguous case.
    for (const policy of Object.values(POLICIES)) {
      const split = policyOutcomeSplit(policy.fn);
      const total = add(add(split.zero, split.subStake), split.profit);
      expect(toFraction(total), policy.id).toBe('1/1');
    }
  });
});

describe('presentation contracts', () => {
  it('counts one verdict beat per non-terminal generation', () => {
    const beats = verdictBeats();
    const mass = verdictBeatMass(beats);
    // Every beat is non-terminal by construction: 1 <= m <= 15 and t < 18.
    for (const beat of beats) {
      expect(beat.to).toBeGreaterThanOrEqual(1);
      expect(beat.to).toBeLessThan(BLOOM_THRESHOLD);
      expect(beat.generation).toBeLessThan(MAX_GENERATIONS);
    }
    // A RUN round has one terminal generation, so the beats are the expected
    // round length minus one. That identity is a real cross-check on both.
    expect(toFraction(mass)).toBe(toFraction(subtract(expectedGenerations(), ONE)));
  });

  it('bands the beats exhaustively and monotonically', () => {
    const bands = verdictBands();
    const total = bands.reduce((sum, row) => add(sum, row.share), ZERO);
    expect(toFraction(total)).toBe('1/1');
    for (const row of bands) expect(compare(row.share, ZERO)).toBe(1);
  });

  it('proves every chord note reachable, with a strictly decreasing frequency', () => {
    const ladder = chordLadder();
    expect(ladder).toHaveLength(CHORD_STEPS);
    for (const note of ladder) {
      expect(compare(note.mass, ZERO), `note +${note.step}`).toBe(1);
      expect(note.reachable, `note +${note.step}`).toBeGreaterThan(0);
      expect(toFraction(note.threshold)).toBe(toFraction(chordThreshold(note.step)));
    }
    for (let index = 1; index < ladder.length; index += 1)
      expect(compare(ladder[index].share, ladder[index - 1].share)).toBe(-1);
    expect(() => chordThreshold(CHORD_STEPS)).toThrow(SwarmMathError);
    expect(() => chordThreshold(-1)).toThrow(SwarmMathError);
  });

  it('opens the large-gain band at every population, which the ratio bands did not', () => {
    // Reproduce the round-2 failure directly: under a ratio band, "more than
    // +50%" needs m > 1.2n, and at n = 13, 14, 15 every such m is FULL BLOOM.
    const kernel = buildKernel();
    for (const population of [13, 14, 15]) {
      const row = kernel[population];
      let reachable = 0n;
      for (let m = 1; m < Math.min(BLOOM_THRESHOLD, row.length); m += 1)
        if (5 * m > 6 * population) reachable += row[m];
      expect(reachable, `ratio band at n=${population}`).toBe(0n);
    }
    // Under the money band it is reachable everywhere, at every population.
    for (const row of verdictReach()) {
      expect(row.firstMedusaGeneration, `n=${row.population}`).toBeGreaterThan(0);
      expect(compare(row.bestDelta, MEDUSA_THRESHOLD), `n=${row.population}`).toBe(1);
    }
  });

  it('splits every policy settlement into three exhaustive classes', () => {
    for (const row of settlementClasses()) {
      const total = add(add(row.nothing, row.belowStake), row.profit);
      expect(toFraction(total), row.id).toBe('1/1');
    }
    const bankFirst = settlementClasses().find((row) => row.id === 'BANK_FIRST');
    expect(toFraction(bankFirst.belowStake)).toBe('12/25');
  });

  it('clamps the body radius at both ends and puts the spiral on distinct radii', () => {
    const layout = colonyLayout();
    expect(layout.firstClampedPopulation).toBe(17);
    expect(toFraction(bodyRadius(17).radius)).toBe('12/1');
    expect(toFraction(bodyRadius(17).raw)).toBe('58/5');
    expect(bodyRadius(17).clamped).toBe(true);
    expect(bodyRadius(16).clamped).toBe(false);
    expect(bodyRadius(1).clamped).toBe(true);
    expect(() => bodyRadius(0)).toThrow(SwarmMathError);
    expect(() => bodyRadius(MAX_POPULATION + 1)).toThrow(SwarmMathError);
    // R(n) is strictly increasing, so a bigger colony never occupies less space.
    let previous = 0;
    for (let population = 1; population <= MAX_POPULATION; population += 1) {
      const radius = Number(layoutRadiusDecimal(population));
      expect(radius, `n=${population}`).toBeGreaterThan(previous);
      previous = radius;
    }
  });
});
