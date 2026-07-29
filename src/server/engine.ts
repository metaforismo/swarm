/**
 * Everything SWARM takes from Reveal Engine, in one file.
 *
 * `docs/ENGINE.md` §1 lists what a `staged-survival` consumer must reuse verbatim
 * rather than re-implement: exact `Rational` arithmetic, `payable()` /
 * `payableWithinCap()`, the canonical length-prefixed field encoding,
 * domain-separated rejection sampling, constant-time digest comparison, the
 * error taxonomy, `ENGINE_LIMITS`, and the frame-revision / idempotency /
 * receipt discipline of `RoundBook`. This module is that list, imported from the
 * real package (`@axiom-games/reveal-engine@0.4.0`, installed from the tarball in
 * `vendor/`), so every consumption site is greppable and no copy of engine code
 * lives in this repository.
 *
 * Two honest deviations, stated here rather than discovered later:
 *
 *  1. **The cohort lifecycle is not in the engine.** Reveal Engine 0.4 ships a
 *     `staged-survival` module, and its own documentation
 *     (`reveal-engine/docs/modules/staged-survival.md` §10) says why SWARM cannot
 *     be expressed by it: "SWARM's organisms _split_: its population grows... This
 *     module resolves a shrinking subset of a fixed entity set and cannot express
 *     offspring." So the branching population, the ladder, the harvest quantum,
 *     the wild line and the per-line side-bet ledger are implemented here, against
 *     the contract in `docs/ENGINE.md`, on top of the engine primitives below.
 *     Nothing here re-implements a primitive the engine exports.
 *
 *  2. **`encodeFields` is not exported.** It lives in the engine's
 *     `src/internal/canonical.ts` and is absent from every entry in the package
 *     `exports` map, so it cannot be imported. `./canonical.ts` carries a
 *     byte-identical port, and `tests/server-derivation.test.mjs` pins it against
 *     the reference encoder in `tools/simulate.mjs` — which is itself the encoder
 *     every published SWARM digest was produced with.
 *
 * The sampler is the third case and it is not a deviation: `docs/ENGINE.md` §4.1
 * specifies an 11-field payload carrying the adapter fingerprint and the player's
 * client entropy, and the engine's `uniformBigInt` seals an 8-field payload with
 * neither. Using the engine's function would change every draw in the game and
 * break every frozen vector in this repository. `./derivation.ts` implements the
 * specified payload with the engine's rejection bound and the canonical encoding,
 * and the engine's own module works around the same gap (its ADR 0008 packs the
 * entropy into `roundId`).
 */

export {
  add,
  compare,
  divide,
  equal,
  floor,
  multiply,
  rational,
  subtract,
  type Rational,
} from '@axiom-games/reveal-engine/core';

/** The money path: floor to minor units, apply this line's cap on this line's stake. */
export { payable, payableWithinCap, type Payable } from '@axiom-games/reveal-engine/core';

/** Proof primitives: constant-time comparison, seed normalization, digests. */
export { constantTimeHexEqual, normalizeSeed, sha256Hex } from '@axiom-games/reveal-engine/core';

/** `RoundBook` discipline: an idempotency key is bound to the command payload it first ran. */
export { assertIdempotencyKey, commandFingerprint } from '@axiom-games/reveal-engine/core';

/** The typed failure taxonomy and the engine-wide bounds every request is held to. */
export { ENGINE_LIMITS, ERROR_CODES, RevealEngineError } from '@axiom-games/reveal-engine/api';

/**
 * The engine's own version identities, imported rather than restated.
 *
 * These are what the fairness surface publishes as *the engine's*: the API
 * version of the installed package and the module-API version its lifecycle
 * modules conform to. SWARM's `MODULE_API` — `reveal-engine/staged-survival-v1`
 * — is a different string with a different owner: it is the contract identity of
 * `docs/ENGINE.md`, a module that does not exist in the engine, and publishing
 * the two side by side is the only way a player can tell them apart.
 */
export { ENGINE_API_VERSION, MODULE_API_VERSION } from '@axiom-games/reveal-engine/api';

/**
 * The `staged-survival` lifecycle module's own client-entropy contract.
 *
 * This is the one rule SWARM and the shipped module agree on exactly: 32 bytes of
 * lowercase hex, chosen after the seed pre-commitment, mandatory. Validating
 * through the module's assert rather than a local regex means a future change to
 * `SURVIVAL_LIMITS.clientEntropyBytes` reaches this game as a build failure.
 */
export {
  assertClientEntropy,
  assertOperatorRoundId,
  SURVIVAL_LIMITS,
  STAGED_SURVIVAL_MODULE_ID,
  STAGED_SURVIVAL_MODULE_VERSION,
} from '@axiom-games/reveal-engine/modules/staged-survival';
