import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, parseFixture } from '../tools/lib/canonical.mjs';
import { buildPaytable } from '../tools/lib/report.mjs';
import { SwarmMathError } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = `${root}spec/paytable.v3.json`;
const frozen = readFileSync(fixturePath, 'utf8');
const rendered = canonicalJson(buildPaytable());

describe('frozen paytable fixture', () => {
  it('is byte-identical to a fresh enumeration', () => {
    expect(rendered).toBe(frozen);
  });

  it('matches the digest published in docs/MATH.md', () => {
    const math = readFileSync(`${root}docs/MATH.md`, 'utf8');
    const fingerprint = digest(frozen);
    expect(math).toContain(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('carries no floating point anywhere', () => {
    // Canonical JSON only ever emits strings, booleans and safe integers.
    const walk = (value, path = '$') => {
      if (typeof value === 'number') {
        expect(Number.isSafeInteger(value), `${path} is not an integer`).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (value && typeof value === 'object')
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
    };
    walk(parseFixture(frozen));
  });

  it('has sorted keys at every level', () => {
    const walk = (value) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        expect(keys).toEqual([...keys].sort());
        Object.values(value).forEach(walk);
      }
    };
    walk(JSON.parse(frozen));
  });

  it('states the risk policy it was generated under', () => {
    const fixture = parseFixture(frozen);
    expect(fixture.schema).toBe('swarm/paytable-v3');
    expect(fixture.adapterId).toBe('swarm-colony-v1');
    expect(fixture.adapterVersion).toBe('1.3.0');
    expect(fixture.totals.rtp).toBe('19/20');
    expect(fixture.totals.probabilityMass).toBe('1/1');
    expect(fixture.proof.ok).toBe(true);
    expect(fixture.proof.failures).toBe(0);
    expect(fixture.roundMaximum.capBinds).toBe(false);
  });

  it('records one cap basis per bet line, none of them binding', () => {
    const fixture = parseFixture(frozen);
    expect(fixture.risk.lines.map((line) => line.line)).toEqual([
      'COLONY',
      'FIRST_LIGHT',
      'DARK_VENT',
      'SWARM',
    ]);
    for (const line of fixture.risk.lines) {
      expect(line.binds, line.line).toBe(false);
      // Headroom is published as a positive decimal, so a shrinking cap shows up
      // in the fixture diff rather than only in a thrown error.
      expect(line.headroom.startsWith('-'), line.line).toBe(false);
      expect(Number(line.headroom), line.line).toBeGreaterThan(0);
    }
    expect(fixture.risk.ticket.binds).toBe(false);
    expect(BigInt(fixture.risk.ticket.worstCaseExposureUnits)).toBeLessThan(
      BigInt(fixture.risk.ticket.admissionLimitUnits),
    );
  });

  it('publishes a profit rate next to every hit rate', () => {
    const fixture = parseFixture(frozen);
    for (const policy of fixture.policies) {
      expect(policy.profitRate, policy.id).toMatch(/^\d\.\d+$/u);
      // A hit is anything above zero, a profit is anything above the stake, so
      // the profit rate can never exceed the hit rate.
      expect(Number(policy.profitRate), policy.id).toBeLessThanOrEqual(Number(policy.hitRate));
    }
    const bankFirst = fixture.policies.find((policy) => policy.id === 'BANK_FIRST');
    expect(bankFirst.hitRate).toBe('0.9360000000');
    expect(bankFirst.profitRate).toBe('0.4560000000');
  });

  it('records the proof surface the transcript was produced under', () => {
    const fixture = parseFixture(frozen);
    expect(fixture.proofSurface).toEqual({
      seedCommitmentVersion: 'reveal-engine/stage-seed-commit-v1',
      bodyCommitmentVersion: 'reveal-engine/stage-body-commit-v2',
      samplerDomain: 'reveal-engine/stage-draw-v2',
      clientEntropyBytes: 32,
      harvestQuantum: 'any',
      harvestCommitsPerStage: 1,
      maximumActionLogEntries: 17,
    });
  });

  it('publishes a FULL BLOOM frequency for every policy, including the zeros', () => {
    // BLOCKER: the bloom frequency was published unqualified, and it is exactly
    // zero for the harvest the client makes the one-tap default.
    const fixture = parseFixture(frozen);
    for (const policy of fixture.policies) {
      expect(policy.terminals, policy.id).toBeDefined();
      const mass = ['EXTINCT', 'BLOOM', 'FINAL', 'BANKED'].map((key) => policy.terminals[key]);
      expect(mass.every((value) => /^\d+\/\d+$/u.test(value)), policy.id).toBe(true);
      expect(policy.bloomOneIn, policy.id).toBeDefined();
    }
    const half = fixture.policies.find((policy) => policy.id === 'HALF_EVERY');
    const run = fixture.policies.find((policy) => policy.id === 'RUN');
    expect(half.terminals.BLOOM).toBe('0/1');
    expect(half.bloomOneIn).toBe('never');
    expect(run.terminals.BLOOM).not.toBe('0/1');
    expect(run.bloomOneIn).toBe('22217.97');
  });

  it('publishes a ticket-level profit rate for every flagged pairing', () => {
    // MAJOR: §9.3 makes the profit rate the binding figure and no profit rate
    // existed for a ticket with more than one line.
    const fixture = parseFixture(frozen);
    expect(fixture.ticketPairings).toHaveLength(9);
    for (const row of fixture.ticketPairings) {
      expect(row.lines).toBe(2);
      expect(row.ticketRtp, `${row.policy}/${row.sideBet}`).toBe('19/20');
      expect(row.ticketProfitRate).toMatch(/^\d\.\d+$/u);
      expect(Number(row.ticketProfitRate)).toBeGreaterThan(0);
      expect(Number(row.ticketProfitRate)).toBeLessThan(1);
    }
    // The pairing the design flags, in both directions: DARK VENT cuts the
    // profit rate for a player who banks at once and raises it for one who runs.
    const banked = fixture.ticketPairings.find(
      (row) => row.policy === 'BANK_FIRST' && row.sideBet === 'DARK_VENT',
    );
    const run = fixture.ticketPairings.find(
      (row) => row.policy === 'RUN' && row.sideBet === 'DARK_VENT',
    );
    expect(banked.ticketProfitRate).toBe('0.3608881499');
    expect(banked.colonyOnlyProfitRate).toBe('0.4560000000');
    expect(banked.profitRateChange.startsWith('-')).toBe(true);
    expect(run.ticketProfitRate).toBe('0.3756956796');
    expect(run.profitRateChange.startsWith('-')).toBe(false);
  });

  it('derives the floor-rounding bound instead of asserting it', () => {
    // BLOCKER: §13's "absolute bound" was the generation count, hard-coded, and
    // it was only true because of a protocol rule nothing enforced.
    const fixture = parseFixture(frozen);
    const bound = fixture.roundingBound;
    expect(bound.harvestCommitsPerStage).toBe(1);
    expect(bound.maximumCreditEvents).toBe(18);
    expect(bound.maximumCreditEventsIfStagesAcceptedRepeatedHarvests).toBe(117);
    expect(bound.maximumCreditEventsIfStagesAcceptedRepeatedHarvests).toBeGreaterThan(
      bound.maximumCreditEvents,
    );
    expect(bound.maximumLossUnits).toBe('18');
    expect(bound.relativeAtMinimumStakePercentagePoints).toBe('0.018000');
  });

  it('prices the environment reveal on value, and says how often it fires', () => {
    // MAJOR: the reveal was sold as a consequence of the exposure curve and
    // keyed to a population event, which the exposure curve cannot distinguish.
    const fixture = parseFixture(frozen);
    const environment = fixture.presentation.environment;
    expect(environment.threshold).toBe('475/48');
    expect(environment.thresholdPopulation).toBe(16);
    const run = environment.policies.find((row) => row.policy === 'RUN');
    const bloom = fixture.policies.find((policy) => policy.id === 'RUN');
    // Every bloom is at least this rich, so the reveal can never be rarer.
    expect(Number(run.reach)).toBeGreaterThan(Number(bloom.bloomProbability));
    expect(Number(run.timesMoreCommonThanBloom)).toBeGreaterThan(100);
    for (const row of environment.policies)
      expect(Number(row.reach), row.policy).toBeGreaterThanOrEqual(Number(row.bloom));
  });
});

// ---------------------------------------------------------------------------
// The presentation contracts. Round 2 shipped these as hand-written prose and
// one of them — an audio band unreachable at populations 13, 14 and 15 — was
// wrong precisely because no test could see it. They are enumerated now.
// ---------------------------------------------------------------------------
describe('presentation contracts are reachable, not just written down', () => {
  const fixture = parseFixture(frozen);

  it('gives every chord note a reachable state and a positive frequency', () => {
    const { ladder } = fixture.presentation.chord;
    expect(ladder).toHaveLength(fixture.presentation.chord.steps);
    for (const note of ladder) {
      expect(note.reachableStates, `note +${note.step}`).toBeGreaterThan(0);
      expect(Number(note.share), `note +${note.step}`).toBeGreaterThan(0);
      expect(note.earliestGeneration, `note +${note.step}`).toBeGreaterThan(0);
    }
    // Monotone: a louder note is a rarer note, which is rule R4 in DESIGN §6.5.
    for (let index = 1; index < ladder.length; index += 1)
      expect(Number(ladder[index].share)).toBeLessThan(Number(ladder[index - 1].share));
    // The top note is real but rare: about one round in seventy.
    expect(Number(ladder.at(-1).share)).toBeLessThan(0.01);
  });

  it('opens the large-gain band at every live population', () => {
    // The exact failure of the round-2 ratio bands: at n = 13, 14 and 15 the top
    // band had probability zero, because every qualifying outcome was FULL BLOOM.
    expect(fixture.presentation.reach).toHaveLength(15);
    for (const row of fixture.presentation.reach) {
      expect(row.firstLargeGainGeneration, `n=${row.population}`).toBeGreaterThan(0);
      expect(Number(row.bestDelta), `n=${row.population}`).toBeGreaterThan(1);
    }
  });

  it('partitions verdict beats into bands that sum to one', () => {
    const bands = fixture.presentation.verdict.bands;
    expect(bands.map((row) => row.band)).toEqual([
      'HEAVY_LOSS',
      'LOSS',
      'FLAT',
      'GAIN',
      'LARGE_GAIN',
    ]);
    const total = bands.reduce((sum, row) => sum + Number(row.share), 0);
    expect(total).toBeCloseTo(1, 6);
    // Losses are not a rounding error: they are more than a third of all beats,
    // which is why DESIGN §6.5 R3 gives them a channel.
    const losses = Number(bands[0].share) + Number(bands[1].share);
    expect(losses).toBeGreaterThan(0.35);
  });

  it('publishes how often a round returns less than the stake, per policy', () => {
    // The round-2 settlement ceremony gave this class the same treatment as a
    // win. It is the most common class in the game under two of eight policies.
    const settlement = fixture.presentation.settlement;
    expect(settlement).toHaveLength(fixture.policies.length);
    for (const row of settlement) {
      const total = Number(row.nothing) + Number(row.belowStake) + Number(row.profit);
      expect(total, row.id).toBeCloseTo(1, 8);
    }
    const bankFirst = settlement.find((row) => row.id === 'BANK_FIRST');
    const halfEvery = settlement.find((row) => row.id === 'HALF_EVERY');
    const panic = settlement.find((row) => row.id === 'PANIC');
    expect(bankFirst.belowStake).toBe('0.4800000000');
    expect(halfEvery.belowStake).toBe('0.5004286344');
    expect(panic.belowStake).toBe('0.7189429463');
    // Under both policies a new player is likeliest to use, returning less than
    // the stake is more common than profiting.
    expect(Number(bankFirst.belowStake)).toBeGreaterThan(Number(bankFirst.profit));
    expect(Number(halfEvery.belowStake)).toBeGreaterThan(Number(halfEvery.profit));
  });

  it('states exactly where the body-radius clamp bites', () => {
    const { layout } = fixture.presentation;
    expect(layout.firstClampedPopulation).toBe(17);
    const clamped = layout.rows.find((row) => row.population === 17);
    expect(clamped.clamped).toBe(true);
    expect(clamped.bodyRadius).toBe('12.00');
    expect(clamped.bodyRadiusRaw).toBe('11.60');
    const unclamped = layout.rows.find((row) => row.population === 16);
    expect(unclamped.clamped).toBe(false);
    expect(unclamped.bodyRadius).toBe('13.20');
    // Phyllotaxis: the outermost body sits at R(n) and the innermost strictly
    // inside it for every colony larger than one, which a single radius cannot do.
    for (const row of layout.rows)
      if (row.population > 1)
        expect(Number(row.innermostRadius), `n=${row.population}`).toBeLessThan(
          Number(row.layoutRadius),
        );
  });

  it('costs the rejected shared ticket ceiling exactly, and bounds how often it would bite', () => {
    const shared = fixture.risk.sharedCeilingCounterfactual;
    expect(shared.combinedMaximumDecimal).toBe('1162.014446');
    expect(shared.shortfallDecimal).toBe('256.014446');
    expect(shared.colonyThresholdDecimal).toBe('649.762047');
    // RUN cannot reach the threshold at all, so the frequency is not a tail
    // event of RUN; the round-2 text quoted P(SWARM wins) here by mistake.
    expect(shared.runCanBind).toBe(false);
    expect(Number(shared.runMaximumDecimal)).toBeLessThan(Number(shared.colonyThresholdDecimal));
    expect(Number(shared.attainableBelowPeakDecimal)).toBeLessThan(
      Number(shared.colonyThresholdDecimal),
    );
    expect(shared.minimumPeakPopulation).toBe(14);
    expect(shared.bindingProbabilityBound).toBe('1.96449e-04');
  });

  it('proves no round can settle at exactly one stake', () => {
    expect(fixture.stakeBoundary.exactlyOneStakeIsReachable).toBe(false);
    expect(fixture.stakeBoundary.factor).toBe(19);
    expect(fixture.stakeBoundary.creditsChecked).toBe(540);
  });
});

describe('canonical serialization is hostile-input safe', () => {
  it('refuses floats', () => {
    expect(() => canonicalJson({ value: 0.1 })).toThrow(SwarmMathError);
  });

  it('refuses non-plain objects', () => {
    expect(() => canonicalJson({ when: new Date() })).toThrow(SwarmMathError);
    expect(() => canonicalJson({ pattern: /x/u })).toThrow(SwarmMathError);
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(SwarmMathError);
  });

  it('refuses reserved keys', () => {
    const payload = {};
    Object.defineProperty(payload, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(() => canonicalJson(payload)).toThrow(/reserved key/u);
  });

  it('serializes BigInt as a decimal string', () => {
    expect(canonicalJson({ a: 10n ** 30n })).toContain('"1000000000000000000000000000000"');
  });

  it('rejects oversized and malformed fixtures on parse', () => {
    expect(() => parseFixture('{}', 1)).toThrow(/size bound/u);
    expect(() => parseFixture('[]')).toThrow(/root must be an object/u);
    expect(() => parseFixture(42)).toThrow(SwarmMathError);
    expect(() => parseFixture('{"__proto__": {"polluted": true}}')).toThrow(/reserved key/u);
    expect(() => parseFixture('{ not json')).toThrow(SyntaxError);
  });

  it('does not pollute Object.prototype when parsing', () => {
    try {
      parseFixture('{"__proto__": {"polluted": true}}');
    } catch {
      /* expected */
    }
    expect({}.polluted).toBeUndefined();
  });

  // Two full re-enumerations of the whole state space, deliberately: the claim
  // under test is that the canonical bytes are a function of the model and of
  // nothing else, so a cached render would not test anything.
  it('is stable across repeated renders', () => {
    expect(canonicalJson(buildPaytable())).toBe(rendered);
    expect(digest(rendered)).toBe(digest(canonicalJson(buildPaytable())));
  }, 300000);
});
