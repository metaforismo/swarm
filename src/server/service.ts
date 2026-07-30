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
 * no authenticated storage and no durable seed custody — `docs/MATH.md` §15 lists
 * what a real deployment would need, and nothing here substitutes for it.
 */
import { randomBytes } from 'node:crypto';
import { SWARM } from './adapter.ts';
import {
  StageBook,
  type CommandResult,
  type StageBookView,
  type StageFrame,
} from './book.ts';
import { seedCommitment } from './commitment.ts';
import { roundContext } from './derivation.ts';
import { normalizeSeed } from './engine.ts';
import { fail } from './errors.ts';
import { Pacer, parsePacing, type Admission, type PacingFloors } from './pacing.ts';
import { SessionProtection } from './protection.ts';
import {
  frozenCopy,
  snapshotAdvanceRequest,
  snapshotHarvestRequest,
  snapshotOpenRequest,
  snapshotSettleRequest,
} from './snapshot.ts';
import type { Settlement } from './settlement.ts';
import { Wallet } from './wallet.ts';

export interface ServiceOptions {
  /** Free-play opening balance, in minor units. */
  readonly openingBalanceUnits?: bigint;
  /** Test-only deterministic seed seam. Rejected unless `NODE_ENV === 'test'`. */
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
  /**
   * `docs/DESIGN.md` §9.7's speed-of-play floors, enforced server-side as waits.
   * Measured on the real wall clock, not on `clock` — see `./pacing.ts`. Tests
   * that drive many rounds set them to zero.
   */
  readonly pacing?: Partial<PacingFloors>;
  /** `docs/DESIGN.md` §9.9's reality-check interval. Default 30 minutes. */
  readonly realityCheckMinutes?: number;
  /** How long a *loosened* session limit waits before it binds. Default 24 hours. */
  readonly limitCoolOffHours?: number;
}

interface RoundRecord {
  readonly roundId: string;
  /** Null until `open()`: the grid is a function of the client entropy too. */
  book: StageBook | null;
  readonly seed: string;
  /** Phase 1, published before the round could accept a stake. */
  readonly seedCommitment: string;
  readonly createdAt: number;
  /** Last receipt sequence committed to the wallet, independent of public copies. */
  postedLedgerSequence: number;
  lastCommandAt: number;
  settledAt: number | null;
}

export interface RoundRecordView {
  readonly roundId: string;
  readonly book: StageBookView | null;
  readonly seedCommitment: string;
  readonly createdAt: number;
  readonly lastCommandAt: number;
  readonly settledAt: number | null;
}

export interface WalletView {
  readonly openingUnits: bigint;
  readonly balanceUnits: bigint;
  readonly stakedUnits: bigint;
  readonly creditedUnits: bigint;
  readonly netUnits: bigint;
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
  readonly startedAt: number;
  readonly abandonedRoundTimeoutHours: number;
  /** §9.7's floors, and the gate that enforces them. */
  readonly pacer: Pacer;
  /** §9.9's limits, reality check and help resources. */
  readonly protection: SessionProtection;
  readonly #clock: () => number;
  readonly #seedSource: (roundId: string) => string;
  readonly #roundIdSource: (counter: number) => string;
  readonly #maxLiveRounds: number;
  readonly #historyLimit: number;
  readonly #wallet: Wallet;
  readonly #rounds = new Map<string, RoundRecord>();
  readonly #history: HistoryEntry[] = [];
  readonly #issuedSeeds = new Set<string>();
  #counter = 0;

  constructor(options: ServiceOptions = {}) {
    // Options are an in-process public boundary too. Copy each property once so
    // a getter cannot pass a custody check and then install a different value.
    const openingBalanceUnits = options.openingBalanceUnits;
    const seedSource = options.seedSource;
    const roundIdSource = options.roundIdSource;
    const clock = options.clock;
    const abandonedRoundTimeoutHours = options.abandonedRoundTimeoutHours;
    const maxLiveRounds = options.maxLiveRounds;
    const historyLimit = options.historyLimit;
    const pacing = options.pacing;
    const realityCheckMinutes = options.realityCheckMinutes;
    const limitCoolOffHours = options.limitCoolOffHours;
    if (seedSource !== undefined && process.env.NODE_ENV !== 'test')
      fail(
        'INVALID_REQUEST',
        'A caller-provided seed source is available only to the test harness',
        '$.seedSource',
      );
    this.#wallet = new Wallet(openingBalanceUnits ?? DEFAULT_OPENING);
    this.#clock = clock ?? (() => Date.now());
    this.#seedSource = seedSource ?? (() => randomBytes(32).toString('hex'));
    this.#roundIdSource =
      roundIdSource ?? ((counter) => `swarm-${counter}-${randomBytes(6).toString('hex')}`);
    this.abandonedRoundTimeoutHours =
      abandonedRoundTimeoutHours ?? SWARM.lifecycle.abandonedRoundTimeoutHours;
    this.#maxLiveRounds = maxLiveRounds ?? 64;
    this.#historyLimit = historyLimit ?? 50;
    this.startedAt = this.#clock();
    this.pacer = new Pacer(parsePacing(pacing));
    this.protection = new SessionProtection({
      clock: this.#clock,
      startedAt: this.startedAt,
      realityCheckMinutes,
      limitCoolOffHours,
    });
  }

  /**
   * The binding session limit, if the player set one that now refuses a stake of
   * `ticketUnits`. Published in the session view so the client can show a locked
   * state instead of provoking a refusal to find out (`docs/DESIGN.md` §9.9).
   *
   * The default probe is the **smallest legal ticket**, not zero. "Is a stake of
   * nothing refused?" is never the question a stake budget answers — under a
   * budget of exactly what has been staked, a zero probe reports no limit while
   * every real stake is refused, and the client would render an unlocked screen
   * in front of a locked session.
   */
  limitReached(
    ticketUnits = SWARM.risk.minStakeUnits,
  ): { field: string; message: string; path: string } | null {
    return this.protection.reached(ticketUnits, this.#wallet.stakedUnits, this.#wallet.netUnits);
  }

  get now(): number {
    return this.#clock();
  }

  get history(): readonly HistoryEntry[] {
    return frozenCopy(this.#history);
  }

  get wallet(): WalletView {
    return frozenCopy({
      openingUnits: this.#wallet.openingUnits,
      balanceUnits: this.#wallet.balanceUnits,
      stakedUnits: this.#wallet.stakedUnits,
      creditedUnits: this.#wallet.creditedUnits,
      netUnits: this.#wallet.netUnits,
    });
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
    let seed: string | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = normalizeSeed(this.#seedSource(roundId));
      if (this.#issuedSeeds.has(candidate)) continue;
      seed = candidate;
      break;
    }
    if (seed === null)
      fail('INVALID_REQUEST', 'The server seed source repeatedly produced a collision', '$.seed');
    this.#issuedSeeds.add(seed);
    const commitment = seedCommitment(seed, roundId);
    const createdAt = this.#clock();
    this.#rounds.set(roundId, {
      roundId,
      book: null,
      seed,
      seedCommitment: commitment,
      createdAt,
      postedLedgerSequence: 0,
      lastCommandAt: createdAt,
      settledAt: null,
    });
    // The book cannot exist before the client entropy does — every draw is a
    // function of both halves — so the record holds the seed and waits.
    return Object.freeze({ roundId, seedCommitment: commitment, createdAt });
  }

  #record(roundId: unknown): RoundRecord {
    if (typeof roundId !== 'string') fail('INVALID_REQUEST', 'Round id must be a string', '$.roundId');
    const record = this.#rounds.get(roundId);
    if (record === undefined) fail('ROUND_NOT_FOUND', 'No such round', '$.roundId');
    return record;
  }

  #book(roundId: unknown): StageBook {
    const record = this.#record(roundId);
    if (record.book === null)
      fail('INVALID_REQUEST', 'This round has not been opened', '$.roundId');
    return record.book;
  }

  record(roundId: unknown): RoundRecordView {
    const record = this.#record(roundId);
    return frozenCopy({
      roundId: record.roundId,
      book: record.book?.view ?? null,
      seedCommitment: record.seedCommitment,
      createdAt: record.createdAt,
      lastCommandAt: record.lastCommandAt,
      settledAt: record.settledAt,
    });
  }

  book(roundId: unknown): StageBookView {
    return this.#book(roundId).view;
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
  ): Promise<CommandResult<null>> {
    const snapshot = snapshotOpenRequest(request);
    const record = this.#record(roundId);
    const admission = this.pacer.admitOpen(record.roundId);
    return this.#paced(admission, () => {
      if (record.book !== null) {
        // An existing book can only return an exact retry here. Conflicts and stale
        // fences throw, and neither outcome advances the abandonment clock.
        const result = record.book.open(snapshot);
        return { result, progressed: false };
      }
      const total =
        snapshot.stakeUnits +
        snapshot.sideBets.reduce((sum, selection) => sum + selection.stakeUnits, 0n);
      // A player-set limit is checked before the wallet and before the grid: the
      // one thing a limit refuses is a stake, and it refuses it before any money
      // moves and before a seed-dependent value exists (`docs/DESIGN.md` §9.9).
      this.protection.assertMayStake(total, this.#wallet.stakedUnits, this.#wallet.netUnits);
      this.#wallet.assertCanAfford(total);
      const context = roundContext(record.roundId, snapshot.clientEntropy);
      const book = new StageBook(context, record.seed, record.seedCommitment);
      const result = book.open(snapshot);
      // The money moves before the round is registered: a wallet that refused the
      // debit must not leave an opened round behind it.
      this.#postReceipts(record, result.receipts);
      record.book = book;
      record.lastCommandAt = this.#clock();
      this.pacer.progressed(record.roundId);
      return { result, progressed: true };
    });
  }

  advance(
    roundId: string,
    request: { idempotencyKey: string; expectedFrameRevision: number },
  ): Promise<CommandResult<null>> {
    const snapshot = snapshotAdvanceRequest(request);
    const record = this.#record(roundId);
    const book = this.#book(roundId);
    return this.#paced(this.pacer.admitCommand(record.roundId), () => {
      const before = book.revision;
      const result = book.advance(snapshot);
      const progressed = book.revision !== before;
      if (progressed) {
        record.lastCommandAt = this.#clock();
        this.pacer.progressed(record.roundId);
      }
      return { result, progressed };
    });
  }

  harvest(
    roundId: string,
    request: { idempotencyKey: string; expectedFrameRevision: number; units: number },
  ): Promise<CommandResult<null>> {
    const snapshot = snapshotHarvestRequest(request);
    const record = this.#record(roundId);
    const book = this.#book(roundId);
    return this.#paced(this.pacer.admitCommand(record.roundId), () => {
      const before = book.ledgerSequence;
      const result = book.harvest(snapshot);
      const progressed = book.ledgerSequence !== before;
      if (progressed) {
        this.#postReceipts(record, result.receipts);
        record.lastCommandAt = this.#clock();
        this.pacer.progressed(record.roundId);
      }
      return { result, progressed };
    });
  }

  settle(
    roundId: string,
    request: { idempotencyKey: string; expectedFrameRevision: number },
  ): Promise<CommandResult<Settlement>> {
    const record = this.#record(roundId);
    const snapshot = snapshotSettleRequest(request, record.seed);
    const book = this.#book(roundId);
    return this.#paced(this.pacer.admitCommand(record.roundId), () => {
      const alreadySettled = book.settled;
      const result = book.settle(snapshot);
      if (!alreadySettled) this.#closeRound(record, result);
      return { result, progressed: !alreadySettled };
    });
  }

  /**
   * The abandonment rule. Refused with `TOO_EARLY` before the timeout, exactly as
   * §5.5 requires, and driven by the injected clock so the rule is testable
   * without waiting three days.
   */
  reconcile(roundId: string): CommandResult<Settlement> {
    const record = this.#record(roundId);
    const book = this.#book(roundId);
    const alreadySettled = book.settled;
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
    return this.#book(roundId).frame;
  }

  #closeRound(record: RoundRecord, result: CommandResult<Settlement>): void {
    this.#postReceipts(record, result.receipts);
    // The settlement hold (§9.7): the next round cannot open inside it.
    this.pacer.settled(record.roundId);
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

  /**
   * Commits only the next contiguous custody-held ledger suffix. Public receipt
   * arrays never participate in this cursor, so changing a returned copy cannot
   * make an old movement look unposted.
   */
  #postReceipts(record: RoundRecord, receipts: readonly import('./settlement.ts').Receipt[]): void {
    if (receipts.length === 0) return;
    let expected = record.postedLedgerSequence + 1;
    for (const receipt of receipts) {
      if (receipt.sequence !== expected)
        fail('INTERNAL', 'The wallet posting is not the next ledger suffix');
      expected += 1;
    }
    this.#wallet.post(receipts);
    record.postedLedgerSequence = expected - 1;
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
        this.pacer.forget(record.roundId);
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
      if (oldest === undefined) continue;
      this.#rounds.delete(oldest.roundId);
      this.pacer.forget(oldest.roundId);
    }
  }

  async #paced<T>(
    admission: Admission,
    run: () => { readonly result: T; readonly progressed: boolean },
  ): Promise<T> {
    // Timers may wake a millisecond early because their delay and Date.now() use
    // different rounding boundaries. Re-check the wall-clock deadline so the
    // published floor is a true minimum, including for direct service callers.
    const admittedAt = Date.now();
    const notBefore = admittedAt + admission.waitMs;
    let remaining = notBefore - Date.now();
    while (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      remaining = notBefore - Date.now();
    }
    try {
      const outcome = run();
      if (!outcome.progressed) admission.release();
      return outcome.result;
    } catch (error) {
      admission.release();
      throw error;
    }
  }
}
