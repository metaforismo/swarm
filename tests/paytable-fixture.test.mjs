import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, parseFixture } from '../tools/lib/canonical.mjs';
import { buildPaytable } from '../tools/lib/report.mjs';
import { SwarmMathError } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = `${root}spec/paytable.v1.json`;
const frozen = readFileSync(fixturePath, 'utf8');
const rendered = canonicalJson(buildPaytable());

describe('frozen paytable fixture', () => {
  it('is byte-identical to a fresh enumeration', () => {
    expect(rendered).toBe(frozen);
  });

  it('matches the digest published in docs/MATH.md', () => {
    const math = readFileSync(`${root}docs/MATH.md`, 'utf8');
    const fingerprint = digest(frozen);
    expect(math).toContain(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('carries no floating point anywhere', () => {
    // Canonical JSON only ever emits strings, booleans and safe integers.
    const walk = (value, path = '$') => {
      if (typeof value === 'number') {
        expect(Number.isSafeInteger(value), `${path} is not an integer`).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (value && typeof value === 'object')
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
    };
    walk(parseFixture(frozen));
  });

  it('has sorted keys at every level', () => {
    const walk = (value) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        expect(keys).toEqual([...keys].sort());
        Object.values(value).forEach(walk);
      }
    };
    walk(JSON.parse(frozen));
  });

  it('states the risk policy it was generated under', () => {
    const fixture = parseFixture(frozen);
    expect(fixture.schema).toBe('swarm/paytable-v1');
    expect(fixture.adapterId).toBe('swarm-colony-v1');
    expect(fixture.adapterVersion).toBe('1.0.0');
    expect(fixture.totals.rtp).toBe('19/20');
    expect(fixture.totals.probabilityMass).toBe('1/1');
    expect(fixture.proof.ok).toBe(true);
    expect(fixture.proof.failures).toBe(0);
    expect(fixture.roundMaximum.capBinds).toBe(false);
  });
});

describe('canonical serialization is hostile-input safe', () => {
  it('refuses floats', () => {
    expect(() => canonicalJson({ value: 0.1 })).toThrow(SwarmMathError);
  });

  it('refuses non-plain objects', () => {
    expect(() => canonicalJson({ when: new Date() })).toThrow(SwarmMathError);
    expect(() => canonicalJson({ pattern: /x/u })).toThrow(SwarmMathError);
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(SwarmMathError);
  });

  it('refuses reserved keys', () => {
    const payload = {};
    Object.defineProperty(payload, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(() => canonicalJson(payload)).toThrow(/reserved key/u);
  });

  it('serializes BigInt as a decimal string', () => {
    expect(canonicalJson({ a: 10n ** 30n })).toContain('"1000000000000000000000000000000"');
  });

  it('rejects oversized and malformed fixtures on parse', () => {
    expect(() => parseFixture('{}', 1)).toThrow(/size bound/u);
    expect(() => parseFixture('[]')).toThrow(/root must be an object/u);
    expect(() => parseFixture(42)).toThrow(SwarmMathError);
    expect(() => parseFixture('{"__proto__": {"polluted": true}}')).toThrow(/reserved key/u);
    expect(() => parseFixture('{ not json')).toThrow(SyntaxError);
  });

  it('does not pollute Object.prototype when parsing', () => {
    try {
      parseFixture('{"__proto__": {"polluted": true}}');
    } catch {
      /* expected */
    }
    expect({}.polluted).toBeUndefined();
  });

  it('is stable across repeated renders', () => {
    expect(canonicalJson(buildPaytable())).toBe(rendered);
    expect(digest(rendered)).toBe(digest(canonicalJson(buildPaytable())));
  });
});
