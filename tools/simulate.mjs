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
  DRAW_MODULUS,
  MAX_GENERATIONS,
  OFFSPRING,
  SEED_COUNT,
  organismValue,
} from './lib/config.mjs';
import { POLICIES } from './lib/model.mjs';
import { add, multiply, rat, toDecimal, toFraction, ZERO } from './lib/rational.mjs';

export const COMMITMENT_VERSION = 'swarm/commit-v1';
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
  let extinct = 0;
  let bloom = 0;
  let generations = 0;
  let gen1Extinct = 0;
  for (let index = 0; index < rounds; index += 1) {
    const roundSeed = seedFor(seed, index);
    const roundId = `sim-${index}`;
    const result = playRound(roundSeed, roundId, chosen.fn);
    total = add(total, result.total);
    generations += result.generation;
    if (result.total.numerator > 0n) wins += 1;
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
    extinctionRate: rat(BigInt(extinct), BigInt(rounds)),
    generationOneExtinctionRate: rat(BigInt(gen1Extinct), BigInt(rounds)),
    bloomCount: bloom,
    meanGenerations: rat(BigInt(generations), BigInt(rounds)),
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
  console.log(`  hit rate               : ${toDecimal(result.hitRate, 6)}`);
  console.log(`  generation-1 extinction: ${toDecimal(result.generationOneExtinctionRate, 6)}   (exact 8/125 = 0.064)`);
  console.log(`  mean generations       : ${toDecimal(result.meanGenerations, 4)}`);
  console.log(`  FULL BLOOM rounds      : ${result.bloomCount}`);
  console.log(`  elapsed                : ${elapsedMs.toFixed(0)} ms`);
  console.log(`  commitment sample      : ${commitment(seedFor(options.seed, 0), 'sim-0')}`);
  console.log(`  exact empirical RTP    : ${toFraction(result.empiricalRtp)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
