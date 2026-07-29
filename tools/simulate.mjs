#!/usr/bin/env node
/**
 * SWARM — seeded Monte Carlo cross-check and reference draw derivation.
 *
 * This is NOT the source of any published number: `tools/enumerate.mjs` is.
 * This script exists for two reasons.
 *
 *   1. It is an executable reference implementation of the draw derivation and
 *      commit-reveal scheme specified in docs/ENGINE.md — length-prefixed
 *      canonical encoding, domain-separated HMAC-SHA256, exact rejection
 *      sampling. Anything that claims to verify a SWARM round must reproduce
 *      these bytes.
 *   2. It is an independent sanity cross-check: if the enumeration and a
 *      straight simulation of the written rules disagree, one of them is wrong.
 *
 * Everything here is deterministic given `--seed`, so a CI failure is
 * reproducible rather than flaky.
 *
 * Usage:
 *   node tools/simulate.mjs [--rounds 20000] [--seed <64 hex chars>] [--policy RUN]
 */

import { createHash, createHmac } from 'node:crypto';
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  BLOOM_THRESHOLD,
  COHORT_MODEL_VERSION,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  LADDER_BASE,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MODULE_API,
  MU,
  OFFSPRING,
  SEED_COUNT,
  SIDE_BET_MAX_WIN_MULTIPLES,
  TARGET_RTP,
  organismValue,
  ticketExposureUnits,
} from './lib/config.mjs';
import { POLICIES, payableUnits, sideBets } from './lib/model.mjs';
import { ONE, add, divide, multiply, rat, toDecimal, toFraction, ZERO } from './lib/rational.mjs';

export const COMMITMENT_VERSION = 'reveal-engine/stage-commit-v1';
export const DRAW_LABEL = 'swarm-organism';
const SLOTS = BLOOM_THRESHOLD - 1;

function lengthPrefix(length) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

/** Unambiguous typed framing, byte-identical to Reveal Engine `encodeFields`. */
export function encodeFields(fields) {
  const encoded = fields.map((field) => {
    if (typeof field === 'bigint') return Buffer.from(field.toString(10), 'ascii');
    if (typeof field === 'number') {
      if (!Number.isSafeInteger(field)) throw new Error('Canonical number is not safe');
      return Buffer.from(String(field), 'ascii');
    }
    return typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field);
  });
  return Buffer.concat([
    lengthPrefix(encoded.length),
    ...encoded.flatMap((part) => [lengthPrefix(part.length), part]),
  ]);
}

export function normalizeSeed(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/iu.test(seedHex))
    throw new Error('Seed must be exactly 32 bytes of hexadecimal');
  return seedHex.toLowerCase();
}

/**
 * Adapter fingerprint, exactly the field set docs/ENGINE.md section 2 declares:
 * module API, adapter id and version, cohort model version, draw modulus, every
 * outcome band in order, seed units, stage count, both thresholds, ladder base
 * and step, target RTP, rounding mode, the colony cap, and every side-bet line
 * with its own cap in declaration order.
 *
 * Any change to the economics changes this value, and the value is bound into
 * the commitment, so a transcript can only be verified against the adapter it
 * was produced under.
 */
export function adapterFingerprint() {
  const step = divide(ONE, MU);
  const fields = [MODULE_API, ADAPTER_ID, ADAPTER_VERSION, COHORT_MODEL_VERSION, DRAW_MODULUS];
  for (const outcome of OFFSPRING) fields.push(outcome.id, outcome.children, outcome.weight);
  fields.push(
    SEED_COUNT,
    MAX_GENERATIONS,
    BLOOM_THRESHOLD,
    MAX_POPULATION,
    LADDER_BASE.numerator,
    LADDER_BASE.denominator,
    step.numerator,
    step.denominator,
    TARGET_RTP.numerator,
    TARGET_RTP.denominator,
    'floor',
    COLONY_MAX_WIN_MULTIPLE,
  );
  for (const [id, cap] of Object.entries(SIDE_BET_MAX_WIN_MULTIPLES)) fields.push(id, cap);
  return createHash('sha256').update(encodeFields(fields)).digest('hex');
}

/** Commitment published before the round: binds seed, round, adapter identity and grid shape. */
export function commitment(seedHex, roundId) {
  const seed = normalizeSeed(seedHex);
  return createHash('sha256')
    .update(
      encodeFields([
        'Axiom Games SWARM commitment',
        COMMITMENT_VERSION,
        Buffer.from(seed, 'hex'),
        ADAPTER_ID,
        ADAPTER_VERSION,
        adapterFingerprint(),
        roundId,
        MAX_GENERATIONS,
        SLOTS,
        DRAW_MODULUS,
      ]),
    )
    .digest('hex');
}

const RANGE = 1n << 256n;

/** Exact uniform value in [0, modulus) by domain-separated rejection sampling. */
export function uniformBigInt(seedHex, roundId, label, counter, modulus) {
  const seed = normalizeSeed(seedHex);
  if (typeof modulus !== 'bigint' || modulus <= 0n || modulus >= RANGE)
    throw new Error('Modulus must be in [1, 2^256)');
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Counter must be a safe index');
  const limit = RANGE - (RANGE % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = encodeFields([
      'sampler',
      COMMITMENT_VERSION,
      ADAPTER_ID,
      roundId,
      label,
      counter,
      nonce,
      modulus,
    ]);
    const value = BigInt(
      `0x${createHmac('sha256', Buffer.from(seed, 'hex')).update(payload).digest('hex')}`,
    );
    if (value < limit) return value % modulus;
  }
}

/** Draw index of slot `slot` (1-based) in generation `generation` (1-based). */
export function drawIndex(generation, slot) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATIONS)
    throw new Error('Generation out of range');
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > SLOTS) throw new Error('Slot out of range');
  return (generation - 1) * SLOTS + (slot - 1);
}

const BANDS = OFFSPRING.map((outcome) => ({ id: outcome.id, children: outcome.children, high: outcome.highDraw }));

/** Maps a draw in [0, DRAW_MODULUS) to an offspring count. */
export function resolveDraw(draw) {
  for (const band of BANDS) if (draw <= band.high) return band;
  throw new Error('Draw outside the declared bands');
}

/**
 * Plays one round of SWARM against a committed seed under a Markov policy.
 * Returns the exact total payout as a multiple of the stake, plus a trace.
 */
export function playRound(seedHex, roundId, policy) {
  let population = SEED_COUNT;
  let total = ZERO;
  const trace = [];
  for (let generation = 1; generation <= MAX_GENERATIONS; generation += 1) {
    let next = 0;
    for (let slot = 1; slot <= population; slot += 1) {
      const draw = uniformBigInt(seedHex, roundId, DRAW_LABEL, drawIndex(generation, slot), DRAW_MODULUS);
      next += resolveDraw(draw).children;
    }
    population = next;
    trace.push({ generation, population });
    if (population === 0) return { total, population, generation, reason: 'EXTINCT', trace };
    if (population >= BLOOM_THRESHOLD) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(population))));
      return { total, population, generation, reason: 'BLOOM', trace };
    }
    if (generation === MAX_GENERATIONS) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(population))));
      return { total, population, generation, reason: 'FINAL', trace };
    }
    const harvest = policy(generation, population);
    if (!Number.isSafeInteger(harvest) || harvest < 0 || harvest > population)
      throw new Error('Policy returned an illegal harvest');
    if (harvest > 0) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(harvest))));
      population -= harvest;
      trace[trace.length - 1].harvest = harvest;
      if (population === 0) return { total, population, generation, reason: 'BANKED', trace };
    }
  }
  throw new Error('Round escaped the generation bound');
}

/**
 * The wild line: the same committed grid replayed with an empty action log.
 * Every side bet resolves on this and nothing else, which is why no decision can
 * move one. Derived only at settlement — see docs/MATH.md §7.3 for why revealing
 * it earlier would leak future draws into a live decision.
 */
export function wildLine(seedHex, roundId) {
  const run = playRound(seedHex, roundId, POLICIES.RUN.fn);
  const populations = run.trace.map((entry) => entry.population);
  let peak = SEED_COUNT;
  for (const population of populations) if (population > peak) peak = population;
  const extinctIndex = populations.indexOf(0);
  return {
    populations,
    peak,
    terminal: run.reason,
    extinctGeneration: extinctIndex === -1 ? null : extinctIndex + 1,
  };
}

/** Resolves all three side bets against the wild line. Pure function of the grid. */
export function resolveSideBets(seedHex, roundId) {
  const line = wildLine(seedHex, roundId);
  const won = {
    FIRST_LIGHT: (line.populations[0] ?? 0) >= 4,
    DARK_VENT: line.extinctGeneration !== null && line.extinctGeneration <= 3,
    SWARM: line.peak >= 10,
  };
  return sideBets().map((bet) => ({
    id: bet.id,
    multiplier: bet.multiplier,
    capMultiple: bet.capMultiple,
    won: won[bet.id],
  }));
}

/**
 * Reference money path for a whole ticket: one COLONY bet plus any side bets,
 * each with its own stake, its own cap basis and its own ledger lines.
 *
 * This exists because a paytable with no money path is not a specification. It
 * is the executable form of docs/ENGINE.md §5.3: every movement is a receipt,
 * every receipt names its line, and the cap is applied per line with that line's
 * own stake as the basis.
 */
export function settleTicket({ seedHex, roundId, stakeUnits, sideBetStakes = {}, policy }) {
  const exposure = ticketExposureUnits(stakeUnits, sideBetStakes);
  const receipts = [];
  let sequence = 0;
  const push = (receipt) => {
    sequence += 1;
    receipts.push({ sequence, ...receipt });
  };

  push({
    kind: 'OPEN',
    line: 'COLONY',
    direction: 'DEBIT',
    stage: 0,
    amountUnits: stakeUnits,
    theoretical: null,
    capped: false,
  });
  for (const [id, amount] of Object.entries(sideBetStakes))
    push({
      kind: 'OPEN',
      line: id,
      direction: 'DEBIT',
      stage: 0,
      amountUnits: amount,
      theoretical: null,
      capped: false,
    });

  const round = playRound(seedHex, roundId, policy);
  let colonyCredited = 0n;
  for (const entry of round.trace) {
    if (!entry.harvest) continue;
    const multiplier = multiply(organismValue(entry.generation), rat(BigInt(entry.harvest)));
    const payable = payableUnits(stakeUnits, multiplier, colonyCredited, COLONY_MAX_WIN_MULTIPLE);
    colonyCredited += payable.credited;
    push({
      kind: 'HARVEST',
      line: 'COLONY',
      direction: 'CREDIT',
      stage: entry.generation,
      unitsHarvested: entry.harvest,
      amountUnits: payable.credited,
      theoretical: payable.theoretical,
      capped: payable.capped,
    });
  }
  const settlementMultiplier =
    round.reason === 'BLOOM' || round.reason === 'FINAL'
      ? multiply(organismValue(round.generation), rat(BigInt(round.population)))
      : ZERO;
  const settlement = payableUnits(
    stakeUnits,
    settlementMultiplier,
    colonyCredited,
    COLONY_MAX_WIN_MULTIPLE,
  );
  colonyCredited += settlement.credited;
  push({
    kind: 'SETTLE',
    line: 'COLONY',
    direction: 'CREDIT',
    stage: round.generation,
    terminal: round.reason,
    amountUnits: settlement.credited,
    theoretical: settlement.theoretical,
    capped: settlement.capped,
  });

  // Side bets resolve only now, after the base round has reached a terminal.
  for (const bet of resolveSideBets(seedHex, roundId)) {
    const stake = sideBetStakes[bet.id];
    if (stake === undefined) continue;
    const payable = bet.won
      ? payableUnits(stake, bet.multiplier, 0n, bet.capMultiple)
      : { theoretical: ZERO, credited: 0n, capped: false };
    push({
      kind: 'SIDE_BET',
      line: bet.id,
      direction: 'CREDIT',
      stage: MAX_GENERATIONS,
      resolved: bet.won ? 'WON' : 'LOST',
      amountUnits: payable.credited,
      theoretical: payable.theoretical,
      capped: payable.capped,
    });
  }

  const creditedUnits = receipts
    .filter((receipt) => receipt.direction === 'CREDIT')
    .reduce((total, receipt) => total + receipt.amountUnits, 0n);
  const stakedUnits = receipts
    .filter((receipt) => receipt.direction === 'DEBIT')
    .reduce((total, receipt) => total + receipt.amountUnits, 0n);
  if (receipts.some((receipt) => receipt.capped))
    throw new Error('A cap truncated a credit, which the risk policy proves impossible');
  if (creditedUnits > exposure)
    throw new Error('Ticket credited more than its disclosed worst-case exposure');
  return { receipts, creditedUnits, stakedUnits, exposureUnits: exposure, round };
}

function seedFor(masterSeed, index) {
  return createHash('sha256')
    .update(encodeFields(['swarm-simulation-seed', masterSeed, index]))
    .digest('hex');
}

function parseArgs(argv) {
  const options = {
    rounds: 20000,
    seed: '00'.repeat(31) + '2a',
    policy: 'RUN',
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--rounds') options.rounds = Number(argv[(index += 1)]);
    else if (argv[index] === '--seed') options.seed = argv[(index += 1)];
    else if (argv[index] === '--policy') options.policy = argv[(index += 1)];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1 || options.rounds > 5000000)
    throw new Error('rounds out of range');
  normalizeSeed(options.seed);
  return options;
}

/** Runs `rounds` deterministic rounds and returns exact aggregate statistics. */
export function simulate({ rounds, seed, policy }) {
  const chosen = Object.hasOwn(POLICIES, policy) ? POLICIES[policy] : undefined;
  if (!chosen) throw new Error(`Unknown policy ${policy}`);
  normalizeSeed(seed);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5000000)
    throw new Error('rounds out of range');
  let total = ZERO;
  let wins = 0;
  let profits = 0;
  let extinct = 0;
  let bloom = 0;
  let generations = 0;
  let gen1Extinct = 0;
  const sideBetWins = { FIRST_LIGHT: 0, DARK_VENT: 0, SWARM: 0 };
  for (let index = 0; index < rounds; index += 1) {
    const roundSeed = seedFor(seed, index);
    const roundId = `sim-${index}`;
    // The wild line is always derived, because side bets resolve on it and on
    // nothing else. When the policy is RUN the two coincide exactly.
    const wild = chosen.id === 'RUN' ? null : playRound(roundSeed, roundId, POLICIES.RUN.fn);
    const result = playRound(roundSeed, roundId, chosen.fn);
    const line = wild ?? result;
    const populations = line.trace.map((entry) => entry.population);
    const peak = populations.reduce((best, value) => (value > best ? value : best), SEED_COUNT);
    const extinctIndex = populations.indexOf(0);
    if ((populations[0] ?? 0) >= 4) sideBetWins.FIRST_LIGHT += 1;
    if (extinctIndex !== -1 && extinctIndex + 1 <= 3) sideBetWins.DARK_VENT += 1;
    if (peak >= 10) sideBetWins.SWARM += 1;

    total = add(total, result.total);
    generations += result.generation;
    if (result.total.numerator > 0n) wins += 1;
    if (result.total.numerator > result.total.denominator) profits += 1;
    if (result.reason === 'EXTINCT') {
      extinct += 1;
      if (result.generation === 1) gen1Extinct += 1;
    }
    if (result.reason === 'BLOOM') bloom += 1;
  }
  return {
    rounds,
    policy: chosen.id,
    empiricalRtp: multiply(total, rat(1n, BigInt(rounds))),
    hitRate: rat(BigInt(wins), BigInt(rounds)),
    profitRate: rat(BigInt(profits), BigInt(rounds)),
    extinctionRate: rat(BigInt(extinct), BigInt(rounds)),
    generationOneExtinctionRate: rat(BigInt(gen1Extinct), BigInt(rounds)),
    bloomCount: bloom,
    meanGenerations: rat(BigInt(generations), BigInt(rounds)),
    sideBetRates: Object.fromEntries(
      Object.entries(sideBetWins).map(([id, count]) => [id, rat(BigInt(count), BigInt(rounds))]),
    ),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = process.hrtime.bigint();
  const result = simulate(options);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log('SWARM — seeded Monte Carlo cross-check (sanity only; the enumeration is the proof)');
  console.log(`  policy                 : ${result.policy}`);
  console.log(`  rounds                 : ${result.rounds}`);
  console.log(`  master seed            : ${options.seed}`);
  console.log(`  empirical RTP          : ${toDecimal(result.empiricalRtp, 6)}   (exact target 19/20 = 0.95)`);
  console.log(`  hit rate P(>0)         : ${toDecimal(result.hitRate, 6)}`);
  console.log(`  profit rate P(>stake)  : ${toDecimal(result.profitRate, 6)}`);
  console.log(`  generation-1 extinction: ${toDecimal(result.generationOneExtinctionRate, 6)}   (exact 8/125 = 0.064)`);
  console.log(`  mean generations       : ${toDecimal(result.meanGenerations, 4)}`);
  console.log(`  FULL BLOOM rounds      : ${result.bloomCount}`);
  for (const bet of sideBets())
    console.log(
      `  side bet ${bet.id.padEnd(12)}: empirical ${toDecimal(result.sideBetRates[bet.id], 6)}   exact ${toDecimal(bet.probability, 6)}`,
    );
  console.log(`  elapsed                : ${elapsedMs.toFixed(0)} ms`);
  console.log(`  adapter fingerprint    : ${adapterFingerprint()}`);
  console.log(`  commitment sample      : ${commitment(seedFor(options.seed, 0), 'sim-0')}`);
  console.log(`  exact empirical RTP    : ${toFraction(result.empiricalRtp)}`);

  // One fully-worked ticket, so the money path is visible and not just described.
  const example = settleTicket({
    seedHex: seedFor(options.seed, 0),
    roundId: 'sim-0',
    stakeUnits: 1000000n,
    sideBetStakes: { FIRST_LIGHT: 500000n, SWARM: 200000n },
    policy: POLICIES.HALF_EVERY.fn,
  });
  console.log('\n  example ticket ledger (1.00 colony, 0.50 FIRST LIGHT, 0.20 SWARM, HALF_EVERY)');
  for (const receipt of example.receipts)
    console.log(
      `    #${receipt.sequence} ${receipt.kind.padEnd(8)} ${receipt.line.padEnd(11)} ${receipt.direction.padEnd(6)} ${String(receipt.amountUnits).padStart(10)} units${receipt.resolved ? `  ${receipt.resolved}` : ''}`,
    );
  console.log(
    `    staked ${example.stakedUnits} units, credited ${example.creditedUnits} units, worst-case exposure ${example.exposureUnits} units`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
