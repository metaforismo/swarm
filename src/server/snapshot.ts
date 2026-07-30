import type {
  AdvanceRequest,
  HarvestRequest,
  OpenRequest,
  SettleRequest,
} from './book.ts';
import { fail } from './errors.ts';

const canonicalRequests = new WeakSet<object>();

function sourceOf(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    fail('INVALID_REQUEST', 'A command request must be a plain object', path);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail('INVALID_REQUEST', 'A command request must be plain data', path);
  return input as Record<string, unknown>;
}

function text(value: unknown, path: string, label: string): string {
  if (typeof value !== 'string')
    fail('INVALID_REQUEST', `${label} must be a string`, path);
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(
      'INVALID_REQUEST',
      'expectedFrameRevision must be a non-negative integer',
      '$.expectedFrameRevision',
    );
  return value as number;
}

function canonical<T extends object>(snapshot: T): Readonly<T> {
  Object.freeze(snapshot);
  canonicalRequests.add(snapshot);
  return snapshot;
}

function isCanonical<T extends object>(input: T): boolean {
  return canonicalRequests.has(input);
}

export function snapshotOpenRequest(input: OpenRequest): OpenRequest {
  if (isCanonical(input)) return input;
  const source = sourceOf(input, '$');
  const idempotencyKey = text(
    source.idempotencyKey,
    '$.idempotencyKey',
    'Idempotency key',
  );
  const expectedFrameRevision = revision(source.expectedFrameRevision);
  const stakeUnits = source.stakeUnits;
  if (typeof stakeUnits !== 'bigint')
    fail(
      'INVALID_REQUEST',
      'A stake must be a BigInt number of minor units',
      '$.stakeUnits',
    );
  const clientEntropy = text(
    source.clientEntropy,
    '$.clientEntropy',
    'Client entropy',
  );
  const rawSideBets = source.sideBets;
  if (!Array.isArray(rawSideBets))
    fail('INVALID_REQUEST', 'Side bets must be a short array', '$.sideBets');
  const length = rawSideBets.length;
  if (length > 8)
    fail('INVALID_REQUEST', 'Side bets must be a short array', '$.sideBets');
  const sideBets: { readonly id: string; readonly stakeUnits: bigint }[] = [];
  for (let index = 0; index < length; index += 1) {
    const selection = sourceOf(rawSideBets[index], `$.sideBets[${index}]`);
    const id = text(selection.id, `$.sideBets[${index}].id`, 'Side-bet id');
    const selectedStake = selection.stakeUnits;
    if (typeof selectedStake !== 'bigint')
      fail(
        'INVALID_REQUEST',
        'A side-bet stake must be a BigInt number of minor units',
        `$.sideBets[${index}].stakeUnits`,
      );
    sideBets.push(Object.freeze({ id, stakeUnits: selectedStake }));
  }
  return canonical({
    idempotencyKey,
    expectedFrameRevision,
    stakeUnits,
    sideBets: Object.freeze(sideBets),
    clientEntropy,
  }) as OpenRequest;
}

export function snapshotAdvanceRequest(input: AdvanceRequest): AdvanceRequest {
  if (isCanonical(input)) return input;
  const source = sourceOf(input, '$');
  return canonical({
    idempotencyKey: text(
      source.idempotencyKey,
      '$.idempotencyKey',
      'Idempotency key',
    ),
    expectedFrameRevision: revision(source.expectedFrameRevision),
  }) as AdvanceRequest;
}

export function snapshotHarvestRequest(input: HarvestRequest): HarvestRequest {
  if (isCanonical(input)) return input;
  const source = sourceOf(input, '$');
  const units = source.units;
  if (typeof units !== 'number' || !Number.isSafeInteger(units))
    fail('INVALID_REQUEST', 'Harvest units must be a safe integer', '$.units');
  return canonical({
    idempotencyKey: text(
      source.idempotencyKey,
      '$.idempotencyKey',
      'Idempotency key',
    ),
    expectedFrameRevision: revision(source.expectedFrameRevision),
    units,
  }) as HarvestRequest;
}

export function snapshotSettleRequest(
  input: Omit<SettleRequest, 'revealedSeed'>,
  revealedSeed: string,
): SettleRequest {
  if (isCanonical(input as object)) return input as SettleRequest;
  const source = sourceOf(input, '$');
  return canonical({
    idempotencyKey: text(
      source.idempotencyKey,
      '$.idempotencyKey',
      'Idempotency key',
    ),
    expectedFrameRevision: revision(source.expectedFrameRevision),
    revealedSeed,
  }) as SettleRequest;
}

export function snapshotFullSettleRequest(input: SettleRequest): SettleRequest {
  if (isCanonical(input)) return input;
  const source = sourceOf(input, '$');
  return canonical({
    idempotencyKey: text(
      source.idempotencyKey,
      '$.idempotencyKey',
      'Idempotency key',
    ),
    expectedFrameRevision: revision(source.expectedFrameRevision),
    revealedSeed: text(source.revealedSeed, '$.revealedSeed', 'Revealed seed'),
  }) as SettleRequest;
}

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map)
      callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'FrozenMap';
  }
}

/**
 * Copies data before recursively freezing it. Public views therefore share no
 * mutable object identity with the round book that owns settlement custody.
 */
export function frozenCopy<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const clone = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current;
    const prior = seen.get(current);
    if (prior !== undefined) return prior;
    if (current instanceof Map) {
      const entries = [...current.entries()].map(([key, entry]) => [
        clone(key),
        clone(entry),
      ] as const);
      const result = new FrozenMap(entries);
      seen.set(current, result);
      return result;
    }
    if (ArrayBuffer.isView(current)) {
      const result = Object.freeze(Array.from(current as unknown as ArrayLike<number>));
      seen.set(current, result);
      return result;
    }
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const entry of current) result.push(clone(entry));
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, entry] of Object.entries(current)) result[key] = clone(entry);
    return Object.freeze(result);
  };
  return clone(value) as T;
}
