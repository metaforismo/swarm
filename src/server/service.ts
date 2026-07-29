/**
 * The round service: seed custody, the round registry, the wallet, the session.
 *
 * The publication order `docs/ENGINE.md` §4.5 depends on is enforced here and is
 * the reason `createRound()` exists as a separate call: the operator seals a seed
 * and publishes its pre-commitment **before** the client has generated its
 * entropy and before any stake is accepted. A round that has not been opened
 * holds a commitment and nothing else.
 *
 * Everything is in memory. This is a free-play prototype: there is no persistence,
 * no authenticated storage and no seed custody worth the name — `docs/MATH.md` §15
 * lists what a real deployment would need, and nothing here substitutes for it.
 */
import { randomBytes } from 'node:crypto';
import { SWARM } from './adapter.ts';
import { StageBook, type CommandResult, type StageFrame } from './book.ts';
import { seedCommitment } from './commitment.ts';
import { roundContext } from './derivation.ts';
import { fail } from './errors.ts';
import type { Settlement } from './settlement.ts';
import { Wallet } from './wallet.ts';

export interface ServiceOptions {
  /** Free-play opening balance, in minor units. */
  readonly openingBalanceUnits?: bigint;
  /** Sealed seeds. Injectable so a test can drive a known grid. */
  readonly seedSource?: (roundId: string) => string;
  /**
   * Operator round ids. Injectable because the id is a field of every draw and of
   * both commitments, so a fixture round needs both halves pinned — and because a
   * real operator brings its own id scheme.
   */
  readonly roundIdSource?: (counter: number) => string;
  /** Wall clock, in milliseconds. Injectable so the abandonment rule is testable. */
  readonly clock?: () => number;
  /** Overrides the adapter's 72 hours. Tests use it; the served config reports it. */
  readonly abandonedRoundTimeoutHours?: number;
  /** Bound on live rounds held in memory at once. */
  readonly maxLiveRounds?: number;
  /** Bound on settled rounds kept for the history view. */
  readonly historyLimit?: number;
}

export interface RoundRecord {
  readonly roundId: string;
  /** Null until `open()`: the grid is a function of the client entropy too. */
  book: StageBook | null;
  readonly seed: string;
  /** Phase 1, published before the round could accept a stake. */
  readonly seedCommitment: string;
  readonly createdAt: number;
  lastCommandAt: number;
  settledAt: number | null;
}

export interface HistoryEntry {
  readonly roundId: string;
  readonly terminal: string;
  readonly settlementMode: string;
  readonly stakedUnits: bigint;
  readonly creditedUnits: bigint;
  readonly netUnits: bigint;
  readonly generations: number;
  readonly settledAt: number;
}

const DEFAULT_OPENING = 1000n * SWARM.money.unitsPerCredit;

export class RoundService {
  readonly wallet: Wallet;
  readonly startedAt: number;
  readonly abandonedRoundTimeoutHours: number;
  readonly #clock: () => number;
  readonly #seedSource: (roundId: string) => string;
  readonly #roundIdSource: (counter: number) => string;
  readonly #maxLiveRounds: number;
  readonly #historyLimit: number;
  readonly #rounds = new Map<string, RoundRecord>();
  readonly #history: HistoryEntry[] = [];
  #counter = 0;

  constructor(options: ServiceOptions = {}) {
    this.wallet = new Wallet(options.openingBalanceUnits ?? DEFAULT_OPENING);
    this.#clock = options.clock ?? (() => Date.now());
    this.#seedSource = options.seedSource ?? (() => randomBytes(32).toString('hex'));
    this.#roundIdSource =
      options.roundIdSource ?? ((counter) => `swarm-${counter}-${randomBytes(6).toString('hex')}`);
    this.abandonedRoundTimeoutHours =
      options.abandonedRoundTimeoutHours ?? SWARM.lifecycle.abandonedRoundTimeoutHours;
    this.#maxLiveRounds = options.maxLiveRounds ?? 64;
    this.#historyLimit = options.historyLimit ?? 50;
    this.startedAt = this.#clock();
  }

  get now(): number {
    return this.#clock();
  }

  get history(): readonly HistoryEntry[] {
    return this.#history;
  }

  /**
   * **Phase 1.** Seals a seed and publishes its pre-commitment. No stake, no
   * entropy, no seed-dependent value: the player chooses their half of the
   * handshake *after* this call has happened.
   */
  createRound(): { roundId: string; seedCommitment: string; createdAt: number } {
    this.#sweep();
    const live = [...this.#rounds.values()].filter((record) => record.settledAt === null);
    if (live.length >= this.#maxLiveRounds)
      fail('INVALID_REQUEST', 'Too many open rounds; settle one before opening another', '$.rounds');
    this.#counter += 1;
    const roundId = this.#roundIdSource(this.#counter);
    if (this.#rounds.has(roundId))
      fail('INVALID_REQUEST', 'That round id is already in use', '$.roundId');
    const seed = this.#seedSource(roundId);
    const commitment = seedCommitment(seed, roundId);
    const createdAt = this.#clock();
    this.#rounds.set(roundId, {
      roundId,
      book: null,
      seed,
      seedCommitment: commitment,
      createdAt,
      lastCommandAt: createdAt,
      settledAt: null,
    });
    // The book cannot exist before the client entropy does — every draw is a
    // function of both halves — so the record holds the seed and waits.
    return { roundId, seedCommitment: commitment, createdAt };
  }

  record(roundId: unknown): RoundRecord {
    if (typeof roundId !== 'string') fail('INVALID_REQUEST', 'Round id must be a string', '$.roundId');
    const record = this.#rounds.get(roundId);
    if (record === undefined) fail('ROUND_NOT_FOUND', 'No such round', '$.roundId');
    return record;
  }

  book(roundId: unknown): StageBook {
    const record = this.record(roundId);
    if (record.book === null)
      fail('INVALID_REQUEST', 'This round has not been opened', '$.roundId');
    return record.book;
  }

  /**
   * `open()`: binds the client entropy, derives the grid, debits the ticket.
   *
   * The wallet is checked before the book is built, so a refusal happens before
   * any money moves and before a seed-dependent value exists.
   */
  open(
    roundId: string,
    request: {
      idempotencyKey: string;
      expectedFrameRevision: number;
      stakeUnits: bigint;
      sideBets: readonly { id: string; stakeUnits: bigint }[];
      clientEntropy: string;
    },
  ): CommandResult<null> {
    const record = this.record(roundId);
    if (record.book !== null) {
      // A retry lands on the existing book, which replays it through the
      // idempotency store rather than opening a second round.
      const result = record.book.open(request);
      record.lastCommandAt = this.#clock();
      return result;
    }
    const total =
      request.stakeUnits +
      (request.sideBets ?? []).reduce((sum, selection) => sum + selection.stakeUnits, 0n);
    this.wallet.assertCanAfford(total);
    const context = roundContext(roundId, request.clientEntropy);
    const book = new StageBook(context, record.seed, record.seedCommitment);
    const result = book.open(request);
    // The money moves before the round is registered: a wallet that refused the
    // debit must not leave an opened round behind it.
    this.wallet.post(result.receipts);
    record.book = book;
    record.lastCommandAt = this.#clock();
    return result;
  }

  advance(roundId: string, request: { idempotencyKey: string; expectedFrameRevision: number }): CommandResult<null> {
    const record = this.record(roundId);
    const result = this.book(roundId).advance(request);
    record.lastCommandAt = this.#clock();
    return result;
  }

  harvest(
    roundId: string,
    request: { idempotencyKey: string; expectedFrameRevision: number; units: number },
  ): CommandResult<null> {
    const record = this.record(roundId);
    const book = this.book(roundId);
    const before = book.receipts.length;
    const result = book.harvest(request);
    if (book.receipts.length > before) this.wallet.post(result.receipts);
    record.lastCommandAt = this.#clock();
    return result;
  }

  settle(
    roundId: string,
    request: { idempotencyKey: string; expectedFrameRevision: number },
  ): CommandResult<Settlement> {
    const record = this.record(roundId);
    const book = this.book(roundId);
    const alreadySettled = book.settlement !== null;
    const result = book.settle({ ...request, revealedSeed: record.seed });
    if (!alreadySettled) this.#closeRound(record, result);
    return result;
  }

  /**
   * The abandonment rule. Refused with `TOO_EARLY` before the timeout, exactly as
   * §5.5 requires, and driven by the injected clock so the rule is testable
   * without waiting three days.
   */
  reconcile(roundId: string): CommandResult<Settlement> {
    const record = this.record(roundId);
    const book = this.book(roundId);
    const alreadySettled = book.settlement !== null;
    // A settled round goes straight to the book: a reconciliation that already
    // ran replays through its reserved key, and a player-settled round answers
    // `ROUND_SETTLED`. Checking the clock first would answer `TOO_EARLY` to a
    // retry of the very call that stopped the clock.
    if (!alreadySettled && !this.#isAbandoned(record))
      fail('TOO_EARLY', 'This round is not past the abandonment timeout', '$.roundId');
    const result = book.reconcile(`reconcile:${record.roundId}`);
    if (!alreadySettled) this.#closeRound(record, result);
    return result;
  }

  /** Reconciles every round the clock has closed. Called before any round listing. */
  sweep(): number {
    return this.#sweep();
  }

  frame(roundId: string): StageFrame {
    return this.book(roundId).frame;
  }

  #closeRound(record: RoundRecord, result: CommandResult<Settlement>): void {
    this.wallet.post(result.receipts);
    const settlement = result.value;
    record.settledAt = this.#clock();
    record.lastCommandAt = record.settledAt;
    this.#history.unshift({
      roundId: record.roundId,
      terminal: settlement.proof.terminal,
      settlementMode: settlement.proof.settlementMode,
      stakedUnits: settlement.stakedUnits,
      creditedUnits: settlement.creditedUnits,
      netUnits: settlement.creditedUnits - settlement.stakedUnits,
      generations: settlement.proof.populations.length,
      settledAt: record.settledAt,
    });
    while (this.#history.length > this.#historyLimit) this.#history.pop();
    this.#evict();
  }

  #isAbandoned(record: RoundRecord): boolean {
    if (record.settledAt !== null) return false;
    const elapsed = this.#clock() - record.lastCommandAt;
    return elapsed >= this.abandonedRoundTimeoutHours * 60 * 60 * 1000;
  }

  #sweep(): number {
    let closed = 0;
    for (const record of this.#rounds.values()) {
      if (!this.#isAbandoned(record)) continue;
      // A round that was created and never opened holds no stake and no
      // transcript: there is nothing to settle, so it is simply dropped.
      if (record.book === null) {
        this.#rounds.delete(record.roundId);
        continue;
      }
      const result = record.book.reconcile(`reconcile:${record.roundId}`);
      this.#closeRound(record, result);
      closed += 1;
    }
    return closed;
  }

  /** Keeps the registry bounded: settled rounds beyond the history limit are dropped. */
  #evict(): void {
    const settled = [...this.#rounds.values()]
      .filter((record) => record.settledAt !== null)
      .sort((left, right) => (left.settledAt as number) - (right.settledAt as number));
    while (settled.length > this.#historyLimit) {
      const oldest = settled.shift();
      if (oldest !== undefined) this.#rounds.delete(oldest.roundId);
    }
  }
}
