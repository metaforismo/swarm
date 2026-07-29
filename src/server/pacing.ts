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
  /** Earliest moment the next command against a given round may be admitted. */
  readonly #roundGate = new Map<string, number>();

  constructor(floors: PacingFloors, now: () => number = () => Date.now()) {
    this.floors = floors;
    this.#now = now;
  }

  /** Milliseconds an `open` must wait. Reserves the slot it returns. */
  admitOpen(roundId: string): number {
    const now = this.#now();
    const at = Math.max(now, this.#openGate);
    this.#openGate = at + this.floors.roundCycleMs;
    this.#roundGate.set(roundId, at + this.floors.decisionDeadPeriodMs);
    return at - now;
  }

  /** Milliseconds a command against a live round must wait. Reserves the slot. */
  admitCommand(roundId: string): number {
    const now = this.#now();
    const at = Math.max(now, this.#roundGate.get(roundId) ?? 0);
    this.#roundGate.set(roundId, at + this.floors.decisionDeadPeriodMs);
    return at - now;
  }

  /**
   * The settlement hold, from the server's side: a settled round pushes the
   * moment the next round may open, so a loss cannot be chained into the next
   * stake faster than §9.7 allows even by a client that never drew it.
   */
  settled(roundId: string): void {
    const now = this.#now();
    this.#openGate = Math.max(this.#openGate, now + this.floors.settlementHoldMs);
    this.#roundGate.delete(roundId);
  }

  /** Drops a round's gate when the round leaves the registry. */
  forget(roundId: string): void {
    this.#roundGate.delete(roundId);
  }
}
