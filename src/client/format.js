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

/** Truncating credits from minor units: `1855468` → `1.85`. */
export function credits(units, decimals = 2) {
  const value = typeof units === 'bigint' ? units : BigInt(units ?? 0);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const scaled = (magnitude * scale) / UNITS_PER_CREDIT;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(decimals, '0');
  return `${negative ? MINUS : ''}${whole}${decimals === 0 ? '' : `.${fraction}`}`;
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

export function elapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
