/**
 * Number formatting for the client.
 *
 * Two rules from `docs/DESIGN.md` §6.6 and §9.3, and they are not stylistic:
 * every displayed value is **truncated toward zero**, never rounded, so the
 * credited amount is never below what was shown; and a negative delta always
 * carries its sign. Money and multipliers always show two decimals.
 *
 * Money arrives as an integer string of minor units (`1 credit = 10^6 units`) and
 * is formatted with BigInt arithmetic. No money value passes through a float.
 */

const UNITS_PER_CREDIT = 1000000n;

/** The typographic minus, so a signed number keeps tabular alignment. */
const MINUS = '\u2212';

/**
 * The unit, and it is attached to every figure the player reads as money.
 *
 * Round 1 shipped bare numbers — `BALANCE 1017.19`, `BANKED 18.43`, `STAKE 1.00`
 * — and in a blind side-by-side that was one of the three tells that gave the
 * build away on sight. Every reference in the calibration set attaches its unit
 * to every figure (`1.10 FUN`, `Win: 2.00 FUN`, `Balance 1,000.00 FUN`), because
 * a bare decimal is not money, it is a number. `CR` is this game's free-play
 * credit; it has no cash value, and the marker at the foot of every screen says
 * exactly that.
 */
export const CURRENCY = 'CR';

/** Thousand separators, so a four-figure balance reads as a balance. */
function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Truncating credits from minor units: `1855468` → `1.85`. */
export function credits(units, decimals = 2) {
  const value = typeof units === 'bigint' ? units : BigInt(units ?? 0);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const scaled = (magnitude * scale) / UNITS_PER_CREDIT;
  const whole = group((scaled / scale).toString());
  const fraction = (scaled % scale).toString().padStart(decimals, '0');
  return `${negative ? MINUS : ''}${whole}${decimals === 0 ? '' : `.${fraction}`}`;
}

/** Credits with the unit attached: `1855468` → `1.85 CR`. */
export function money(units, decimals = 2) {
  return `${credits(units, decimals)} ${CURRENCY}`;
}

/** Signed credits with the unit attached: `+10.05 CR`. */
export function signedMoney(units, decimals = 2) {
  return `${signedCredits(units, decimals)} ${CURRENCY}`;
}

/**
 * Signed credits, with an explicit `+` on a gain.
 *
 * A non-zero result never renders as `0.00`: truncation is the right direction
 * for a multiplier, but a net result that is not zero must not read as one, so a
 * value smaller than the display step is shown at full minor-unit precision.
 */
export function signedCredits(units, decimals = 2) {
  const value = typeof units === 'bigint' ? units : BigInt(units ?? 0);
  const sign = value > 0n ? '+' : '';
  const text = credits(value, decimals);
  if (value !== 0n && /^[+\u2212-]?0(\.0+)?$/u.test(text)) return `${sign}${credits(value, 6)}`;
  return `${sign}${text}`;
}

/** Truncates a decimal string the server already truncated, e.g. `0.395833` → `0.39`. */
export function truncate(decimal, decimals = 2) {
  if (decimal === null || decimal === undefined) return '—';
  const text = String(decimal);
  const dot = text.indexOf('.');
  if (dot === -1) return decimals === 0 ? text : `${text}.${'0'.repeat(decimals)}`;
  const whole = text.slice(0, dot);
  const fraction = text.slice(dot + 1).padEnd(decimals, '0').slice(0, decimals);
  return decimals === 0 ? whole : `${whole}.${fraction}`;
}

/** A multiplier, always two decimals, always truncated: `1.855468` → `1.85x`. */
export function multiple(wire, decimals = 2) {
  if (wire === null || wire === undefined) return '—';
  const decimal = typeof wire === 'string' ? wire : wire.decimal;
  return `${truncate(decimal, decimals)}x`;
}

/** The signed change in colony value, in stake multiples. */
export function signedMultiple(value, decimals = 2) {
  const text = truncate(Math.abs(value).toFixed(6), decimals);
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}x`;
}

/** A wire rational as a float, for layout maths only — never for money. */
export function toNumber(wire) {
  if (wire === null || wire === undefined) return 0;
  return Number(wire.decimal);
}

/**
 * A probability as a percentage, truncated toward zero like every other number
 * on screen: `0.0224631637` is `2.24%`, never the `2.25%` rounding would print.
 */
export function percent(fraction, decimals = 2) {
  return `${truncate((Number(fraction) * 100).toFixed(6), decimals)}%`;
}

export function shortHex(value, head = 8, tail = 6) {
  if (typeof value !== 'string' || value.length <= head + tail + 1) return value ?? '—';
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Elapsed session time, `m:ss` under an hour and `h:mm:ss` over it.
 *
 * `docs/DESIGN.md` §9.9 asks for a session timer, and a timer that stops being
 * readable after 60 minutes is a timer that stops working exactly when it starts
 * mattering.
 */
export function elapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A duration in whole minutes, as the limit sheet states it: `90` → `1 h 30 min`. */
export function duration(minutes) {
  if (minutes === null || minutes === undefined) return 'off';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
