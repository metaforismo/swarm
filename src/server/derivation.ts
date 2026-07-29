/**
 * Draw derivation and round replay — `docs/ENGINE.md` §4.1 and `docs/MATH.md` §1.1.
 *
 * A round's randomness is a grid of `18 x 15 = 270` draws, each an exact uniform
 * on `[0, 20)` produced by domain-separated rejection sampling keyed by the
 * sealed server seed over a payload that carries the adapter fingerprint, the
 * round id and the player's client entropy. The player's decisions choose *which*
 * draws the colony consumes; they cannot change what the draws are.
 *
 * The whole grid is derived once, when the round opens, so no branch of a
 * response path can be timed to learn a draw (§5.2).
 */
import { encodeFields, hmacSha256Hex, normalizeHex32 } from './canonical.ts';
import {
  GRID_SIZE,
  SLOTS,
  SWARM,
  adapterFingerprint,
} from './adapter.ts';
import { add, normalizeSeed, rational, type Rational } from './engine.ts';
import { assertClientEntropy } from './engine.ts';
import { fail } from './errors.ts';
import { cohortValue } from './adapter.ts';

const RANGE = 1n << 256n;
const ZERO: Rational = rational(0n);

/** The sampler label every organism draw carries. */
export const DRAW_LABEL = 'swarm-organism';

export interface RoundContext {
  readonly gameId: string;
  readonly roundId: string;
  /** 32 bytes of player entropy, lowercase hex, chosen after the seed pre-commitment. */
  readonly clientEntropy: string;
  readonly proofVersion: string;
}

/**
 * Builds a round context, validating the player's half of the handshake through
 * the engine's own `staged-survival` assert rather than a local regex.
 */
export function roundContext(roundId: unknown, clientEntropy: unknown): RoundContext {
  if (typeof roundId !== 'string' || roundId.length === 0 || roundId.length > 128)
    fail('INVALID_REQUEST', 'Round id must be a non-empty string of at most 128 characters', '$.roundId');
  if (typeof clientEntropy !== 'string')
    fail('INVALID_REQUEST', 'Client entropy is required', '$.clientEntropy');
  const normalized = clientEntropy.toLowerCase();
  try {
    assertClientEntropy(normalized, '$.clientEntropy');
  } catch {
    fail(
      'INVALID_REQUEST',
      `Client entropy must be exactly ${SWARM.entropy.clientEntropyBytes} bytes of hexadecimal`,
      '$.clientEntropy',
    );
  }
  return Object.freeze({
    gameId: SWARM.id,
    roundId,
    clientEntropy: normalized,
    proofVersion: SWARM.proof.samplerDomain,
  });
}

/**
 * Exact uniform value in `[0, modulus)` by domain-separated rejection sampling,
 * over the 11-field payload `docs/ENGINE.md` §4.1 specifies. The client entropy is
 * a payload field and not a key: the server seed stays the only secret, and the
 * player's contribution is public from the moment the round opens.
 */
export function uniformBigInt(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  const seed = normalizeSeed(seedHex);
  if (typeof modulus !== 'bigint' || modulus <= 0n || modulus >= RANGE)
    fail('INVALID_REQUEST', 'Modulus must be in [1, 2^256)', '$.modulus');
  if (!Number.isSafeInteger(counter) || counter < 0)
    fail('INVALID_REQUEST', 'Counter must be a safe index', '$.counter');
  const limit = RANGE - (RANGE % modulus);
  const fingerprint = adapterFingerprint();
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = encodeFields([
      'sampler',
      SWARM.proof.samplerDomain,
      SWARM.id,
      SWARM.adapterVersion,
      fingerprint,
      context.roundId,
      context.clientEntropy,
      label,
      counter,
      nonce,
      modulus,
    ]);
    const value = BigInt(`0x${hmacSha256Hex(seed, payload)}`);
    if (value < limit) return value % modulus;
  }
}

/** Draw index of slot `slot` (1-based) in generation `stage` (1-based). */
export function drawIndex(stage: number, slot: number): number {
  if (!Number.isSafeInteger(stage) || stage < 1 || stage > SWARM.ladder.stages)
    fail('INVALID_REQUEST', 'Generation out of range', '$.stage');
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > SLOTS)
    fail('INVALID_REQUEST', 'Slot out of range', '$.slot');
  return (stage - 1) * SLOTS + (slot - 1);
}

export function stageDraw(
  seedHex: string,
  context: RoundContext,
  stage: number,
  slot: number,
): bigint {
  return uniformBigInt(
    seedHex,
    context,
    DRAW_LABEL,
    drawIndex(stage, slot),
    SWARM.cohort.drawModulus,
  );
}

/**
 * The whole committed grid, derived at `open()`.
 *
 * 270 draws is 270 HMACs — under a millisecond — and deriving it up front is what
 * makes every later response constant-work with respect to the seed.
 */
export function deriveGrid(seedHex: string, context: RoundContext): Uint8Array {
  const grid = new Uint8Array(GRID_SIZE);
  for (let stage = 1; stage <= SWARM.ladder.stages; stage += 1)
    for (let slot = 1; slot <= SLOTS; slot += 1) {
      const index = drawIndex(stage, slot);
      grid[index] = Number(stageDraw(seedHex, context, stage, slot));
    }
  return grid;
}

export interface CohortBand {
  readonly id: string;
  readonly children: number;
}

const BANDS = SWARM.cohort.outcomes.map((outcome) => ({
  id: outcome.id,
  children: outcome.children,
  high: Number(outcome.highDraw),
}));

/** Maps a draw in `[0, drawModulus)` to its declared band. */
export function resolveDraw(draw: number): CohortBand {
  for (const band of BANDS) if (draw <= band.high) return band;
  return fail('DERIVATION_FAILED', 'Draw outside the declared bands', '$.draw');
}

export type ActionKind = 'CONTINUE' | 'HARVEST' | 'BANK';
export type TerminalReason = 'EXTINCT' | 'THRESHOLD' | 'FINAL' | 'BANKED';

/** Classifies a harvest of `units` from a population of `population`. */
export function actionKind(units: number, population: number): ActionKind {
  if (units === 0) return 'CONTINUE';
  return units === population ? 'BANK' : 'HARVEST';
}

export interface TraceEntry {
  readonly generation: number;
  readonly population: number;
  harvest?: number;
  action?: ActionKind;
}

export interface LoggedAction {
  readonly generation: number;
  readonly kind: ActionKind;
  readonly units: number;
}

export interface ChainEvent {
  readonly kind: 'RESOLVE' | ActionKind;
  readonly generation: number;
  readonly value: number;
}

export interface RoundReplay {
  readonly total: Rational;
  readonly population: number;
  readonly generation: number;
  readonly reason: TerminalReason;
  readonly trace: readonly TraceEntry[];
  readonly actions: readonly LoggedAction[];
  readonly events: readonly ChainEvent[];
}

/**
 * Resolves one generation against the committed grid: slots `1 ... units` of row
 * `stage`, summed through the cohort bands. Harvest removes the highest slots and
 * recompacts, so the number of draws a stage consumes is the population and the
 * population alone.
 */
export function resolveStage(grid: Uint8Array, stage: number, units: number): number {
  let next = 0;
  for (let slot = 1; slot <= units; slot += 1)
    next += resolveDraw(grid[drawIndex(stage, slot)] as number).children;
  return next;
}

export interface SlotOutcome {
  readonly slot: number;
  readonly id: string;
  readonly children: number;
}

/**
 * What happened to each organism in the generation just resolved.
 *
 * These are draws the player's own colony has already consumed, so disclosing
 * them reveals nothing about a generation they have not resolved — and the design
 * requires them: `docs/DESIGN.md` §6.5 R2 gives DIE, HOLD and SPLIT equal
 * perceptual weight in the outcome beat, which a client cannot draw from a
 * population count alone.
 */
export function stageOutcomes(
  grid: Uint8Array,
  stage: number,
  units: number,
): readonly SlotOutcome[] {
  const outcomes: SlotOutcome[] = [];
  for (let slot = 1; slot <= units; slot += 1) {
    const band = resolveDraw(grid[drawIndex(stage, slot)] as number);
    outcomes.push({ slot, id: band.id, children: band.children });
  }
  return Object.freeze(outcomes);
}

/**
 * Replays a whole round against a committed grid, taking each decision from
 * `decide(generation, population)`.
 *
 * `decide` is consulted **once per resolved non-terminal generation**: a stage
 * accepts one harvest commitment (`docs/ENGINE.md` §5.3), so the action log holds
 * one entry per stage and a verifier can replay it in step with the grid.
 */
export function replayRound(
  grid: Uint8Array,
  decide: (generation: number, population: number) => number,
): RoundReplay {
  let population = SWARM.seedUnits;
  let total = ZERO;
  const trace: TraceEntry[] = [];
  const actions: LoggedAction[] = [];
  const finish = (reason: TerminalReason, generation: number): RoundReplay =>
    Object.freeze({
      total,
      population,
      generation,
      reason,
      trace,
      actions,
      events: chainEvents(trace),
    });

  for (let generation = 1; generation <= SWARM.ladder.stages; generation += 1) {
    population = resolveStage(grid, generation, population);
    trace.push({ generation, population });
    if (population === 0) return finish('EXTINCT', generation);
    if (population >= SWARM.thresholds.settleAtOrAbove) {
      total = add(total, cohortValue(generation, population));
      return finish('THRESHOLD', generation);
    }
    if (generation === SWARM.ladder.stages) {
      total = add(total, cohortValue(generation, population));
      return finish('FINAL', generation);
    }
    const harvest = decide(generation, population);
    if (!Number.isSafeInteger(harvest) || harvest < 0 || harvest > population)
      fail('DERIVATION_FAILED', 'A decision source returned an illegal harvest', '$.actionLog');
    const kind = actionKind(harvest, population);
    actions.push({ generation, kind, units: harvest });
    const entry = trace[trace.length - 1] as TraceEntry;
    (entry as { harvest?: number }).harvest = harvest;
    (entry as { action?: ActionKind }).action = kind;
    if (harvest > 0) {
      total = add(total, cohortValue(generation, harvest));
      population -= harvest;
      if (population === 0) return finish('BANKED', generation);
    }
  }
  return fail('DERIVATION_FAILED', 'Round escaped the generation bound', '$.grid');
}

/**
 * The ordered frame events a client observes live: one `RESOLVE` per resolved
 * generation, one action event per decision, in the order they happened. The
 * action chain is folded over exactly this sequence.
 */
export function chainEvents(trace: readonly TraceEntry[]): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const entry of trace) {
    events.push({ kind: 'RESOLVE', generation: entry.generation, value: entry.population });
    if (entry.action !== undefined)
      events.push({
        kind: entry.action,
        generation: entry.generation,
        value: entry.harvest as number,
      });
  }
  return events;
}

export interface WildLine {
  /** Population after each resolved generation of the never-harvested colony. */
  readonly populations: readonly number[];
  readonly peak: number;
  readonly terminal: TerminalReason;
  readonly extinctGeneration: number | null;
}

/**
 * The wild line: the same committed grid replayed with an empty action log. Side
 * bets resolve on this and nothing else, which is why no decision can move one.
 *
 * Its generation-`t` population is a function of row-`t` draws alone, so it may be
 * disclosed once the player's own generation `t` has resolved and never before
 * (`docs/MATH.md` §7.3).
 */
export function wildLineOf(grid: Uint8Array): WildLine {
  const run = replayRound(grid, () => 0);
  const populations = run.trace.map((entry) => entry.population);
  let peak = SWARM.seedUnits;
  for (const population of populations) if (population > peak) peak = population;
  const extinctIndex = populations.indexOf(0);
  return Object.freeze({
    populations: Object.freeze(populations),
    peak,
    terminal: run.reason,
    extinctGeneration: extinctIndex === -1 ? null : extinctIndex + 1,
  });
}

/** Peak of the wild line restricted to the generations the player has resolved. */
export function wildPeakThrough(wild: WildLine, stage: number): number {
  let peak = SWARM.seedUnits;
  for (const population of wild.populations.slice(0, stage))
    if (population > peak) peak = population;
  return peak;
}

/** The one hex normalizer the request path uses for a seed-shaped value. */
export { normalizeHex32 };
