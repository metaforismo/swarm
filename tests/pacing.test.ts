/**
 * The `Pacer`'s release semantics, against an injected clock.
 *
 * `docs/DESIGN.md` §9.7's floors are enforced as a wait and never a refusal, and a
 * command the service *refuses* pays no floor at all: it hands its slot back
 * ([DECISIONS.md D8](../docs/DECISIONS.md)). That release is the dangerous half of
 * the mechanism — a rollback that gives back one millisecond too many turns a floor
 * into something a client can clear on demand by getting a command refused — so the
 * invariant is tested here directly rather than inferred from wall-clock timings
 * over HTTP.
 *
 * The invariant, in one sentence: a release may only ever return time the released
 * command itself was holding, and may never shorten a floor established by
 * anything else.
 *
 * `tests/server-playthrough.test.ts` covers the same rules end to end through the
 * HTTP service on real elapsed time; these are the deterministic edges.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACING, Pacer, parsePacing } from '../src/server/pacing.ts';

/** A clock the test moves by hand. */
function clock(startAt = 1_000_000) {
  const state = { now: startAt };
  return { state, read: () => state.now };
}

const FLOORS = DEFAULT_PACING;

describe('the Pacer admits and spaces', () => {
  it('admits the first open immediately and spaces the next by the cycle floor', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    expect(pacer.admitOpen('r1').waitMs).toBe(0);
    // Reserved at call time, so a second arrival is spaced rather than co-firing.
    expect(pacer.admitOpen('r2').waitMs).toBe(FLOORS.roundCycleMs);
    expect(pacer.admitOpen('r3').waitMs).toBe(FLOORS.roundCycleMs * 2);
  });

  it('spaces commands against one round by the dead period', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1');
    expect(pacer.admitCommand('r1').waitMs).toBe(FLOORS.decisionDeadPeriodMs);
    expect(pacer.admitCommand('r1').waitMs).toBe(FLOORS.decisionDeadPeriodMs * 2);
  });

  it('keeps the slot of a command that is not released', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1'); // accepted: keeps its slot
    c.state.now += FLOORS.roundCycleMs - 1;
    expect(pacer.admitOpen('r2').waitMs).toBe(1);
  });
});

describe('a released slot is given back, and never more than that', () => {
  it('returns the cycle slot a refused open was holding', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1'); // accepted
    c.state.now += FLOORS.roundCycleMs; // its floor has passed
    const refused = pacer.admitOpen('r2');
    expect(refused.waitMs).toBe(0);
    refused.release();
    // The next open is where it would have been had r2 never arrived.
    expect(pacer.admitOpen('r3').waitMs).toBe(0);
  });

  it('is a no-op once something else has reserved behind it', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    const first = pacer.admitOpen('r1');
    const second = pacer.admitOpen('r2');
    expect(second.waitMs).toBe(FLOORS.roundCycleMs);
    // r1 is refused, but r2 is already queued behind it: releasing r1 must not
    // pull r2's slot — or any later one — forward.
    first.release();
    expect(pacer.admitOpen('r3').waitMs).toBe(FLOORS.roundCycleMs * 2);
  });

  /*
   * The bypass this guards against, and the reason `release` restores rather than
   * deletes: a round that is already open can be `open`ed again — a retry, or a
   * command fenced to a stale frame — so a *refused* open can land on a live round.
   * Deleting that round's dead period instead of putting it back let a client take
   * its next decision immediately by getting one command deliberately refused
   * first. Measured over HTTP before the fix: 4 ms against a 350 ms floor.
   */
  it('restores a live round dead period rather than clearing it', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1'); // the round is open
    c.state.now += FLOORS.roundCycleMs;
    pacer.admitCommand('r1'); // an accepted decision: its dead period is running
    const refusedOpen = pacer.admitOpen('r1'); // a stale-fenced second open
    expect(refusedOpen.waitMs).toBe(0);
    refusedOpen.release();
    // The dead period the accepted command established is still there.
    expect(pacer.admitCommand('r1').waitMs).toBe(FLOORS.decisionDeadPeriodMs);
  });

  it('restores the previous dead period when a command is refused', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1');
    c.state.now += FLOORS.roundCycleMs;
    pacer.admitCommand('r1'); // accepted, dead period running from now
    const refused = pacer.admitCommand('r1');
    expect(refused.waitMs).toBe(FLOORS.decisionDeadPeriodMs);
    refused.release();
    // Back to one dead period, not two.
    expect(pacer.admitCommand('r1').waitMs).toBe(FLOORS.decisionDeadPeriodMs);
  });

  it('leaves no gate behind for a round whose first open was refused', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    const refused = pacer.admitOpen('r1');
    refused.release();
    // No dead period was ever established for r1, so nothing is owed.
    expect(pacer.admitCommand('r1').waitMs).toBe(0);
  });
});

describe('a release never shortens a settlement hold', () => {
  /*
   * A release rolls the open gate back to where the released command found it —
   * which is *before* any settlement hold that landed while it was waiting. Without
   * a separate monotonic floor for the hold, a client with a refused open queued
   * behind a real round could settle that round and then open the next one inside
   * the 600 ms hold, which is exactly what §9.7's "a loss cannot be skipped into
   * the next stake" forbids.
   */
  it('holds the next open for 600 ms after a settlement, even across a release', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1'); // accepted: openGate is now +2500
    const doomed = pacer.admitOpen('r2'); // queued behind it, will be refused
    expect(doomed.waitMs).toBe(FLOORS.roundCycleMs);

    // r1 settles late enough that its hold reaches past r2's own admit slot.
    c.state.now += 2000;
    pacer.settled('r1'); // requires: no open before now + 600 = start + 2600

    // r2 is refused at its slot and hands the cycle slot back.
    c.state.now += FLOORS.roundCycleMs - 2000; // now = start + 2500
    doomed.release();

    // The settlement hold survives: 100 ms of it is still owed.
    expect(pacer.admitOpen('r3').waitMs).toBe(100);
  });

  it('does not invent a hold when the settlement is old enough', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    pacer.admitOpen('r1');
    c.state.now += 100;
    pacer.settled('r1'); // hold to start + 700
    c.state.now += FLOORS.roundCycleMs; // now = start + 2600, past both floors
    expect(pacer.admitOpen('r2').waitMs).toBe(0);
  });

  it('never lowers the hold when an earlier settlement follows a later one', () => {
    const c = clock();
    const pacer = new Pacer(FLOORS, c.read);
    c.state.now += 5000;
    pacer.settled('late'); // hold to start + 5600
    const held = pacer.admitOpen('r1');
    expect(held.waitMs).toBe(FLOORS.settlementHoldMs);
    held.release();
    // Releasing cannot drop below the hold that was already in force.
    expect(pacer.admitOpen('r2').waitMs).toBe(FLOORS.settlementHoldMs);
  });
});

describe('floors are parsed defensively', () => {
  it('falls back to the specified values for anything not a finite count', () => {
    expect(parsePacing(undefined)).toEqual(DEFAULT_PACING);
    expect(parsePacing({ roundCycleMs: -1 })).toEqual(DEFAULT_PACING);
    expect(parsePacing({ roundCycleMs: Number.NaN })).toEqual(DEFAULT_PACING);
    expect(parsePacing({ decisionDeadPeriodMs: Number.POSITIVE_INFINITY })).toEqual(DEFAULT_PACING);
  });

  it('accepts zero, which is how the suite plays dozens of rounds', () => {
    expect(parsePacing({ roundCycleMs: 0, decisionDeadPeriodMs: 0, settlementHoldMs: 0 })).toEqual({
      roundCycleMs: 0,
      decisionDeadPeriodMs: 0,
      settlementHoldMs: 0,
    });
  });

  it('is inert with every floor at zero', () => {
    const c = clock();
    const pacer = new Pacer(parsePacing({ roundCycleMs: 0, decisionDeadPeriodMs: 0, settlementHoldMs: 0 }), c.read);
    expect(pacer.admitOpen('r1').waitMs).toBe(0);
    expect(pacer.admitOpen('r2').waitMs).toBe(0);
    expect(pacer.admitCommand('r1').waitMs).toBe(0);
    pacer.settled('r1');
    expect(pacer.admitOpen('r3').waitMs).toBe(0);
  });
});
