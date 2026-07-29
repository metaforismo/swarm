#!/usr/bin/env node
/**
 * SWARM — reference derivation, two-phase commit-reveal, settlement ledger and
 * seeded Monte Carlo cross-check.
 *
 * This is NOT the source of any published number: `tools/enumerate.mjs` is.
 * This script exists for three reasons.
 *
 *   1. It is an executable reference implementation of the draw derivation and
 *      the **two-phase** commitment scheme specified in docs/ENGINE.md §4 —
 *      length-prefixed canonical encoding, domain-separated HMAC-SHA256, exact
 *      rejection sampling, player-supplied client entropy, a seed
 *      pre-commitment published before the first decision and a settlement body
 *      commitment that seals the action log. Anything that claims to verify a
 *      SWARM round must reproduce these bytes.
 *   2. It is an executable verifier. `verifyRound()` takes the action log as an
 *      *untrusted input* and refuses any log that does not reproduce the
 *      published body commitment, which is what makes "verifiable by
 *      re-derivation" true against the operator and not only against the RNG.
 *   3. It is an independent sanity cross-check: if the enumeration and a
 *      straight simulation of the written rules disagree, one of them is wrong.
 *
 * Everything here is deterministic given `--seed`, so a CI failure is
 * reproducible rather than flaky.
 *
 * Usage:
 *   node tools/simulate.mjs [--rounds 20000] [--seed <64 hex chars>] [--policy RUN]
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ACTION_CHAIN_DOMAIN,
  ADAPTER_ID,
  ADAPTER_VERSION,
  BLOOM_THRESHOLD,
  BODY_COMMITMENT_VERSION,
  CLIENT_ENTROPY_BYTES,
  COHORT_MODEL_VERSION,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  HARVEST_QUANTUM,
  LADDER_BASE,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MODULE_API,
  MU,
  OFFSPRING,
  SAMPLER_DOMAIN,
  SEED_COMMITMENT_VERSION,
  SEED_COUNT,
  SIDE_BET_MAX_WIN_MULTIPLES,
  TARGET_RTP,
  organismValue,
  ticketExposureUnits,
} from './lib/config.mjs';
import { POLICIES, payableUnits, sideBets } from './lib/model.mjs';
import { ONE, add, divide, multiply, rat, toDecimal, toFraction, ZERO } from './lib/rational.mjs';

export { SEED_COMMITMENT_VERSION, BODY_COMMITMENT_VERSION, SAMPLER_DOMAIN, ACTION_CHAIN_DOMAIN };
export const DRAW_LABEL = 'swarm-organism';
const SLOTS = BLOOM_THRESHOLD - 1;

/** Ordered side-bet ids. The body commitment walks them in this order, always. */
const SIDE_BET_IDS = Object.freeze(Object.keys(SIDE_BET_MAX_WIN_MULTIPLES));

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

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function normalizeHex32(value, what) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value))
    throw new Error(`${what} must be exactly 32 bytes of hexadecimal`);
  return value.toLowerCase();
}

export function normalizeSeed(seedHex) {
  return normalizeHex32(seedHex, 'Seed');
}

/**
 * Player-supplied entropy, 32 bytes. It is chosen by the client *after* the seed
 * pre-commitment is published and enters every draw, so an operator cannot grind
 * seeds against a grid it has already seen. See docs/ENGINE.md §4.5 for what
 * this does and does not close.
 */
export function normalizeClientEntropy(entropyHex) {
  return normalizeHex32(entropyHex, 'Client entropy');
}

/** Constant-time comparison of two lowercase hex digests of equal length. */
export function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * A round context: the round identity plus the player's entropy contribution.
 * Every draw and both commitments are domain-separated by all of it.
 */
export function roundContext(roundId, clientEntropyHex) {
  if (typeof roundId !== 'string' || roundId.length === 0 || roundId.length > 128)
    throw new Error('Round id must be a non-empty string of at most 128 characters');
  return Object.freeze({ roundId, clientEntropy: normalizeClientEntropy(clientEntropyHex) });
}

/**
 * Adapter fingerprint, exactly the field set docs/ENGINE.md §2 declares: module
 * API, adapter id and version, cohort model version, both commitment versions,
 * the sampler domain, the client-entropy width, draw modulus, every outcome band
 * in order, seed units, stage count, both thresholds, the harvest quantum,
 * ladder base and step, target RTP, rounding mode, the colony cap, and every
 * side-bet line with its own cap in declaration order.
 *
 * Any change to the economics *or to the proof surface* changes this value, and
 * the value is bound into both commitments and into every draw, so a transcript
 * can only be verified against the adapter it was produced under.
 */
let fingerprintCache = null;
export function adapterFingerprint() {
  if (fingerprintCache !== null) return fingerprintCache;
  const step = divide(ONE, MU);
  const fields = [
    MODULE_API,
    ADAPTER_ID,
    ADAPTER_VERSION,
    COHORT_MODEL_VERSION,
    SEED_COMMITMENT_VERSION,
    BODY_COMMITMENT_VERSION,
    SAMPLER_DOMAIN,
    ACTION_CHAIN_DOMAIN,
    CLIENT_ENTROPY_BYTES,
    DRAW_MODULUS,
  ];
  for (const outcome of OFFSPRING) fields.push(outcome.id, outcome.children, outcome.weight);
  fields.push(
    SEED_COUNT,
    MAX_GENERATIONS,
    BLOOM_THRESHOLD,
    MAX_POPULATION,
    HARVEST_QUANTUM,
    LADDER_BASE.numerator,
    LADDER_BASE.denominator,
    step.numerator,
    step.denominator,
    TARGET_RTP.numerator,
    TARGET_RTP.denominator,
    'floor',
    COLONY_MAX_WIN_MULTIPLE,
  );
  for (const id of SIDE_BET_IDS) fields.push(id, SIDE_BET_MAX_WIN_MULTIPLES[id]);
  fingerprintCache = sha256(encodeFields(fields));
  return fingerprintCache;
}

/**
 * **Phase 1.** The seed pre-commitment, published before the round opens and
 * therefore before the player supplies entropy or makes a decision. It binds the
 * server seed, the frozen economics and the grid shape, and discloses nothing:
 * it is a hash of an unrevealed 32-byte seed.
 *
 * It deliberately does *not* bind the client entropy — the entropy does not
 * exist yet, and that ordering is the whole point.
 */
export function seedCommitment(seedHex, roundId) {
  const seed = normalizeSeed(seedHex);
  if (typeof roundId !== 'string' || roundId.length === 0)
    throw new Error('Round id must be a non-empty string');
  return sha256(
    encodeFields([
      'Axiom Games SWARM seed pre-commitment',
      SEED_COMMITMENT_VERSION,
      Buffer.from(seed, 'hex'),
      ADAPTER_ID,
      ADAPTER_VERSION,
      adapterFingerprint(),
      roundId,
      MAX_GENERATIONS,
      SLOTS,
      DRAW_MODULUS,
    ]),
  );
}

const RANGE = 1n << 256n;

/**
 * Exact uniform value in `[0, modulus)` by domain-separated rejection sampling.
 * The payload carries the adapter fingerprint and the player's entropy, so a
 * draw belongs to exactly one (adapter, round, client entropy) triple.
 */
export function uniformBigInt(seedHex, context, label, counter, modulus) {
  const seed = normalizeSeed(seedHex);
  if (typeof modulus !== 'bigint' || modulus <= 0n || modulus >= RANGE)
    throw new Error('Modulus must be in [1, 2^256)');
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Counter must be a safe index');
  const limit = RANGE - (RANGE % modulus);
  const fingerprint = adapterFingerprint();
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = encodeFields([
      'sampler',
      SAMPLER_DOMAIN,
      ADAPTER_ID,
      ADAPTER_VERSION,
      fingerprint,
      context.roundId,
      context.clientEntropy,
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

const BANDS = OFFSPRING.map((outcome) => ({
  id: outcome.id,
  children: outcome.children,
  high: outcome.highDraw,
}));

/** Maps a draw in `[0, DRAW_MODULUS)` to an offspring count. */
export function resolveDraw(draw) {
  for (const band of BANDS) if (draw <= band.high) return band;
  throw new Error('Draw outside the declared bands');
}

/** Classifies a harvest of `units` from a population of `population`. */
function actionKind(units, population) {
  if (units === 0) return 'CONTINUE';
  return units === population ? 'BANK' : 'HARVEST';
}

/**
 * Plays one round of SWARM against a committed grid, taking each decision from
 * `decide(generation, population)`.
 *
 * Returns the exact total payout as a multiple of the stake, the resolved
 * populations, and the **ordered action log** — the artifact the settlement body
 * commitment seals and the verifier re-derives.
 */
export function playRound(seedHex, context, decide) {
  if (typeof decide !== 'function') throw new Error('A decision source is required');
  let population = SEED_COUNT;
  let total = ZERO;
  const trace = [];
  const actions = [];
  const finish = (reason, generation) => ({
    total,
    population,
    generation,
    reason,
    trace,
    actions,
    events: chainEvents(trace),
  });

  for (let generation = 1; generation <= MAX_GENERATIONS; generation += 1) {
    let next = 0;
    for (let slot = 1; slot <= population; slot += 1) {
      const draw = uniformBigInt(
        seedHex,
        context,
        DRAW_LABEL,
        drawIndex(generation, slot),
        DRAW_MODULUS,
      );
      next += resolveDraw(draw).children;
    }
    population = next;
    trace.push({ generation, population });
    if (population === 0) return finish('EXTINCT', generation);
    if (population >= BLOOM_THRESHOLD) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(population))));
      return finish('BLOOM', generation);
    }
    if (generation === MAX_GENERATIONS) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(population))));
      return finish('FINAL', generation);
    }
    const harvest = decide(generation, population);
    if (!Number.isSafeInteger(harvest) || harvest < 0 || harvest > population)
      throw new Error('Policy returned an illegal harvest');
    const kind = actionKind(harvest, population);
    actions.push({ generation, kind, units: harvest, population });
    trace[trace.length - 1].harvest = harvest;
    trace[trace.length - 1].action = kind;
    if (harvest > 0) {
      total = add(total, multiply(organismValue(generation), rat(BigInt(harvest))));
      population -= harvest;
      if (population === 0) return finish('BANKED', generation);
    }
  }
  throw new Error('Round escaped the generation bound');
}

/**
 * The ordered frame events a client observes live, one per resolution and one
 * per decision. The action chain is folded over exactly this sequence, so the
 * value the client holds mid-round is a commitment to everything it has seen so
 * far — before the seed is revealed.
 */
function chainEvents(trace) {
  const events = [];
  for (const entry of trace) {
    events.push({ kind: 'RESOLVE', generation: entry.generation, value: entry.population });
    if (entry.action !== undefined)
      events.push({ kind: entry.action, generation: entry.generation, value: entry.harvest });
  }
  return events;
}

/**
 * The live action chain: `chain(0)` is the seed pre-commitment and each frame
 * folds the next observed event into it. The client is handed `chain(i)` with
 * the response to command `i`, so it accumulates an incremental witness of its
 * own decision log while the round is still running and the seed is still
 * sealed. The terminal value is bound into the body commitment (§4.3), which is
 * what stops a settlement from being replayed under a different log.
 */
export function actionChain(seedCommitmentHex, events) {
  let chain = normalizeHex32(seedCommitmentHex, 'Seed commitment');
  const values = [chain];
  events.forEach((event, index) => {
    chain = sha256(
      encodeFields([
        ACTION_CHAIN_DOMAIN,
        chain,
        index,
        event.kind,
        event.generation,
        event.value,
      ]),
    );
    values.push(chain);
  });
  return { terminal: chain, values };
}

/**
 * The wild line: the same committed grid replayed with an empty action log.
 * Every side bet resolves on this and nothing else, which is why no decision can
 * move one.
 *
 * Its generation-`t` population is a function of row-`t` draws only, so it may
 * be disclosed to the client as soon as the player's own generation `t` has
 * resolved, and never before (docs/MATH.md §7.3, docs/ENGINE.md §5.2).
 */
export function wildLine(seedHex, context) {
  const run = playRound(seedHex, context, () => 0);
  const populations = run.trace.map((entry) => entry.population);
  let peak = SEED_COUNT;
  for (const population of populations) if (population > peak) peak = population;
  const extinctIndex = populations.indexOf(0);
  return {
    populations,
    peak,
    terminal: run.reason,
    extinctGeneration: extinctIndex === -1 ? null : extinctIndex + 1,
    /** Peak of the wild line restricted to generations the player has resolved. */
    peakThrough: (generation) =>
      populations.slice(0, generation).reduce((best, value) => (value > best ? value : best), SEED_COUNT),
  };
}

/** Resolves all three side bets against the wild line. Pure function of the grid. */
export function resolveSideBets(seedHex, context) {
  const line = wildLine(seedHex, context);
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
 * **Phase 2.** The settlement body commitment: everything the round actually
 * did, sealed at settlement and re-derivable by anyone holding the revealed
 * seed.
 *
 * It binds the phase-1 commitment, the revealed seed, the client entropy, every
 * stake, every resolved population, **the ordered action log**, the terminal,
 * the wild line, every side-bet resolution, the whole per-line credit ledger and
 * the terminal action-chain value. Two settlements of one published seed
 * commitment under different decision logs therefore produce two different body
 * commitments, which is the attack docs/ENGINE.md §4.2 previously left open.
 */
export function bodyCommitment(bundle) {
  const {
    seedCommitment: phaseOne,
    revealedSeed,
    context,
    stakeUnits,
    sideBetStakes,
    round,
    wild,
    sideBetResults,
    receipts,
    chainTerminal,
  } = bundle;

  const fields = [
    'Axiom Games SWARM settlement body',
    BODY_COMMITMENT_VERSION,
    normalizeHex32(phaseOne, 'Seed commitment'),
    Buffer.from(normalizeSeed(revealedSeed), 'hex'),
    Buffer.from(context.clientEntropy, 'hex'),
    ADAPTER_ID,
    ADAPTER_VERSION,
    adapterFingerprint(),
    context.roundId,
    stakeUnits,
  ];

  fields.push(SIDE_BET_IDS.length);
  for (const id of SIDE_BET_IDS) fields.push(id, sideBetStakes[id] ?? 0n);

  fields.push(round.trace.length);
  for (const entry of round.trace) fields.push(entry.generation, entry.population);

  fields.push(round.actions.length);
  for (const action of round.actions) fields.push(action.generation, action.kind, action.units);

  fields.push(round.reason, round.generation, round.population);

  fields.push(wild.populations.length);
  for (const population of wild.populations) fields.push(population);
  fields.push(wild.peak, wild.terminal);

  fields.push(sideBetResults.length);
  for (const result of sideBetResults) fields.push(result.id, result.resolved);

  fields.push(receipts.length);
  for (const receipt of receipts)
    fields.push(
      receipt.sequence,
      receipt.kind,
      receipt.line,
      receipt.direction,
      receipt.stage,
      receipt.amountUnits,
      receipt.unitsHarvested ?? 0,
      receipt.resolved ?? 'NONE',
      receipt.theoretical === null ? '0' : toFraction(receipt.theoretical),
    );

  fields.push(normalizeHex32(chainTerminal, 'Action chain'));
  return sha256(encodeFields(fields));
}

/**
 * Reference money path for a whole ticket: one COLONY bet plus any side bets,
 * each with its own stake, its own cap basis and its own ledger lines, plus the
 * complete two-phase proof bundle a verifier needs.
 *
 * This exists because a paytable with no money path is not a specification. It
 * is the executable form of docs/ENGINE.md §4 and §5.3: every movement is a
 * receipt, every receipt names its line, the cap is applied per line with that
 * line's own stake as the basis, and the whole thing is sealed by a commitment
 * a verifier re-derives.
 */
export function settleTicket({
  seedHex,
  roundId,
  clientEntropy,
  stakeUnits,
  sideBetStakes = {},
  policy,
}) {
  const context = roundContext(roundId, clientEntropy);
  // Validates stake bounds and side-bet ids before a single receipt exists.
  const exposure = ticketExposureUnits(stakeUnits, sideBetStakes);
  const phaseOne = seedCommitment(seedHex, context.roundId);
  const round = playRound(seedHex, context, policy);
  const wild = wildLine(seedHex, context);
  return sealSettlement({
    seedHex,
    context,
    phaseOne,
    stakeUnits,
    sideBetStakes,
    round,
    wild,
    exposure,
  });
}

/**
 * Turns a replayed round into the ledger, the proof bundle and the aggregate
 * money figures. Split out of `settleTicket()` so `verifyRound()` re-derives the
 * settlement through exactly the same code path a settlement was produced by,
 * rather than through a parallel implementation that could drift.
 */
function sealSettlement({
  seedHex,
  context,
  phaseOne,
  stakeUnits,
  sideBetStakes,
  round,
  wild,
  exposure,
}) {
  const receipts = [];
  let sequence = 0;
  const push = (receipt) => {
    sequence += 1;
    receipts.push({ sequence, unitsHarvested: 0, resolved: null, ...receipt });
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
  for (const id of SIDE_BET_IDS) {
    const amount = sideBetStakes[id];
    if (amount === undefined) continue;
    push({
      kind: 'OPEN',
      line: id,
      direction: 'DEBIT',
      stage: 0,
      amountUnits: amount,
      theoretical: null,
      capped: false,
    });
  }

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
  const sideBetResults = [];
  for (const bet of resolveSideBets(seedHex, context)) {
    const stake = sideBetStakes[bet.id];
    if (stake === undefined) {
      sideBetResults.push({ id: bet.id, resolved: 'NOT_SELECTED' });
      continue;
    }
    const payable = bet.won
      ? payableUnits(stake, bet.multiplier, 0n, bet.capMultiple)
      : { theoretical: ZERO, credited: 0n, capped: false };
    sideBetResults.push({ id: bet.id, resolved: bet.won ? 'WON' : 'LOST' });
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

  const chain = actionChain(phaseOne, round.events);
  const body = bodyCommitment({
    seedCommitment: phaseOne,
    revealedSeed: seedHex,
    context,
    stakeUnits,
    sideBetStakes,
    round,
    wild,
    sideBetResults,
    receipts,
    chainTerminal: chain.terminal,
  });

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

  return {
    receipts,
    creditedUnits,
    stakedUnits,
    exposureUnits: exposure,
    round,
    wild,
    /** Everything a third party needs, and nothing it has to be trusted about. */
    proof: {
      seedCommitment: phaseOne,
      bodyCommitment: body,
      actionChain: chain.terminal,
      liveChainValues: chain.values,
      revealedSeed: normalizeSeed(seedHex),
      roundId: context.roundId,
      clientEntropy: context.clientEntropy,
      adapterFingerprint: adapterFingerprint(),
      stakeUnits,
      sideBetStakes,
      actionLog: round.actions.map((action) => ({
        generation: action.generation,
        kind: action.kind,
        units: action.units,
      })),
      populations: round.trace.map((entry) => entry.population),
      terminal: round.reason,
      sideBetResults,
    },
  };
}

/**
 * The verifier, in the phase order docs/ENGINE.md §4.4 mandates.
 *
 * `proof.actionLog` is an **untrusted input**: it is what the operator claims
 * the player did. Step 7 re-seals the body commitment over the log that was
 * actually replayed and compares it in constant time, so a fabricated log — or a
 * genuine log attached to a fabricated ledger — fails closed. Every failure is
 * one of the public codes; nothing throws a parser trace at the caller.
 */
export function verifyRound(proof) {
  const failure = (code, detail) => ({ ok: false, code, detail });
  try {
    if (typeof proof !== 'object' || proof === null) return failure('INVALID_TRANSCRIPT', 'not an object');

    // 1. Definition identity.
    if (proof.adapterFingerprint !== adapterFingerprint())
      return failure('ADAPTER_MISMATCH', 'adapter fingerprint does not match this build');

    const context = roundContext(proof.roundId, proof.clientEntropy);
    const seed = normalizeSeed(proof.revealedSeed);

    // 2. Phase 1: the seed pre-commitment must re-derive from the revealed seed.
    const phaseOne = seedCommitment(seed, context.roundId);
    if (!constantTimeHexEqual(phaseOne, proof.seedCommitment))
      return failure('COMMITMENT_MISMATCH', 'seed pre-commitment does not re-derive');

    // 3. Replay the grid *using the submitted action log*, never a policy.
    const log = proof.actionLog;
    if (!Array.isArray(log) || log.length > MAX_GENERATIONS)
      return failure('INVALID_TRANSCRIPT', 'malformed action log');
    let cursor = 0;
    const replay = playRound(seed, context, (generation, population) => {
      const entry = log[cursor];
      cursor += 1;
      if (entry === undefined) throw new Error('action log is shorter than the round');
      if (entry.generation !== generation) throw new Error('action log is out of order');
      if (!Number.isSafeInteger(entry.units) || entry.units < 0 || entry.units > population)
        throw new Error('action log contains an illegal harvest');
      if (entry.kind !== actionKind(entry.units, population))
        throw new Error('action log mislabels an action');
      return entry.units;
    });
    if (cursor !== log.length) return failure('TRANSCRIPT_MISMATCH', 'action log has trailing entries');
    const populations = replay.trace.map((entry) => entry.population);
    if (
      !Array.isArray(proof.populations) ||
      proof.populations.length !== populations.length ||
      proof.populations.some((value, index) => value !== populations[index])
    )
      return failure('TRANSCRIPT_MISMATCH', 'resolved populations do not re-derive');
    if (proof.terminal !== replay.reason)
      return failure('TRANSCRIPT_MISMATCH', 'terminal reason does not re-derive');

    // 4 and 5. Recompute the whole per-line ledger, including the side bets,
    // through the same sealing path a settlement was produced by.
    const receipts = proof.receipts;
    if (!Array.isArray(receipts)) return failure('INVALID_TRANSCRIPT', 'missing receipt ledger');
    const sideBetStakes = proof.sideBetStakes ?? {};
    const wild = wildLine(seed, context);
    const expected = sealSettlement({
      seedHex: seed,
      context,
      phaseOne,
      stakeUnits: proof.stakeUnits,
      sideBetStakes,
      round: replay,
      wild,
      exposure: ticketExposureUnits(proof.stakeUnits, sideBetStakes),
    });
    if (receipts.length !== expected.receipts.length)
      return failure('TRANSCRIPT_MISMATCH', 'receipt count does not re-derive');
    for (let index = 0; index < receipts.length; index += 1) {
      const actual = receipts[index];
      const want = expected.receipts[index];
      if (
        actual.sequence !== want.sequence ||
        actual.kind !== want.kind ||
        actual.line !== want.line ||
        actual.direction !== want.direction ||
        actual.stage !== want.stage ||
        actual.amountUnits !== want.amountUnits
      )
        return failure('TRANSCRIPT_MISMATCH', `receipt ${index + 1} does not re-derive`);
      // 6. A cap can only bind if the adapter is misconfigured.
      if (actual.capped) return failure('TRANSCRIPT_MISMATCH', 'a receipt reports a capped credit');
    }
    for (const result of proof.sideBetResults ?? []) {
      const want = expected.proof.sideBetResults.find((entry) => entry.id === result.id);
      if (want === undefined) return failure('TRANSCRIPT_MISMATCH', `unknown side bet ${result.id}`);
      if (result.resolved !== want.resolved)
        return failure('TRANSCRIPT_MISMATCH', `side bet ${result.id} does not re-derive`);
    }

    // 7. Phase 2: the action chain and the settlement body, re-sealed over what
    // was actually replayed and compared in constant time. This is the step that
    // turns the action log from an unverified input into bound evidence.
    if (!constantTimeHexEqual(expected.proof.actionChain, proof.actionChain))
      return failure('COMMITMENT_MISMATCH', 'action chain does not re-derive');
    if (!constantTimeHexEqual(expected.proof.bodyCommitment, proof.bodyCommitment))
      return failure('COMMITMENT_MISMATCH', 'settlement body does not re-derive');

    return {
      ok: true,
      code: 'VERIFIED',
      seedCommitment: phaseOne,
      bodyCommitment: expected.proof.bodyCommitment,
    };
  } catch (error) {
    return failure('DERIVATION_FAILED', error instanceof Error ? error.message : 'unknown');
  }
}

/** Bundles a settlement into the shape `verifyRound()` accepts. */
export function proofBundle(settlement) {
  return { ...settlement.proof, receipts: settlement.receipts };
}

function derived(masterSeed, label, index) {
  return sha256(encodeFields([label, masterSeed, index]));
}

const seedFor = (masterSeed, index) => derived(masterSeed, 'swarm-simulation-seed', index);
const entropyFor = (masterSeed, index) => derived(masterSeed, 'swarm-simulation-client', index);

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
    const context = roundContext(`sim-${index}`, entropyFor(seed, index));
    // The wild line is always derived, because side bets resolve on it and on
    // nothing else. When the policy is RUN the two coincide exactly.
    const wild = chosen.id === 'RUN' ? null : playRound(roundSeed, context, POLICIES.RUN.fn);
    const result = playRound(roundSeed, context, chosen.fn);
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
  console.log(
    `  seed pre-commitment    : ${seedCommitment(seedFor(options.seed, 0), 'sim-0')}`,
  );
  console.log(`  exact empirical RTP    : ${toFraction(result.empiricalRtp)}`);

  // One fully-worked ticket, so the money path and the proof are visible rather
  // than described.
  const example = settleTicket({
    seedHex: seedFor(options.seed, 0),
    roundId: 'sim-0',
    clientEntropy: entropyFor(options.seed, 0),
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
  console.log(
    `    action log             : ${example.proof.actionLog.map((a) => `${a.generation}:${a.kind}${a.units ? `(${a.units})` : ''}`).join(' ') || '(none)'}`,
  );
  console.log(`    seed pre-commitment    : ${example.proof.seedCommitment}`);
  console.log(`    settlement body commit : ${example.proof.bodyCommitment}`);
  console.log(`    verification           : ${verifyRound(proofBundle(example)).code}`);

  // The attack phase 2 exists to close: one published seed pre-commitment, two
  // mutually inconsistent settlements. Same seed, same round, same entropy, a
  // different decision log — and therefore a different, distinguishable body.
  const alternative = settleTicket({
    seedHex: seedFor(options.seed, 0),
    roundId: 'sim-0',
    clientEntropy: entropyFor(options.seed, 0),
    stakeUnits: 1000000n,
    sideBetStakes: { FIRST_LIGHT: 500000n, SWARM: 200000n },
    policy: POLICIES.RUN.fn,
  });
  console.log('\n  re-settlement of the same published seed pre-commitment under a different log');
  console.log(
    `    same phase-1 commitment: ${alternative.proof.seedCommitment === example.proof.seedCommitment}`,
  );
  // A swap is only a forgery if the two logs actually differ; say so, so the
  // demo cannot look like a proof when it is a tautology.
  console.log(
    `    logs differ            : ${JSON.stringify(alternative.proof.actionLog) !== JSON.stringify(example.proof.actionLog)}`,
  );
  console.log(`    alternative body commit: ${alternative.proof.bodyCommitment}`);
  console.log(
    `    bodies differ          : ${alternative.proof.bodyCommitment !== example.proof.bodyCommitment}`,
  );
  const swapped = { ...proofBundle(alternative), actionLog: example.proof.actionLog };
  const swappedResult = verifyRound(swapped);
  console.log(`    log swapped onto body  : ${swappedResult.code} (${swappedResult.detail})`);
  const relabelled = {
    ...proofBundle(example),
    actionLog: example.proof.actionLog.map((entry) => ({ ...entry, units: 0, kind: 'CONTINUE' })),
  };
  const relabelledResult = verifyRound(relabelled);
  console.log(`    log rewritten in place : ${relabelledResult.code} (${relabelledResult.detail})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
