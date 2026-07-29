/**
 * The round API, as the client sees it.
 *
 * Every mutating call carries an idempotency key and the frame revision it was
 * fenced to, exactly as `docs/ENGINE.md` §5.1 requires — so a retry after a
 * dropped connection replays the same receipts instead of moving money twice,
 * and a command built against a stale frame is refused rather than applied.
 */

export class ApiError extends Error {
  constructor(code, message, path, detail) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.path = path;
    this.detail = detail ?? null;
  }
}

let sequence = 0;

/** A fresh idempotency key. Stable per command, never reused across commands. */
export function commandKey(action) {
  sequence += 1;
  return `${action}-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error ?? {};
    throw new ApiError(error.code ?? 'INTERNAL', error.message ?? 'The round service refused the command', error.path, error.detail);
  }
  return payload;
}

export const api = {
  config: () => request('GET', '/api/config'),
  session: () => request('GET', '/api/session'),
  createRound: () => request('POST', '/api/rounds'),
  round: (roundId) => request('GET', `/api/rounds/${encodeURIComponent(roundId)}`),
  open: (roundId, body) => request('POST', `/api/rounds/${encodeURIComponent(roundId)}/open`, body),
  advance: (roundId, body) =>
    request('POST', `/api/rounds/${encodeURIComponent(roundId)}/advance`, body),
  harvest: (roundId, body) =>
    request('POST', `/api/rounds/${encodeURIComponent(roundId)}/harvest`, body),
  settle: (roundId, body) =>
    request('POST', `/api/rounds/${encodeURIComponent(roundId)}/settle`, body),
  verify: (proof) => request('POST', '/api/verify', { proof }),
  /**
   * `docs/DESIGN.md` §9.9. Limits and the reality-check clock are server state,
   * not client state: a limit a reload clears is not a limit.
   */
  limits: () => request('GET', '/api/limits'),
  setLimit: (field, value) => request('POST', '/api/limits', { [field]: value }),
  acknowledgeRealityCheck: () => request('POST', '/api/reality-check'),
};

/**
 * 32 bytes of client entropy, generated **here**.
 *
 * It is never pre-filled from a server response, and that is the one detail that
 * makes the control worth having: the server sealed its seed before this value
 * existed, so it cannot have chosen a grid to suit it (`docs/ENGINE.md` §4.5).
 */
export function generateClientSeed() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isClientSeed(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/u.test(value);
}
