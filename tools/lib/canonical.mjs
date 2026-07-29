/**
 * Canonical JSON for frozen fixtures.
 *
 * Deterministic byte output: object keys sorted by code unit, two-space
 * indentation, no floats anywhere. Every exact value crosses this boundary as a
 * `numerator/denominator` string, never as an IEEE-754 number, so a fixture
 * digest is a statement about exact arithmetic rather than about rounding.
 */

import { createHash } from 'node:crypto';
import { fail } from './rational.mjs';

function canonicalize(value, path = '$') {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      fail('INVALID_FIXTURE', 'Only safe integers may be serialized as numbers', path);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      fail('INVALID_FIXTURE', 'Only plain objects may be serialized', path);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        fail('INVALID_FIXTURE', `Refusing to serialize reserved key ${key}`, path);
      const entry = value[key];
      if (entry === undefined) continue;
      result[key] = canonicalize(entry, `${path}.${key}`);
    }
    return result;
  }
  return fail('INVALID_FIXTURE', `Unserializable value of type ${typeof value}`, path);
}

/** Canonical UTF-8 text of a fixture, newline-terminated. */
export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function digest(text) {
  if (typeof text !== 'string') fail('INVALID_FIXTURE', 'Digest input must be a string');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Parse a fixture defensively: bounded size, no prototype pollution, plain data only. */
export function parseFixture(text, maxBytes = 8 * 1024 * 1024) {
  if (typeof text !== 'string') fail('INVALID_FIXTURE', 'Fixture must be a string');
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    fail('PAYLOAD_TOO_LARGE', 'Fixture exceeds the accepted size bound');
  const parsed = JSON.parse(text, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      fail('INVALID_FIXTURE', `Refusing to parse reserved key ${key}`);
    return value;
  });
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    fail('INVALID_FIXTURE', 'Fixture root must be an object');
  return parsed;
}
