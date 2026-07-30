/**
 * The settlement ledger — `docs/ENGINE.md` §5.3 and §5.4.
 *
 * One function seals a settled round into receipts and a proof bundle, and both
 * the round book and the verifier go through it. That is deliberate: the
 * verifier re-derives a settlement through exactly the code path a settlement was
 * produced by, so the two cannot drift into disagreeing about what a round owes.
 *
 * Every movement is a receipt, every receipt names exactly one bet line, and the
 * cap is applied per line with that line's own stake as the basis. No cap sums
 * lines, so no line is ever short-paid by another line's win.
 */
import {
  SIDE_BET_IDS,
  SWARM,
  adapterFingerprint,
  cohortValue,
  ticketExposureUnits,
} from './adapter.ts';
import {
  actionChain,
  bodyCommitment,
  publishedTerminal,
  type PublishedTerminal,
  type SettlementMode,
} from './commitment.ts';
import type { LoggedAction, RoundContext, RoundReplay, WildLine } from './derivation.ts';
import { multiply, payableWithinCap, rational, type Rational } from './engine.ts';
import { fail } from './errors.ts';
import { SIDE_BETS } from './paytable.ts';
import { frozenCopy } from './snapshot.ts';

export const RECEIPT_SCHEMA = 'receipt-v2' as const;

export type ReceiptKind = 'OPEN' | 'HARVEST' | 'SETTLE' | 'SIDE_BET';
export type ReceiptDirection = 'DEBIT' | 'CREDIT';
export type SideBetResolution = 'WON' | 'LOST' | 'NOT_SELECTED';

export interface Receipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  /** Ledger revision. Advances independently of the frame revision. */
  readonly sequence: number;
  readonly kind: ReceiptKind;
  /** `COLONY` or a side-bet id. Every receipt names exactly one line. */
  readonly line: string;
  readonly direction: ReceiptDirection;
  readonly stage: number;
  /** Non-negative: a DEBIT is a stake, a CREDIT is a payout. */
  readonly amountUnits: bigint;
  readonly unitsHarvested: number;
  readonly resolved: 'WON' | 'LOST' | null;
  /** Exact, unrounded. Null for a DEBIT. */
  readonly theoretical: Rational | null;
  /** Always false; a true is a build failure, not a payout (§4.6 step 6). */
  readonly capped: boolean;
  readonly terminal?: PublishedTerminal;
}

export interface SettlementProof {
  readonly seedCommitment: string;
  readonly bodyCommitment: string;
  readonly actionChain: string;
  readonly liveChainValues: readonly string[];
  readonly revealedSeed: string;
  readonly roundId: string;
  readonly clientEntropy: string;
  readonly adapterFingerprint: string;
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
  readonly actionLog: readonly LoggedAction[];
  readonly populations: readonly number[];
  readonly terminal: PublishedTerminal;
  readonly settlementMode: SettlementMode;
  readonly sideBetResults: readonly { readonly id: string; readonly resolved: SideBetResolution }[];
  readonly wild: WildLine;
}

export interface Settlement {
  readonly receipts: readonly Receipt[];
  readonly creditedUnits: bigint;
  readonly stakedUnits: bigint;
  readonly exposureUnits: bigint;
  readonly round: RoundReplay;
  readonly proof: SettlementProof;
}

export interface SealInput {
  readonly seedHex: string;
  readonly context: RoundContext;
  readonly seedCommitment: string;
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
  readonly round: RoundReplay;
  readonly wild: WildLine;
  readonly settlementMode: SettlementMode;
}

/** Resolves all three side bets against the wild line. A pure function of the grid. */
export function resolveSideBets(wild: WildLine): ReadonlyMap<string, boolean> {
  const populations = wild.populations;
  const first = populations[0] ?? 0;
  return frozenCopy(new Map<string, boolean>([
    ['FIRST_LIGHT', first >= 4],
    ['DARK_VENT', wild.extinctGeneration !== null && wild.extinctGeneration <= 3],
    ['SWARM', wild.peak >= 10],
  ]));
}

/**
 * Turns a replayed round into the ledger, the money figures and the proof bundle.
 *
 * The order is the ledger's contract: the COLONY stake debit, then one debit per
 * selected side-bet line in declaration order, then one COLONY credit per
 * harvest in generation order, then the settlement credit — which is zero after a
 * bank or an extinction, because `settle()` is still required on every path —
 * and only then the side bets, which cannot resolve before the base round has
 * reached a terminal.
 */
export function sealSettlement(input: SealInput): Settlement {
  const { seedHex, context, seedCommitment, stakeUnits, sideBetStakes, round, wild, settlementMode } =
    input;
  const exposure = ticketExposureUnits(stakeUnits, sideBetStakes);
  const terminal = publishedTerminal(round.reason, settlementMode);
  const receipts: Receipt[] = [];
  let sequence = 0;
  const push = (receipt: Omit<Receipt, 'schema' | 'sequence' | 'unitsHarvested' | 'resolved'> &
    Partial<Pick<Receipt, 'unitsHarvested' | 'resolved'>>): void => {
    sequence += 1;
    receipts.push(
      Object.freeze({
        schema: RECEIPT_SCHEMA,
        sequence,
        unitsHarvested: 0,
        resolved: null,
        ...receipt,
      }) as Receipt,
    );
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
    const multiplier = cohortValue(entry.generation, entry.harvest);
    const credit = payableWithinCap(
      multiply(rational(stakeUnits), multiplier),
      stakeUnits,
      SWARM.risk.colonyMaxWinMultiple,
      colonyCredited,
    );
    colonyCredited += credit.credited;
    push({
      kind: 'HARVEST',
      line: 'COLONY',
      direction: 'CREDIT',
      stage: entry.generation,
      unitsHarvested: entry.harvest,
      amountUnits: credit.credited,
      theoretical: credit.theoretical,
      capped: credit.capped,
    });
  }

  // A forced bank has already credited the whole colony as a HARVEST, exactly
  // like a player-initiated one, so the SETTLE receipt is zero on that path too.
  const settlementMultiplier =
    round.reason === 'THRESHOLD' || round.reason === 'FINAL'
      ? cohortValue(round.generation, round.population)
      : rational(0n);
  const settlementCredit = payableWithinCap(
    multiply(rational(stakeUnits), settlementMultiplier),
    stakeUnits,
    SWARM.risk.colonyMaxWinMultiple,
    colonyCredited,
  );
  colonyCredited += settlementCredit.credited;
  push({
    kind: 'SETTLE',
    line: 'COLONY',
    direction: 'CREDIT',
    stage: round.generation,
    amountUnits: settlementCredit.credited,
    theoretical: settlementCredit.theoretical,
    capped: settlementCredit.capped,
    terminal,
  });

  const won = resolveSideBets(wild);
  const sideBetResults: { id: string; resolved: SideBetResolution }[] = [];
  for (const bet of SIDE_BETS) {
    const stake = sideBetStakes[bet.id];
    if (stake === undefined) {
      sideBetResults.push({ id: bet.id, resolved: 'NOT_SELECTED' });
      continue;
    }
    const winner = won.get(bet.id) === true;
    const credit = winner
      ? payableWithinCap(multiply(rational(stake), bet.multiplier), stake, bet.capMultiple, 0n)
      : { theoretical: rational(0n), credited: 0n, capped: false };
    sideBetResults.push({ id: bet.id, resolved: winner ? 'WON' : 'LOST' });
    push({
      kind: 'SIDE_BET',
      line: bet.id,
      direction: 'CREDIT',
      stage: SWARM.ladder.stages,
      resolved: winner ? 'WON' : 'LOST',
      amountUnits: credit.credited,
      theoretical: credit.theoretical,
      capped: credit.capped,
    });
  }

  const chain = actionChain(seedCommitment, round.events);
  const body = bodyCommitment({
    seedCommitment,
    revealedSeed: seedHex,
    context,
    stakeUnits,
    sideBetStakes,
    round,
    wild,
    sideBetResults,
    receipts,
    chainTerminal: chain.terminal,
    settlementMode,
  });

  let creditedUnits = 0n;
  let stakedUnits = 0n;
  for (const receipt of receipts) {
    if (receipt.capped)
      fail('INVALID_ADAPTER', 'A cap truncated a credit, which the risk policy proves impossible');
    if (receipt.direction === 'CREDIT') creditedUnits += receipt.amountUnits;
    else stakedUnits += receipt.amountUnits;
  }
  if (creditedUnits > exposure)
    fail('INVALID_ADAPTER', 'A ticket credited more than its disclosed worst-case exposure');

  return frozenCopy({
    receipts,
    creditedUnits,
    stakedUnits,
    exposureUnits: exposure,
    round,
    proof: {
      seedCommitment,
      bodyCommitment: body,
      actionChain: chain.terminal,
      liveChainValues: chain.values,
      revealedSeed: seedHex,
      roundId: context.roundId,
      clientEntropy: context.clientEntropy,
      adapterFingerprint: adapterFingerprint(),
      stakeUnits,
      sideBetStakes,
      actionLog: round.actions,
      populations: round.trace.map((entry) => entry.population),
      terminal,
      settlementMode,
      sideBetResults,
      wild,
    },
  });
}
