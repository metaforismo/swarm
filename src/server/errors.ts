/**
 * The public failure taxonomy of the SWARM round service.
 *
 * Every refusal a client can provoke is one of these codes. They are the codes
 * `docs/ENGINE.md` names — `INVALID_REQUEST`, `STALE_FRAME`,
 * `IDEMPOTENCY_CONFLICT`, `ROUND_SETTLED`, `EXPOSURE_LIMIT`, `TOO_EARLY`, and the
 * verification codes of §4.6 — plus the two a wallet and a router need. Nothing
 * on the wire ever carries a stack trace: a hostile payload gets a code and a
 * path, exactly like a legitimate mistake does.
 */

export const SWARM_ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'STALE_FRAME',
  'IDEMPOTENCY_CONFLICT',
  'ROUND_SETTLED',
  'EXPOSURE_LIMIT',
  'TOO_EARLY',
  'INSUFFICIENT_FUNDS',
  'ROUND_NOT_FOUND',
  'INVALID_ADAPTER',
  'ADAPTER_MISMATCH',
  'COMMITMENT_MISMATCH',
  'TRANSCRIPT_MISMATCH',
  'DERIVATION_FAILED',
  'INVALID_TRANSCRIPT',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'INTERNAL',
] as const);

export type SwarmErrorCode = (typeof SWARM_ERROR_CODES)[number];

export class SwarmError extends Error {
  readonly code: SwarmErrorCode;
  readonly path: string;
  /** Attached to `ROUND_SETTLED` so a duplicate tap shows the player their terminal. */
  readonly detail: Record<string, unknown> | null;

  constructor(
    code: SwarmErrorCode,
    message: string,
    path = '$',
    detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'SwarmError';
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

export function fail(
  code: SwarmErrorCode,
  message: string,
  path = '$',
  detail: Record<string, unknown> | null = null,
): never {
  throw new SwarmError(code, message, path, detail);
}

const STATUS: Record<SwarmErrorCode, number> = {
  INVALID_REQUEST: 400,
  STALE_FRAME: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ROUND_SETTLED: 409,
  EXPOSURE_LIMIT: 422,
  TOO_EARLY: 409,
  INSUFFICIENT_FUNDS: 422,
  ROUND_NOT_FOUND: 404,
  INVALID_ADAPTER: 500,
  ADAPTER_MISMATCH: 422,
  COMMITMENT_MISMATCH: 422,
  TRANSCRIPT_MISMATCH: 422,
  DERIVATION_FAILED: 422,
  INVALID_TRANSCRIPT: 400,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL: 500,
};

export function statusFor(code: SwarmErrorCode): number {
  return STATUS[code] ?? 500;
}

/**
 * Turns anything thrown inside a handler into a public code.
 *
 * An engine `RevealEngineError` carries its own code (`INVALID_CONTEXT`,
 * `INVALID_RATIONAL`, ...); those reach the wire as `INVALID_REQUEST` with the
 * engine's code kept in the path, because they are always provoked by a request
 * field. Anything else is `INTERNAL` with no message, because an unexpected throw
 * is not a message a client should be reading.
 */
export function toSwarmError(error: unknown): SwarmError {
  if (error instanceof SwarmError) return error;
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : 'Rejected';
    const path = 'path' in error ? String((error as { path: unknown }).path) : '$';
    return new SwarmError('INVALID_REQUEST', message, `${path} (${code})`);
  }
  return new SwarmError('INTERNAL', 'The round service refused the command');
}
