/**
 * The two-phase commitment and the live action chain — `docs/ENGINE.md` §4.
 *
 * SWARM's transcript is a function of the player's decisions, so one commitment
 * cannot cover it. Phase 1 seals the server seed before the round opens; the
 * chain gives the player a pre-reveal witness of their own decision log while the
 * round runs; phase 2 seals the settled body, including that log, at settlement.
 *
 * Every preimage here is byte-identical to `tools/simulate.mjs`, the reference
 * implementation the published digests come from — `tests/server-derivation.test.mjs`
 * pins them, and the reference verifier is run against this server's output.
 */
import { encodeFields, normalizeHex32, type CanonicalField } from './canonical.ts';
import { SIDE_BET_IDS, SLOTS, SWARM, adapterFingerprint } from './adapter.ts';
import { normalizeSeed, sha256Hex, type Rational } from './engine.ts';
import { fail } from './errors.ts';
import type { ChainEvent, RoundContext, RoundReplay, TerminalReason, WildLine } from './derivation.ts';
import type { Receipt } from './settlement.ts';

/** How a round was settled. Sealed into the body, so it cannot be relabelled later. */
export const SETTLEMENT_MODES = Object.freeze(['PLAYER', 'RECONCILED'] as const);
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export type PublishedTerminal = TerminalReason | 'RECONCILED';

/**
 * The terminal reason a settlement publishes, from the terminal the grid produced
 * and the mode it was settled in. `RECONCILED` is reserved for a round that still
 * owed a decision when the abandonment clock ran out.
 */
export function publishedTerminal(
  reason: TerminalReason,
  settlementMode: SettlementMode,
): PublishedTerminal {
  if (!SETTLEMENT_MODES.includes(settlementMode))
    fail('INVALID_TRANSCRIPT', 'Settlement mode must be PLAYER or RECONCILED', '$.settlementMode');
  return settlementMode === 'RECONCILED' && reason === 'BANKED' ? 'RECONCILED' : reason;
}

/**
 * **Phase 1.** Published before the round opens, and therefore before the player
 * supplies entropy or makes a decision. It binds the sealed seed, the frozen
 * economics and the grid shape, and discloses nothing.
 *
 * It deliberately does not bind the client entropy: the entropy does not exist
 * yet, and that ordering is the whole control against seed grinding (§4.5).
 */
export function seedCommitment(seedHex: string, roundId: string): string {
  const seed = normalizeSeed(seedHex);
  if (typeof roundId !== 'string' || roundId.length === 0)
    fail('INVALID_REQUEST', 'Round id must be a non-empty string', '$.roundId');
  return sha256Hex(
    encodeFields([
      'Axiom Games SWARM seed pre-commitment',
      SWARM.proof.seedCommitmentVersion,
      Buffer.from(seed, 'hex'),
      SWARM.id,
      SWARM.adapterVersion,
      adapterFingerprint(),
      roundId,
      SWARM.ladder.stages,
      SLOTS,
      SWARM.cohort.drawModulus,
    ]),
  );
}

export interface ActionChain {
  readonly terminal: string;
  readonly values: readonly string[];
}

/**
 * The live action chain. `chain(0)` is the seed pre-commitment; each frame folds
 * the next observed event into it. A client that retains the values it was handed
 * holds a hash chain over its own decision log that predates the seed reveal.
 */
export function actionChain(seedCommitmentHex: string, events: readonly ChainEvent[]): ActionChain {
  let chain = normalizeHex32(seedCommitmentHex, 'Seed commitment');
  const values = [chain];
  events.forEach((event, index) => {
    chain = sha256Hex(
      encodeFields([
        SWARM.proof.actionChainDomain,
        chain,
        index,
        event.kind,
        event.generation,
        event.value,
      ]),
    );
    values.push(chain);
  });
  return Object.freeze({ terminal: chain, values: Object.freeze(values) });
}

/** One incremental fold, for a book that extends its chain as commands land. */
export function extendChain(chain: string, index: number, event: ChainEvent): string {
  return sha256Hex(
    encodeFields([
      SWARM.proof.actionChainDomain,
      normalizeHex32(chain, 'Action chain'),
      index,
      event.kind,
      event.generation,
      event.value,
    ]),
  );
}

export interface BodyBundle {
  readonly seedCommitment: string;
  readonly revealedSeed: string;
  readonly context: RoundContext;
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
  readonly round: RoundReplay;
  readonly wild: WildLine;
  readonly sideBetResults: readonly { id: string; resolved: string }[];
  readonly receipts: readonly Receipt[];
  readonly chainTerminal: string;
  readonly settlementMode: SettlementMode;
}

const fraction = (value: Rational | null): string =>
  value === null ? '0' : `${value.numerator}/${value.denominator}`;

/**
 * **Phase 2.** Everything the round actually did, sealed at settlement and
 * re-derivable by anyone holding the revealed seed: the phase-1 commitment, the
 * seed, the client entropy, every stake, every resolved population, the ordered
 * action log, the terminal, the settlement mode, the wild line, every side-bet
 * resolution, the whole per-line credit ledger and the terminal chain value.
 *
 * Two settlements of one published seed pre-commitment under different decision
 * logs therefore produce two different, publicly distinguishable digests.
 */
export function bodyCommitment(bundle: BodyBundle): string {
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
    settlementMode,
  } = bundle;
  if (!SETTLEMENT_MODES.includes(settlementMode))
    fail('INVALID_TRANSCRIPT', 'Settlement mode must be PLAYER or RECONCILED', '$.settlementMode');

  const fields: CanonicalField[] = [
    'Axiom Games SWARM settlement body',
    SWARM.proof.bodyCommitmentVersion,
    normalizeHex32(phaseOne, 'Seed commitment'),
    Buffer.from(normalizeSeed(revealedSeed), 'hex'),
    Buffer.from(context.clientEntropy, 'hex'),
    SWARM.id,
    SWARM.adapterVersion,
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

  fields.push(round.reason, settlementMode, publishedTerminal(round.reason, settlementMode));
  fields.push(round.generation, round.population);

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
      fraction(receipt.theoretical),
    );

  fields.push(normalizeHex32(chainTerminal, 'Action chain'));
  return sha256Hex(encodeFields(fields));
}
