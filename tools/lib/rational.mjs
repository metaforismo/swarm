/**
 * Exact rational arithmetic on BigInt.
 *
 * Mirrors the discipline of `@axiom-games/reveal-engine` `src/core/rational.ts`:
 * every value is normalized (positive denominator, reduced by gcd), frozen, and
 * bounded. No IEEE-754 float ever touches a probability or a money value in
 * this repository. Decimal rendering exists only for human display and is
 * always derived from the exact value, never the other way round.
 */

/** Public bound; mirrors ENGINE_LIMITS.maxBigIntBits so tools cannot outgrow the engine. */
export const MAX_BIGINT_BITS = 65536;

export class SwarmMathError extends Error {
  constructor(code, message, path = '$') {
    super(message);
    this.name = 'SwarmMathError';
    this.code = code;
    this.path = path;
  }
}

export function fail(code, message, path = '$') {
  throw new SwarmMathError(code, message, path);
}

function bitLength(value) {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 1 : magnitude.toString(2).length;
}

export function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** Constructs a normalized, frozen rational. Rejects anything that is not a BigInt pair. */
export function rat(numerator, denominator = 1n) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint')
    fail('INVALID_RATIONAL', 'Rational parts must be BigInts');
  if (denominator === 0n) fail('INVALID_RATIONAL', 'Zero denominator', '$.denominator');
  if (bitLength(numerator) > MAX_BIGINT_BITS || bitLength(denominator) > MAX_BIGINT_BITS)
    fail('INVALID_RATIONAL', 'Rational exceeds the public BigInt bound');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator) || 1n;
  return Object.freeze({
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  });
}

function normalized(value, path = '$') {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.numerator !== 'bigint' ||
    typeof value.denominator !== 'bigint' ||
    value.denominator <= 0n
  )
    fail('INVALID_RATIONAL', 'Expected a rational with a positive denominator', path);
  return value;
}

export const ZERO = rat(0n);
export const ONE = rat(1n);

export function add(a, b) {
  const x = normalized(a);
  const y = normalized(b);
  return rat(
    x.numerator * y.denominator + y.numerator * x.denominator,
    x.denominator * y.denominator,
  );
}

export function subtract(a, b) {
  const x = normalized(a);
  const y = normalized(b);
  return rat(
    x.numerator * y.denominator - y.numerator * x.denominator,
    x.denominator * y.denominator,
  );
}

export function multiply(a, b) {
  const x = normalized(a);
  const y = normalized(b);
  return rat(x.numerator * y.numerator, x.denominator * y.denominator);
}

export function divide(a, b) {
  const x = normalized(a);
  const y = normalized(b);
  if (y.numerator === 0n) fail('INVALID_RATIONAL', 'Division by zero');
  return rat(x.numerator * y.denominator, x.denominator * y.numerator);
}

export function compare(a, b) {
  const x = normalized(a);
  const y = normalized(b);
  const difference = x.numerator * y.denominator - y.numerator * x.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function equal(a, b) {
  return compare(a, b) === 0;
}

export function isZero(a) {
  return normalized(a).numerator === 0n;
}

/** Floor division to an integer BigInt; rejects negatives so it cannot hide a sign bug. */
export function floorBig(a) {
  const x = normalized(a);
  if (x.numerator < 0n) fail('INVALID_RATIONAL', 'Negative payable value');
  return x.numerator / x.denominator;
}

export function fromInt(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('INVALID_RATIONAL', 'Expected a safe integer');
    return rat(BigInt(value));
  }
  return rat(value);
}

export function power(base, exponent) {
  if (!Number.isSafeInteger(exponent) || exponent < 0)
    fail('INVALID_RATIONAL', 'Exponent must be a non-negative safe integer');
  const x = normalized(base);
  return rat(x.numerator ** BigInt(exponent), x.denominator ** BigInt(exponent));
}

/** Canonical `numerator/denominator` string. This is the value that gets hashed and frozen. */
export function toFraction(a) {
  const x = normalized(a);
  return `${x.numerator}/${x.denominator}`;
}

export function fromFraction(text) {
  if (typeof text !== 'string') fail('INVALID_RATIONAL', 'Fraction must be a string');
  const match = /^(-?\d{1,20000})\/(\d{1,20000})$/u.exec(text);
  if (!match) fail('INVALID_RATIONAL', 'Malformed canonical fraction');
  return rat(BigInt(match[1]), BigInt(match[2]));
}

/**
 * Truncating (toward zero) decimal rendering with a fixed number of fractional
 * digits. Truncation, never rounding: a displayed multiplier is always a value
 * the game can actually reach or beat, never one it cannot.
 */
export function toDecimal(a, digits = 8) {
  const x = normalized(a);
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 4096)
    fail('INVALID_RATIONAL', 'Digit count out of range');
  const negative = x.numerator < 0n;
  const magnitude = negative ? -x.numerator : x.numerator;
  const scaled = (magnitude * 10n ** BigInt(digits)) / x.denominator;
  const text = scaled.toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits) || '0';
  const fraction = digits === 0 ? '' : `.${text.slice(text.length - digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Significant-digit rendering for probabilities far below 1, e.g. `1.2345e-9`.
 * Exact input, truncated output, explicit exponent.
 */
export function toScientific(a, significant = 10) {
  const x = normalized(a);
  if (!Number.isSafeInteger(significant) || significant < 1 || significant > 100)
    fail('INVALID_RATIONAL', 'Significant digit count out of range');
  if (x.numerator === 0n) return '0';
  const negative = x.numerator < 0n;
  const magnitude = negative ? -x.numerator : x.numerator;
  // exponent = floor(log10(magnitude/denominator)), found by digit lengths then corrected.
  let exponent = magnitude.toString().length - x.denominator.toString().length;
  const scale = (e) => (e >= 0 ? rat(10n ** BigInt(e)) : rat(1n, 10n ** BigInt(-e)));
  const value = rat(magnitude, x.denominator);
  while (compare(divide(value, scale(exponent)), rat(10n)) >= 0) exponent += 1;
  while (compare(divide(value, scale(exponent)), ONE) < 0) exponent -= 1;
  const mantissa = divide(value, scale(exponent));
  return `${negative ? '-' : ''}${toDecimal(mantissa, significant - 1)}e${exponent >= 0 ? '+' : '-'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/** Sum helper that keeps the exact value; folds left with no intermediate rounding. */
export function sum(values) {
  return values.reduce((total, value) => add(total, value), ZERO);
}

/** Integer square root, floor. Newton iteration on BigInt; exact, no float step. */
export function isqrt(value) {
  if (typeof value !== 'bigint' || value < 0n)
    fail('INVALID_RATIONAL', 'Integer square root needs a non-negative BigInt');
  if (value < 2n) return value;
  let guess = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const next = (guess + value / guess) >> 1n;
    if (next >= guess) return guess;
    guess = next;
  }
}

/**
 * Truncated decimal of sqrt(value). The square root of a rational is usually
 * irrational, so this is the one place a published number is not exact: it is a
 * truncation of the true value, computed by integer square root, never a float.
 */
export function toSqrtDecimal(value, digits = 6) {
  const x = normalized(value);
  if (x.numerator < 0n) fail('INVALID_RATIONAL', 'Cannot take the square root of a negative');
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 64)
    fail('INVALID_RATIONAL', 'Digit count out of range');
  const scale = 10n ** BigInt(2 * digits);
  const root = isqrt((x.numerator * scale) / x.denominator);
  const text = root.toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits) || '0';
  return digits === 0 ? whole : `${whole}.${text.slice(text.length - digits)}`;
}

/** "1 in N" rendering of a probability, truncated downward. */
export function toOneIn(value, digits = 0) {
  const x = normalized(value);
  if (x.numerator === 0n) return 'never';
  return toDecimal(divide(ONE, x), digits);
}
