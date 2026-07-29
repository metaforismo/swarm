import { describe, expect, it } from 'vitest';
import {
  MAX_BIGINT_BITS,
  SwarmMathError,
  add,
  compare,
  divide,
  equal,
  floorBig,
  fromFraction,
  gcd,
  isqrt,
  multiply,
  power,
  rat,
  subtract,
  sum,
  toDecimal,
  toFraction,
  toOneIn,
  toScientific,
  toSqrtDecimal,
} from '../tools/lib/rational.mjs';

describe('construction', () => {
  it('normalizes sign and reduces by gcd', () => {
    expect(toFraction(rat(6n, -8n))).toBe('-3/4');
    expect(toFraction(rat(0n, 7n))).toBe('0/1');
    expect(toFraction(rat(-10n, -4n))).toBe('5/2');
  });

  it('freezes values', () => {
    const value = rat(1n, 3n);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('round-trips through the canonical fraction string', () => {
    const value = rat(123456789n, 987654321n);
    expect(equal(fromFraction(toFraction(value)), value)).toBe(true);
  });
});

describe('exact arithmetic', () => {
  it('adds thirds and sixths exactly', () => {
    expect(toFraction(add(rat(1n, 3n), rat(1n, 6n)))).toBe('1/2');
  });

  it('does not accumulate error over a long fold', () => {
    const tenths = Array.from({ length: 10 }, () => rat(1n, 10n));
    expect(toFraction(sum(tenths))).toBe('1/1');
  });

  it('subtracts, multiplies, divides and compares exactly', () => {
    expect(toFraction(subtract(rat(1n, 3n), rat(1n, 4n)))).toBe('1/12');
    expect(toFraction(multiply(rat(2n, 3n), rat(3n, 2n)))).toBe('1/1');
    expect(toFraction(divide(rat(19n, 20n), rat(1n, 5n)))).toBe('19/4');
    expect(compare(rat(1n, 3n), rat(1n, 4n))).toBe(1);
    expect(compare(rat(1n, 4n), rat(1n, 3n))).toBe(-1);
    expect(compare(rat(2n, 4n), rat(1n, 2n))).toBe(0);
  });

  it('raises to integer powers exactly', () => {
    expect(toFraction(power(rat(5n, 4n), 17))).toBe('762939453125/17179869184');
    expect(toFraction(power(rat(5n, 4n), 0))).toBe('1/1');
  });

  it('computes gcd on BigInts', () => {
    expect(gcd(48n, 18n)).toBe(6n);
    expect(gcd(-48n, 18n)).toBe(6n);
    expect(gcd(0n, 7n)).toBe(7n);
  });
});

describe('rendering', () => {
  it('truncates toward zero rather than rounding', () => {
    expect(toDecimal(rat(999999n, 1000000n), 2)).toBe('0.99');
    expect(toDecimal(rat(19n, 48n), 4)).toBe('0.3958');
    expect(toDecimal(rat(1n, 1n), 0)).toBe('1');
  });

  it('renders tiny probabilities in scientific notation', () => {
    expect(toScientific(rat(1n, 1000000n), 4)).toBe('1.000e-06');
    expect(toScientific(rat(0n), 4)).toBe('0');
    expect(toScientific(rat(123456n, 100n), 4)).toBe('1.234e+03');
  });

  it('renders one-in odds', () => {
    expect(toOneIn(rat(1n, 5n), 2)).toBe('5.00');
    expect(toOneIn(rat(0n))).toBe('never');
  });

  it('computes integer square roots and truncated roots', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(144n)).toBe(12n);
    expect(isqrt(145n)).toBe(12n);
    expect(isqrt(10n ** 40n)).toBe(10n ** 20n);
    expect(toSqrtDecimal(rat(1n, 4n), 6)).toBe('0.500000');
    expect(toSqrtDecimal(rat(2n), 6)).toBe('1.414213');
    expect(toSqrtDecimal(rat(0n), 4)).toBe('0.0000');
  });
});

describe('hostile input', () => {
  const bad = [
    () => rat(1, 2),
    () => rat(1n, 0n),
    () => rat('1', '2'),
    () => rat(1n, 2),
    () => add(rat(1n), { numerator: 1n, denominator: 0n }),
    () => add(rat(1n), { numerator: 1n, denominator: -2n }),
    () => add(rat(1n), null),
    () => add(rat(1n), { numerator: '1', denominator: '2' }),
    () => divide(rat(1n), rat(0n)),
    () => floorBig(rat(-1n, 2n)),
    () => power(rat(2n), -1),
    () => power(rat(2n), 1.5),
    () => toDecimal(rat(1n), -1),
    () => toDecimal(rat(1n), 99999),
    () => toScientific(rat(1n), 0),
    () => toSqrtDecimal(rat(-1n, 2n), 4),
    () => fromFraction('1/0'),
    () => fromFraction('one half'),
    () => fromFraction('1/2/3'),
    () => fromFraction(42),
    () => isqrt(-1n),
    () => isqrt(4),
  ];

  it('rejects every malformed input with a typed error', () => {
    for (const attempt of bad) {
      expect(attempt).toThrow(SwarmMathError);
    }
  });

  it('refuses values above the public BigInt bound', () => {
    expect(() => rat(1n << BigInt(MAX_BIGINT_BITS + 1))).toThrow(/BigInt bound/u);
  });

  it('carries a machine-readable code and path', () => {
    try {
      rat(1n, 0n);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SwarmMathError);
      expect(error.code).toBe('INVALID_RATIONAL');
      expect(error.path).toBe('$.denominator');
    }
  });
});
