/**
 * The speed-of-play floors of `docs/DESIGN.md` §9.7, on the server.
 *
 * §9.7 states them as properties of the product — "a whole round cannot be
 * chained faster than this, however much is skipped" — so they cannot live only
 * in the client: a script that speaks the documented API would not be bound by a
 * rule that only exists in `app.js`. This is the same three floors, enforced
 * where the round actually happens.
 *
 * They are enforced as a **wait, never a refusal**. That distinction is the
 * whole of §9.5 and §9.7: a floor governs how fast a round may be chained and
 * may never become a deadline on a decision, so a command that arrives early is
 * held until the floor has passed and then processed exactly as it would have
 * been. No floor can cost a payout, and no floor produces an error code a player
 * has to understand.
 *
 * The clock here is deliberately **not** the service's injectable clock. That
 * one models the 72-hour abandonment rule and tests move it in jumps; a pacing
 * floor is real elapsed time on a real wall clock, and a test that wants no
 * floors sets them to zero (`pacing` in `ServiceOptions`) rather than pretending
 * time passed.
 */

export interface PacingFloors {
  /** `SEED` to the next `SEED` becoming live. */
  readonly roundCycleMs: number;
  /** A resolved generation to the next command against that round. */
  readonly decisionDeadPeriodMs: number;
  /** Settlement to the next round being openable. */
  readonly settlementHoldMs: number;
}

/** `docs/DESIGN.md` §9.7, and the values `/api/config` publishes. */
export const DEFAULT_PACING: PacingFloors = Object.freeze({
  roundCycleMs: 2500,
  decisionDeadPeriodMs: 350,
  settlementHoldMs: 600,
});

export function parsePacing(input: Partial<PacingFloors> | undefined): PacingFloors {
  if (input === undefined) return DEFAULT_PACING;
  const floor = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
  return Object.freeze({
    roundCycleMs: floor(input.roundCycleMs, DEFAULT_PACING.roundCycleMs),
    decisionDeadPeriodMs: floor(input.decisionDeadPeriodMs, DEFAULT_PACING.decisionDeadPeriodMs),
    settlementHoldMs: floor(input.settlementHoldMs, DEFAULT_PACING.settlementHoldMs),
  });
}

/**
 * A reserved slot.
 *
 * `release()` gives it back, and is called when the command the slot was taken for
 * was **refused**. A floor governs how fast a round may be *cycled*, and a command
 * that was rejected never cycled one: a malformed payload, a stake a session limit
 * refuses, or a command fenced to a stale frame has not consumed a round. Charging
 * it a floor would make the game slower to argue with than to play, and would let
 * a client hold a connection per piece of garbage it sends.
 *
 * Releasing is deliberately conservative: it rolls a gate back only when nothing
 * has reserved since, so a release can never admit a later command early. It can
 * only ever give back time the refused command itself was holding.
 */
export interface Admission {
  /** Milliseconds the command must wait before it runs. */
  readonly waitMs: number;
  /** Hands the slot back, because the command it was taken for was refused. */
  release(): void;
}

/**
 * A one-token gate per floor.
 *
 * `admit` reserves the slot at call time rather than measuring backwards from
 * the last completed command, so N commands arriving together are spaced by the
 * floor instead of all observing the same "last command" and firing at once.
 */
export class Pacer {
  readonly floors: PacingFloors;
  readonly #now: () => number;
  /** Earliest moment the next `open` may be admitted. */
  #openGate = 0;
  /**
   * A settlement hold no release may undo. Raised by `settled()`, never lowered.
   *
   * Without it, a release could roll `#openGate` back past a hold that landed
   * *after* the released command reserved its slot: a client with a refused `open`
   * queued behind a real round could settle that round and then open the next one
   * inside the 600 ms hold. A rollback returns a slot; it may never shorten a floor
   * somebody else established.
   */
  #openFloor = 0;
  /** Earliest moment the next command against a given round may be admitted. */
  readonly #roundGate = new Map<string, number>();

  constructor(floors: PacingFloors, now: () => number = () => Date.now()) {
    this.floors = floors;
    this.#now = now;
  }

  /** Reserves the next `open` slot. */
  admitOpen(roundId: string): Admission {
    const now = this.#now();
    // A round already open can be `open`ed again — a retry, or a stale fence — so
    // this may be displacing an existing dead period rather than creating one.
    const previous = this.#roundGate.get(roundId);
    const at = Math.max(now, this.#openGate, this.#openFloor);
    const gate = at + this.floors.roundCycleMs;
    const roundGate = at + this.floors.decisionDeadPeriodMs;
    this.#openGate = gate;
    this.#roundGate.set(roundId, roundGate);
    return {
      waitMs: at - now,
      release: () => {
        if (this.#openGate === gate) this.#openGate = Math.max(at, this.#openFloor);
        this.#restore(roundId, roundGate, previous);
      },
    };
  }

  /** Reserves the next slot for a command against a live round. */
  admitCommand(roundId: string): Admission {
    const now = this.#now();
    const previous = this.#roundGate.get(roundId);
    const at = Math.max(now, previous ?? 0);
    const gate = at + this.floors.decisionDeadPeriodMs;
    this.#roundGate.set(roundId, gate);
    return {
      waitMs: at - now,
      release: () => {
        this.#restore(roundId, gate, previous);
      },
    };
  }

  /**
   * Puts a round's dead period back the way a released command found it.
   *
   * Restoring rather than deleting is the whole of it: an `open` refused on a round
   * that is *already* open — a stale fence, an idempotency conflict — must not clear
   * the dead period the live round is standing in, or a client could take its next
   * decision immediately by getting one command deliberately refused first.
   *
   * The write is skipped if anything reserved after us, so a restore can never
   * shorten a floor it did not create.
   */
  #restore(roundId: string, reserved: number, previous: number | undefined): void {
    if (this.#roundGate.get(roundId) !== reserved) return;
    if (previous === undefined) this.#roundGate.delete(roundId);
    else this.#roundGate.set(roundId, previous);
  }

  /**
   * The settlement hold, from the server's side: a settled round pushes the
   * moment the next round may open, so a loss cannot be chained into the next
   * stake faster than §9.7 allows even by a client that never drew it.
   */
  settled(roundId: string): void {
    const now = this.#now();
    this.#openFloor = Math.max(this.#openFloor, now + this.floors.settlementHoldMs);
    this.#openGate = Math.max(this.#openGate, this.#openFloor);
    this.#roundGate.delete(roundId);
  }

  /** Drops a round's gate when the round leaves the registry. */
  forget(roundId: string): void {
    this.#roundGate.delete(roundId);
  }
}
