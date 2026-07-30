/**
 * `StageBook` — the server-authoritative round, exactly the lifecycle in
 * `docs/ENGINE.md` §5.
 *
 * ```
 *   IDLE --open()--> STAGED --advance()/harvest(k<n)--> STAGED
 *                       |  advance() to a terminal, or harvest(k = n)
 *                       v
 *              AWAITING_SETTLEMENT --settle()/reconcile()--> SETTLED
 * ```
 *
 * The discipline it inherits from `RoundBook` and does not re-invent: every
 * mutating call carries `expectedFrameRevision` and a stale one fails
 * `STALE_FRAME` having mutated nothing; every command binds its idempotency key
 * to a canonical fingerprint of its payload, so an exact retry replays the
 * receipts *and* the frame while a changed payload under the same key fails
 * `IDEMPOTENCY_CONFLICT`; frame revision and ledger sequence advance
 * independently; and everything is computed before anything is mutated.
 *
 * The book never advances itself. There is no timer, no auto-advance and no
 * in-round plan the server executes on the player's behalf — the one
 * server-initiated transition in the module is `reconcile()`, §5.5.
 */
import {
  SIDE_BET_IDS,
  SWARM,
  cohortValue,
  ladderValue,
  ticketExposureUnits,
} from './adapter.ts';
import { extendChain, publishedTerminal, type PublishedTerminal, type SettlementMode } from './commitment.ts';
import {
  actionKind,
  deriveGrid,
  replayRound,
  resolveStage,
  roundContext,
  stageOutcomes,
  wildLineOf,
  wildPeakThrough,
  type ActionKind,
  type ChainEvent,
  type LoggedAction,
  type RoundContext,
  type RoundReplay,
  type SlotOutcome,
  type TerminalReason,
  type TraceEntry,
  type WildLine,
} from './derivation.ts';
import { assertIdempotencyKey, commandFingerprint, payableWithinCap, rational, multiply, type Rational } from './engine.ts';
import { fail } from './errors.ts';
import { sealSettlement, type Receipt, type Settlement } from './settlement.ts';
import {
  frozenCopy,
  snapshotAdvanceRequest,
  snapshotFullSettleRequest,
  snapshotHarvestRequest,
  snapshotOpenRequest,
} from './snapshot.ts';

export type BookState = 'STAGED' | 'AWAITING_SETTLEMENT' | 'SETTLED';

export interface StageResolution {
  readonly stage: number;
  readonly fromUnits: number;
  /** One entry per organism that consumed a draw, in slot order. */
  readonly outcomes: readonly SlotOutcome[];
}

export interface StageFrame {
  readonly revision: number;
  readonly stage: number;
  readonly units: number;
  /** `ladderValue(stage)`, and null at stage 0, which has no ladder value. */
  readonly unitValue: Rational | null;
  readonly colonyValue: Rational | null;
  /**
   * The next generation's per-organism ladder constant — the one forward-looking
   * number `docs/DESIGN.md` §9.2 permits, because it is the price of the decision
   * and not a route back to the stake. It is never multiplied by the population.
   */
  readonly nextUnitValue: Rational | null;
  readonly decisionOpen: boolean;
  readonly terminal: PublishedTerminal | null;
  readonly state: BookState;
  readonly actionChain: string;
  /** Wild-line population at the stage the player has just resolved. Never a later one. */
  readonly wildUnits: number;
  readonly wildPeakUnits: number;
  /**
   * The wild line through the stage the player has resolved, and not one
   * generation further (§5.2). It is wild-line *state*, never a bet resolution:
   * a frame never carries one, and a client derives a side bet's own chip from
   * this the way `docs/DESIGN.md` §4.2 describes.
   */
  readonly wildPopulations: readonly number[];
  readonly creditedUnits: bigint;
  /**
   * What each organism did in the generation this frame resolved — the draws the
   * colony has already consumed, and never one draw more.
   */
  readonly lastResolution: StageResolution | null;
}

export interface CommandResult<T> {
  readonly receipts: readonly Receipt[];
  readonly frame: StageFrame;
  readonly value: T;
}

export interface StageBookView {
  readonly context: RoundContext;
  readonly seedCommitment: string;
  readonly frame: StageFrame;
  readonly receipts: readonly Receipt[];
  readonly settlement: Settlement | null;
  readonly opened: boolean;
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
  readonly state: BookState;
  readonly exposureUnits: bigint;
}

export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly stakeUnits: bigint;
  readonly sideBets: readonly { readonly id: string; readonly stakeUnits: bigint }[];
  /**
   * The entropy this ticket was opened with. It is part of the command payload —
   * it decides every draw — so it is bound into the idempotency fingerprint and
   * checked against the round the book is already derived from.
   */
  readonly clientEntropy: string;
}

export interface AdvanceRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
}

export interface HarvestRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly units: number;
}

export interface SettleRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly revealedSeed: string;
}

interface StoredCommand {
  readonly fingerprint: string;
  readonly result: CommandResult<unknown>;
}

interface TicketSnapshot {
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
}

export class StageBook {
  readonly context: RoundContext;
  readonly seedCommitment: string;
  readonly #seed: string;
  readonly #grid: Uint8Array;
  readonly #wild: WildLine;

  #revision = 0;
  #stage = 0;
  #units = SWARM.seedUnits;
  #decisionOpen = false;
  #state: BookState = 'STAGED';
  #terminal: TerminalReason | null = null;
  #published: PublishedTerminal | null = null;
  #opened = false;

  #ticket: TicketSnapshot | null = null;
  #trace: TraceEntry[] = [];
  #actions: LoggedAction[] = [];
  #chain: string[] = [];
  #receipts: Receipt[] = [];
  #ledgerSequence = 0;
  #colonyCredited = 0n;
  #settlement: Settlement | null = null;
  #lastResolution: StageResolution | null = null;
  readonly #commands = new Map<string, StoredCommand>();

  constructor(context: RoundContext, seedHex: string, seedCommitment: string) {
    const roundId = context.roundId;
    const clientEntropy = context.clientEntropy;
    this.context = roundContext(roundId, clientEntropy);
    this.#seed = seedHex;
    this.seedCommitment = seedCommitment;
    this.#grid = deriveGrid(seedHex, this.context);
    this.#wild = wildLineOf(this.#grid);
    this.#chain.push(seedCommitment);
  }

  get frame(): StageFrame {
    return this.#frame();
  }

  get receipts(): readonly Receipt[] {
    return frozenCopy(this.#receipts);
  }

  get settlement(): Settlement | null {
    return frozenCopy(this.#settlement);
  }

  get opened(): boolean {
    return this.#opened;
  }

  get stakeUnits(): bigint {
    return this.#ticket?.stakeUnits ?? 0n;
  }

  get sideBetStakes(): Readonly<Record<string, bigint>> {
    return frozenCopy(this.#ticket?.sideBetStakes ?? {});
  }

  get state(): BookState {
    return this.#state;
  }

  get revision(): number {
    return this.#revision;
  }

  get settled(): boolean {
    return this.#settlement !== null;
  }

  /** Exposure disclosed at `open()`, in minor units. A disclosure, never a clip. */
  get exposureUnits(): bigint {
    return this.#ticket === null
      ? 0n
      : ticketExposureUnits(this.#ticket.stakeUnits, this.#ticket.sideBetStakes);
  }

  get ledgerSequence(): number {
    return this.#ledgerSequence;
  }

  get view(): StageBookView {
    return frozenCopy({
      context: this.context,
      seedCommitment: this.seedCommitment,
      frame: this.#frame(),
      receipts: this.#receipts,
      settlement: this.#settlement,
      opened: this.#opened,
      stakeUnits: this.#ticket?.stakeUnits ?? 0n,
      sideBetStakes: this.#ticket?.sideBetStakes ?? {},
      state: this.#state,
      exposureUnits: this.exposureUnits,
    });
  }

  // ---------------------------------------------------------------- commands

  /**
   * Debits the ticket and binds the client entropy. One `DEBIT` receipt per line
   * and nothing else: no seed-dependent value may leave this call (§5.2).
   */
  open(request: OpenRequest): CommandResult<null> {
    const snapshot = snapshotOpenRequest(request);
    return this.#command(
      'open',
      snapshot.idempotencyKey,
      snapshot.expectedFrameRevision,
      [
        snapshot.stakeUnits,
        snapshot.clientEntropy.toLowerCase(),
        ...this.#sideBetFields(snapshot.sideBets),
      ],
      () => {
        if (this.#opened) fail('INVALID_REQUEST', 'This round is already open', '$.roundId');
        if (snapshot.clientEntropy.toLowerCase() !== this.context.clientEntropy)
          fail('INVALID_REQUEST', 'This round is bound to a different client seed', '$.clientEntropy');
        const stakeUnits = assertStake(
          snapshot.stakeUnits,
          SWARM.risk.minStakeUnits,
          SWARM.risk.maxStakeUnits,
          '$.stakeUnits',
        );
        const sideBetStakes: Record<string, bigint> = {};
        for (const selection of snapshot.sideBets) {
          if (!SIDE_BET_IDS.includes(selection.id))
            fail('INVALID_REQUEST', `No such side bet: ${selection.id}`, '$.sideBets');
          if (sideBetStakes[selection.id] !== undefined)
            fail('INVALID_REQUEST', `Side bet ${selection.id} was selected twice`, '$.sideBets');
          sideBetStakes[selection.id] = assertStake(
            selection.stakeUnits,
            SWARM.risk.minSideBetStakeUnits,
            SWARM.risk.maxSideBetStakeUnits,
            `$.sideBets.${selection.id}`,
          );
        }
        // The operator admission check, before any money moves. A refusal happens
        // here or not at all; nothing is ever truncated at settlement to fit it.
        const exposure = ticketExposureUnits(stakeUnits, sideBetStakes);
        if (exposure >= SWARM.risk.maxTicketExposureUnits)
          fail('EXPOSURE_LIMIT', 'This ticket exceeds the operator exposure limit', '$.stakeUnits');

        this.#ticket = Object.freeze({
          stakeUnits,
          sideBetStakes: Object.freeze(sideBetStakes),
        });
        this.#opened = true;
        const receipts: Receipt[] = [
          this.#push({
            kind: 'OPEN',
            line: 'COLONY',
            direction: 'DEBIT',
            stage: 0,
            amountUnits: stakeUnits,
            theoretical: null,
            capped: false,
          }),
        ];
        for (const id of SIDE_BET_IDS) {
          const amount = sideBetStakes[id];
          if (amount === undefined) continue;
          receipts.push(
            this.#push({
              kind: 'OPEN',
              line: id,
              direction: 'DEBIT',
              stage: 0,
              amountUnits: amount,
              theoretical: null,
              capped: false,
            }),
          );
        }
        this.#revision += 1;
        return { receipts, value: null };
      },
    );
  }

  /**
   * Resolves the next generation. At stage 0 this is the mandatory generation 1,
   * which carries no decision; from stage 1 on, an advance with the decision still
   * open commits that stage as `CONTINUE` (`k = 0`) before the next row resolves.
   */
  advance(request: AdvanceRequest): CommandResult<null> {
    const snapshot = snapshotAdvanceRequest(request);
    return this.#command('advance', snapshot.idempotencyKey, snapshot.expectedFrameRevision, [], () => {
      this.#requireLive();
      if (this.#stage >= 1 && this.#decisionOpen) this.#logAction(this.#stage, 0);
      const stage = this.#stage + 1;
      const outcomes = stageOutcomes(this.#grid, stage, this.#units);
      const units = resolveStage(this.#grid, stage, this.#units);
      this.#lastResolution = { stage, fromUnits: this.#units, outcomes };
      this.#stage = stage;
      this.#units = units;
      this.#trace.push({ generation: stage, population: units });
      this.#fold({ kind: 'RESOLVE', generation: stage, value: units });
      if (units === 0) this.#reachTerminal('EXTINCT');
      else if (units >= SWARM.thresholds.settleAtOrAbove) this.#reachTerminal('THRESHOLD');
      else if (stage === SWARM.ladder.stages) this.#reachTerminal('FINAL');
      else this.#decisionOpen = true;
      this.#revision += 1;
      return { receipts: [], value: null };
    });
  }

  /**
   * Credits `units` organisms now, at this generation's exact yield.
   *
   * `units === population` is a full BANK and reaches `AWAITING_SETTLEMENT` with
   * terminal `BANKED`; anything less keeps the round live at the same stage with
   * the decision closed, because a stage accepts exactly one harvest commitment
   * (§5.3). Every legal `k` is accepted, which is what makes the published
   * volatility interval reachable (`docs/MATH.md` §11).
   */
  harvest(request: HarvestRequest): CommandResult<null> {
    const snapshot = snapshotHarvestRequest(request);
    return this.#command(
      'harvest',
      snapshot.idempotencyKey,
      snapshot.expectedFrameRevision,
      [snapshot.units],
      () => {
        this.#requireLive();
        if (this.#stage === 0)
          fail('INVALID_REQUEST', 'Generation 1 is mandatory and carries no decision', '$.units');
        if (!this.#decisionOpen)
          fail('INVALID_REQUEST', 'This generation has already committed its decision', '$.units');
        const units = snapshot.units;
        if (!Number.isSafeInteger(units) || units <= 0 || units > this.#units)
          fail('INVALID_REQUEST', `Harvest must be between 1 and ${this.#units}`, '$.units');

        const multiplier = cohortValue(this.#stage, units);
        const credit = payableWithinCap(
          multiply(rational(this.#ticketStakeUnits()), multiplier),
          this.#ticketStakeUnits(),
          SWARM.risk.colonyMaxWinMultiple,
          this.#colonyCredited,
        );
        if (credit.capped)
          fail('INVALID_ADAPTER', 'A cap truncated a credit, which the risk policy forbids');

        this.#logAction(this.#stage, units);
        this.#colonyCredited += credit.credited;
        const receipt = this.#push({
          kind: 'HARVEST',
          line: 'COLONY',
          direction: 'CREDIT',
          stage: this.#stage,
          unitsHarvested: units,
          amountUnits: credit.credited,
          theoretical: credit.theoretical,
          capped: credit.capped,
        });
        this.#units -= units;
        if (this.#units === 0) this.#reachTerminal('BANKED');
        this.#revision += 1;
        return { receipts: [receipt], value: null };
      },
    );
  }

  /**
   * Reveals the seed, resolves the side bets, credits the settlement and
   * publishes the body commitment.
   *
   * `settle()` is required on every path, including a full bank: it is the only
   * call that reveals the seed, and a round whose seed is never revealed is a
   * round nobody can verify.
   */
  settle(request: SettleRequest): CommandResult<Settlement> {
    const snapshot = snapshotFullSettleRequest(request);
    return this.#command(
      'settle',
      snapshot.idempotencyKey,
      snapshot.expectedFrameRevision,
      [snapshot.revealedSeed],
      () => this.#seal(snapshot.revealedSeed, 'PLAYER'),
    );
  }

  /**
   * The abandonment rule (§5.5), executed by the operator rather than the player.
   *
   * A round still owing a decision is force-banked in whole at the exact current
   * stage value; a round at stage 0 first takes its one legal command, the
   * mandatory generation 1, and banks whatever survives; a round already at a
   * terminal simply settles at it. The stage-0 rule generalises to any stage whose
   * decision is already committed: there too `advance()` is the only legal
   * command, so performing it is performing the player's only move rather than
   * choosing between their moves.
   *
   * It is EV-neutral by construction, because every action ties
   * (`docs/MATH.md` §6). The mode is sealed into the body, so a reconciled
   * settlement is a different digest from a player-settled one.
   */
  reconcile(idempotencyKey: string): CommandResult<Settlement> {
    return this.#command('reconcile', idempotencyKey, null, [], () => {
      if (!this.#opened) fail('INVALID_REQUEST', 'This round was never opened', '$.roundId');
      // Everything from here is posted by this one call, including the forced
      // bank: unlike a player harvest, nobody credited it on the way in.
      const posted = this.#ledgerSequence;
      let guard = 0;
      while (this.#state === 'STAGED') {
        if (guard++ > SWARM.ladder.stages + 1)
          fail('INTERNAL', 'Reconciliation failed to reach a terminal');
        if (this.#stage >= 1 && this.#decisionOpen) {
          this.#forcedBank();
          break;
        }
        this.#forcedAdvance();
      }
      const sealed = this.#seal(this.#seed, 'RECONCILED');
      this.#revision += 1;
      return { receipts: this.#receipts.slice(posted), value: sealed.value };
    });
  }

  // ---------------------------------------------------------------- internals

  #forcedAdvance(): void {
    const stage = this.#stage + 1;
    const outcomes = stageOutcomes(this.#grid, stage, this.#units);
    const units = resolveStage(this.#grid, stage, this.#units);
    this.#lastResolution = { stage, fromUnits: this.#units, outcomes };
    this.#stage = stage;
    this.#units = units;
    this.#trace.push({ generation: stage, population: units });
    this.#fold({ kind: 'RESOLVE', generation: stage, value: units });
    if (units === 0) this.#reachTerminal('EXTINCT');
    else if (units >= SWARM.thresholds.settleAtOrAbove) this.#reachTerminal('THRESHOLD');
    else if (stage === SWARM.ladder.stages) this.#reachTerminal('FINAL');
    else this.#decisionOpen = true;
    this.#revision += 1;
  }

  #forcedBank(): void {
    const units = this.#units;
    const multiplier = cohortValue(this.#stage, units);
    const credit = payableWithinCap(
      multiply(rational(this.#ticketStakeUnits()), multiplier),
      this.#ticketStakeUnits(),
      SWARM.risk.colonyMaxWinMultiple,
      this.#colonyCredited,
    );
    this.#logAction(this.#stage, units);
    this.#colonyCredited += credit.credited;
    this.#push({
      kind: 'HARVEST',
      line: 'COLONY',
      direction: 'CREDIT',
      stage: this.#stage,
      unitsHarvested: units,
      amountUnits: credit.credited,
      theoretical: credit.theoretical,
      capped: credit.capped,
    });
    this.#units = 0;
    this.#reachTerminal('BANKED');
    this.#revision += 1;
  }

  /**
   * Seals the round: replays the grid from the logged actions, checks the replay
   * against what the book actually did, and produces the ledger and the proof
   * through the same function the verifier uses.
   */
  #seal(revealedSeed: string, mode: SettlementMode): { receipts: Receipt[]; value: Settlement } {
    if (this.#state === 'SETTLED')
      fail('ROUND_SETTLED', 'This round is already settled', '$.roundId', {
        terminal: this.#published,
      });
    if (this.#state !== 'AWAITING_SETTLEMENT')
      fail('INVALID_REQUEST', 'This round has not reached a terminal', '$.roundId');
    if (revealedSeed !== this.#seed)
      fail('COMMITMENT_MISMATCH', 'The revealed seed is not the sealed seed', '$.revealedSeed');

    const replay = this.#replayFromLog();
    const sealed = sealSettlement({
      seedHex: this.#seed,
      context: this.context,
      seedCommitment: this.seedCommitment,
      stakeUnits: this.#ticketStakeUnits(),
      sideBetStakes: this.#ticketSideBetStakes(),
      round: replay,
      wild: this.#wild,
      settlementMode: mode,
    });

    // The live ledger must be a prefix of the sealed one, amount for amount.
    // Anything else is an internal accounting bug, never a payout.
    for (let index = 0; index < this.#ledgerSequence; index += 1) {
      const live = this.#receipts[index] as Receipt;
      const sealedReceipt = sealed.receipts[index];
      if (
        sealedReceipt === undefined ||
        live.kind !== sealedReceipt.kind ||
        live.line !== sealedReceipt.line ||
        live.direction !== sealedReceipt.direction ||
        live.stage !== sealedReceipt.stage ||
        live.amountUnits !== sealedReceipt.amountUnits
      )
        fail('INTERNAL', 'The live ledger disagrees with the sealed settlement');
    }

    const posted = sealed.receipts.slice(this.#ledgerSequence);
    this.#receipts = [...sealed.receipts];
    this.#ledgerSequence = sealed.receipts.length;
    this.#settlement = sealed;
    this.#published = sealed.proof.terminal;
    this.#state = 'SETTLED';
    return { receipts: posted, value: sealed };
  }

  /** Replays the committed grid from the logged actions, and nothing else. */
  #replayFromLog(): RoundReplay {
    const log = [...this.#actions];
    let cursor = 0;
    const replay = replayRound(this.#grid, (generation, population) => {
      const entry = log[cursor];
      cursor += 1;
      if (entry === undefined || entry.generation !== generation)
        return fail('INTERNAL', 'The action log does not match the round the book played');
      if (entry.units > population)
        return fail('INTERNAL', 'The action log harvests more than the stage held');
      return entry.units;
    });
    if (cursor !== log.length) fail('INTERNAL', 'The action log has trailing entries');
    if (replay.reason !== this.#terminal || replay.generation !== this.#stage)
      fail('INTERNAL', 'The replay disagrees with the book about the terminal');
    return replay;
  }

  #logAction(stage: number, units: number): void {
    const kind: ActionKind = actionKind(units, this.#units);
    this.#actions.push({ generation: stage, kind, units });
    const entry = this.#trace[this.#trace.length - 1] as TraceEntry;
    (entry as { harvest?: number }).harvest = units;
    (entry as { action?: ActionKind }).action = kind;
    this.#decisionOpen = false;
    this.#fold({ kind, generation: stage, value: units });
  }

  #fold(event: ChainEvent): void {
    const index = this.#chain.length - 1;
    this.#chain.push(extendChain(this.#chain[index] as string, index, event));
  }

  #reachTerminal(reason: TerminalReason): void {
    this.#terminal = reason;
    this.#decisionOpen = false;
    this.#state = 'AWAITING_SETTLEMENT';
  }

  #requireLive(): void {
    if (!this.#opened) fail('INVALID_REQUEST', 'This round has not been opened', '$.roundId');
    if (this.#state !== 'STAGED')
      fail('ROUND_SETTLED', 'This round has already reached its terminal', '$.roundId', {
        terminal: this.#published ?? this.#terminal,
        state: this.#state,
      });
  }

  #ticketStakeUnits(): bigint {
    if (this.#ticket === null) return fail('INTERNAL', 'An opened round has no wager ticket');
    return this.#ticket.stakeUnits;
  }

  #ticketSideBetStakes(): Readonly<Record<string, bigint>> {
    if (this.#ticket === null) return fail('INTERNAL', 'An opened round has no wager ticket');
    return this.#ticket.sideBetStakes;
  }

  #push(receipt: Omit<Receipt, 'schema' | 'sequence' | 'unitsHarvested' | 'resolved'> &
    Partial<Pick<Receipt, 'unitsHarvested' | 'resolved'>>): Receipt {
    this.#ledgerSequence += 1;
    const sealed = Object.freeze({
      schema: 'receipt-v2' as const,
      sequence: this.#ledgerSequence,
      unitsHarvested: 0,
      resolved: null,
      ...receipt,
    }) as Receipt;
    this.#receipts.push(sealed);
    return sealed;
  }

  #sideBetFields(selections: readonly { id: string; stakeUnits: bigint }[] = []): (string | bigint)[] {
    const fields: (string | bigint)[] = [];
    for (const selection of selections) fields.push(selection.id, selection.stakeUnits);
    return fields;
  }

  /**
   * The frame fence and the idempotency store, in that order of precedence: a
   * retry of a command that already ran replays its stored result even though the
   * revision it was fenced to has moved on.
   *
   * `expectedFrameRevision` is `null` for `reconcile()` alone, which takes the
   * round's current revision from the book rather than from a request, so it
   * cannot race a player command (§5.5) and its reserved key stays replayable
   * after the revision has moved.
   */
  #command<T>(
    action: string,
    idempotencyKey: string,
    expectedFrameRevision: number | null,
    fields: readonly (string | number | bigint)[],
    run: () => { receipts: Receipt[]; value: T },
  ): CommandResult<T> {
    assertIdempotencyKey(idempotencyKey);
    const fingerprint = commandFingerprint(action, [
      this.context.roundId,
      expectedFrameRevision === null ? 'unfenced' : expectedFrameRevision,
      ...fields,
    ]);
    const stored = this.#commands.get(idempotencyKey);
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint)
        fail(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was used for a different command',
          '$.idempotencyKey',
        );
      return frozenCopy(stored.result as CommandResult<T>);
    }
    // A round that has reached its terminal answers a play command with its
    // terminal, before the fence: a duplicate tap should show the player what
    // happened, not a staleness error about a round that can no longer move.
    if ((action === 'advance' || action === 'harvest') && this.#state !== 'STAGED')
      fail('ROUND_SETTLED', 'This round has already reached its terminal', '$.roundId', {
        terminal: this.#published ?? this.#terminal,
        state: this.#state,
      });
    if (
      expectedFrameRevision !== null &&
      (!Number.isSafeInteger(expectedFrameRevision) || expectedFrameRevision !== this.#revision)
    )
      fail(
        'STALE_FRAME',
        `This command was fenced to revision ${expectedFrameRevision}, the round is at ${this.#revision}`,
        '$.expectedFrameRevision',
        { revision: this.#revision },
      );
    const { receipts, value } = run();
    const result: CommandResult<T> = Object.freeze({
      receipts: Object.freeze([...receipts]),
      frame: this.#frame(),
      value,
    });
    this.#commands.set(idempotencyKey, { fingerprint, result });
    return frozenCopy(result);
  }

  #frame(): StageFrame {
    const stage = this.#stage;
    const settled = this.#state === 'SETTLED';
    const live = this.#state === 'STAGED';
    return frozenCopy({
      revision: this.#revision,
      stage,
      units: this.#units,
      unitValue: stage === 0 ? null : ladderValue(stage),
      colonyValue: stage === 0 ? null : cohortValue(stage, this.#units),
      nextUnitValue: live && stage < SWARM.ladder.stages ? ladderValue(stage + 1) : null,
      decisionOpen: this.#decisionOpen,
      terminal: this.#published ?? this.#terminal,
      state: this.#state,
      actionChain: this.#chain[this.#chain.length - 1] as string,
      wildUnits: stage === 0 ? SWARM.seedUnits : (this.#wild.populations[stage - 1] as number),
      wildPeakUnits: settled ? this.#wild.peak : wildPeakThrough(this.#wild, stage),
      wildPopulations: this.#wild.populations.slice(0, settled ? undefined : stage),
      lastResolution: this.#lastResolution,
      creditedUnits: this.#receipts
        .filter((receipt) => receipt.direction === 'CREDIT')
        .reduce((total, receipt) => total + receipt.amountUnits, 0n),
    });
  }
}

function assertStake(value: unknown, low: bigint, high: bigint, path: string): bigint {
  if (typeof value !== 'bigint')
    fail('INVALID_REQUEST', 'A stake must be an integer number of minor units', path);
  if (value < low || value > high)
    fail('INVALID_REQUEST', 'Stake is outside the declared bounds for this line', path);
  return value;
}

export { publishedTerminal };
