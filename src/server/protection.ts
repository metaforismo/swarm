/**
 * Player protection: session limits, the reality check, and the help resources.
 *
 * `docs/DESIGN.md` §9.9 specifies four surfaces — a session timer and net result
 * in the top-bar menu, a reality check every 30 minutes, deposit/loss/time limits
 * reachable in two taps, and a visible link to help resources. The first is a
 * client rendering of `/api/session`; the other three are state, and state
 * belongs on the server: a limit a reload clears is not a limit, and a reality
 * check a refresh resets is not a reality check.
 *
 * **The free-play mapping, stated rather than implied.** There are no deposits
 * here — the wallet is an in-memory free-play balance — so the deposit limit maps
 * to a **stake budget**: the most this session may put at risk in total. The loss
 * limit is on the signed session result, and the time limit is on elapsed session
 * time. All three are off by default, because a limit the player did not choose
 * is not a protection.
 *
 * **Tightening is immediate; loosening waits.** Setting a limit, or lowering one,
 * applies on the next command. Raising or removing one is scheduled and takes
 * effect after a cool-off, which is the whole point of the control: a limit that
 * can be lifted at the moment it starts to bind protects nobody. The pending
 * change and the moment it lands are both published, so the player is never
 * waiting on something invisible.
 */
import { fail } from './errors.ts';
import { frozenCopy } from './snapshot.ts';

/** `docs/DESIGN.md` §9.9: "a reality check every 30 minutes". */
export const REALITY_CHECK_MINUTES = 30;
/** How long a loosened limit waits before it binds. */
export const LIMIT_COOL_OFF_HOURS = 24;

/** Upper bound on a configured limit, so a hostile value cannot be stored. */
const MAX_LIMIT_UNITS = 10n ** 18n;
const MAX_LIMIT_MINUTES = 7 * 24 * 60;

export type LimitField = 'budgetUnits' | 'lossUnits' | 'timeMinutes';

export interface Limits {
  /** Most this session may stake in total. The free-play stand-in for a deposit limit. */
  readonly budgetUnits: bigint | null;
  /** Largest net loss this session may reach before further stakes are refused. */
  readonly lossUnits: bigint | null;
  /** Longest this session may run before further stakes are refused. */
  readonly timeMinutes: number | null;
}

export interface PendingLimit {
  readonly field: LimitField;
  readonly value: string | null;
  readonly effectiveAt: number;
}

export interface HelpResource {
  readonly name: string;
  readonly url: string;
  readonly detail: string;
}

/**
 * The help resources §9.9 requires a visible link to. Independent support
 * organisations, not operator pages: a link that goes back to the game is not a
 * help resource.
 */
export const HELP_RESOURCES: readonly HelpResource[] = Object.freeze([
  Object.freeze({
    name: 'GamCare',
    url: 'https://www.gamcare.org.uk/',
    detail: 'Free support, information and counselling. National Gambling Helpline 0808 8020 133, 24 hours.',
  }),
  Object.freeze({
    name: 'BeGambleAware',
    url: 'https://www.begambleaware.org/',
    detail: 'Independent advice, a self-assessment tool and a directory of local support.',
  }),
  Object.freeze({
    name: 'Gambling Therapy',
    url: 'https://www.gamblingtherapy.org/',
    detail: 'Free multilingual online support, worldwide, for players and for the people around them.',
  }),
  Object.freeze({
    name: 'GAMSTOP',
    url: 'https://www.gamstop.co.uk/',
    detail: 'Self-exclusion from every licensed online operator in Great Britain, in one registration.',
  }),
]);

export interface ProtectionOptions {
  readonly clock: () => number;
  readonly startedAt: number;
  readonly realityCheckMinutes?: number;
  readonly limitCoolOffHours?: number;
}

const NO_LIMITS: Limits = Object.freeze({ budgetUnits: null, lossUnits: null, timeMinutes: null });

export class SessionProtection {
  readonly realityCheckMinutes: number;
  readonly limitCoolOffHours: number;
  readonly startedAt: number;
  readonly #clock: () => number;
  #limits: Limits = NO_LIMITS;
  #pending = new Map<LimitField, { value: bigint | number | null; effectiveAt: number }>();
  #realityCheckFrom: number;

  constructor(options: ProtectionOptions) {
    this.#clock = options.clock;
    this.startedAt = options.startedAt;
    this.realityCheckMinutes = options.realityCheckMinutes ?? REALITY_CHECK_MINUTES;
    this.limitCoolOffHours = options.limitCoolOffHours ?? LIMIT_COOL_OFF_HOURS;
    this.#realityCheckFrom = options.startedAt;
  }

  /** Applies every scheduled loosening the cool-off has released. */
  #resolve(): void {
    const now = this.#clock();
    for (const [field, entry] of [...this.#pending]) {
      if (entry.effectiveAt > now) continue;
      this.#limits = Object.freeze({ ...this.#limits, [field]: entry.value }) as Limits;
      this.#pending.delete(field);
    }
  }

  get limits(): Limits {
    this.#resolve();
    return frozenCopy(this.#limits);
  }

  get pending(): readonly PendingLimit[] {
    this.#resolve();
    return frozenCopy(
      [...this.#pending.entries()].map(([field, entry]) => ({
        field,
        value: entry.value === null ? null : entry.value.toString(),
        effectiveAt: entry.effectiveAt,
      })),
    );
  }

  /**
   * Sets limits from an untrusted payload.
   *
   * Every field is optional and independent: an absent field is untouched, an
   * explicit `null` removes the limit (and therefore waits out the cool-off).
   */
  set(input: Record<string, unknown>): void {
    this.#resolve();
    const now = this.#clock();
    const effectiveAt = now + this.limitCoolOffHours * 60 * 60 * 1000;
    const apply = (field: LimitField, value: bigint | number | null): void => {
      const current = this.#limits[field] as bigint | number | null;
      const tighter = value !== null && (current === null || value <= current);
      if (tighter) {
        this.#limits = Object.freeze({ ...this.#limits, [field]: value }) as Limits;
        // A tightening supersedes a scheduled loosening of the same field: the
        // player who just lowered a limit is not also asking to raise it later.
        this.#pending.delete(field);
        return;
      }
      if (current === null && value === null) {
        this.#pending.delete(field);
        return;
      }
      this.#pending.set(field, { value, effectiveAt });
    };
    if ('budgetUnits' in input) apply('budgetUnits', readUnits(input.budgetUnits, '$.budgetUnits'));
    if ('lossUnits' in input) apply('lossUnits', readUnits(input.lossUnits, '$.lossUnits'));
    if ('timeMinutes' in input) apply('timeMinutes', readMinutes(input.timeMinutes, '$.timeMinutes'));
  }

  /**
   * The one enforcement point: a stake is the only thing a limit can refuse.
   *
   * A limit never touches a live round. A player who is mid-round when a limit
   * binds finishes that round and banks it — stopping them from settling money
   * they have already staked would be a worse outcome than the one the limit
   * exists to prevent.
   */
  assertMayStake(ticketUnits: bigint, stakedUnits: bigint, netUnits: bigint): void {
    const reached = this.reached(ticketUnits, stakedUnits, netUnits);
    if (reached === null) return;
    fail('LIMIT_REACHED', reached.message, reached.path);
  }

  /** The binding limit, if any, without throwing. Drives the client's locked state. */
  reached(
    ticketUnits: bigint,
    stakedUnits: bigint,
    netUnits: bigint,
  ): { field: LimitField; message: string; path: string } | null {
    const limits = this.limits;
    if (limits.timeMinutes !== null && this.elapsedMs >= limits.timeMinutes * 60 * 1000)
      return Object.freeze({
        field: 'timeMinutes',
        message: 'You reached the session time limit you set. It can be raised after the cool-off.',
        path: '$.limits.timeMinutes',
      });
    if (limits.lossUnits !== null && -netUnits >= limits.lossUnits)
      return Object.freeze({
        field: 'lossUnits',
        message: 'You reached the session loss limit you set. It can be raised after the cool-off.',
        path: '$.limits.lossUnits',
      });
    if (limits.budgetUnits !== null && stakedUnits + ticketUnits > limits.budgetUnits)
      return Object.freeze({
        field: 'budgetUnits',
        message: 'This ticket would pass the stake budget you set for this session.',
        path: '$.limits.budgetUnits',
      });
    return null;
  }

  get elapsedMs(): number {
    return Math.max(0, this.#clock() - this.startedAt);
  }

  /** §9.9's reality check: due every `realityCheckMinutes` of elapsed session time. */
  realityCheck(): {
    intervalMinutes: number;
    dueAt: number;
    due: boolean;
    sinceMs: number;
  } {
    const now = this.#clock();
    const dueAt = this.#realityCheckFrom + this.realityCheckMinutes * 60 * 1000;
    return Object.freeze({
      intervalMinutes: this.realityCheckMinutes,
      dueAt,
      due: now >= dueAt,
      sinceMs: Math.max(0, now - this.#realityCheckFrom),
    });
  }

  /**
   * Acknowledges a shown reality check and restarts its clock.
   *
   * The clock restarts from *now* rather than from the moment it fell due, so a
   * player who was mid-round when it came due does not get a second one seconds
   * later — the interval is a floor between two checks, like every other floor
   * in this game.
   */
  acknowledgeRealityCheck(): void {
    this.#realityCheckFrom = this.#clock();
  }
}

function readUnits(value: unknown, path: string): bigint | null {
  if (value === null) return null;
  if (typeof value === 'string' && /^\d{1,25}$/u.test(value)) {
    const units = BigInt(value);
    if (units > MAX_LIMIT_UNITS) fail('INVALID_REQUEST', 'That limit is out of range', path);
    return units;
  }
  return fail('INVALID_REQUEST', 'A money limit is an integer string of minor units, or null', path);
}

function readMinutes(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LIMIT_MINUTES)
    return value as number;
  return fail('INVALID_REQUEST', `A time limit is 0 to ${MAX_LIMIT_MINUTES} whole minutes, or null`, path);
}
