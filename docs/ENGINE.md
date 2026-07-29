# SWARM on Reveal Engine — the `staged-survival` module

SWARM does not fit the progressive-information-market core that Reveal Engine
0.2 was built for. This document specifies the lifecycle module it does need,
`staged-survival`, and the exact adapter surface SWARM expects from it.

**Status, stated plainly: this module does not exist in Reveal Engine 0.2.**
Nothing here is implemented in the engine repository yet. This is the contract
SWARM is written against; `tools/simulate.mjs` in this repository is a working
reference implementation of the derivation and settlement rules, and
`tools/lib/model.mjs` is a working reference implementation of the pricing.

---

## 1. Why a new module

Reveal Engine 0.2 (`reveal-engine/api-v1`) models a round as **one hidden truth
plus a schedule of evidence** that moves a posterior between outcomes. Its
adapter declares `outcomes`, `priorWeights` and an `EvidenceSchedule`; its
pricing is `r / p_i`; its proof commits the whole transcript up front because
the transcript does not depend on what the player does.

SWARM breaks three of those assumptions:

| Assumption in `api-v1` | SWARM |
| --- | --- |
| A round has one hidden truth drawn from a prior | A round has a *process*: 18 generations of independent per-organism draws. There is no "true outcome" to hide |
| Price comes from a posterior over outcomes | Price comes from a **population count** and a deterministic ladder. There is no posterior |
| The full transcript is fixed at commit time | The player's harvests change **how many draws are consumed per stage**, so the consumed transcript is action-dependent |
| Continuation is optional and out of scope | Staged continuation *is* the game, and the ride ledger must be first-class |

What SWARM does share with the existing core, and must reuse verbatim rather
than re-implement: exact `Rational` arithmetic, `payable()` /
`payableWithinCap()`, the canonical length-prefixed `encodeFields` encoding,
domain-separated rejection sampling (`uniformBigInt`), the `RevealEngineError`
code taxonomy, `ENGINE_LIMITS`, and the frame-revision / idempotency / receipt
discipline of `RoundBook`.

---

## 2. Identity and versions

| Identity | Value | Change rule |
| --- | --- | --- |
| Module API | `reveal-engine/staged-survival-v1` | New value for any breaking runtime or type contract |
| Adapter | `swarm-colony-v1` @ `1.0.0` | New `adapterVersion` for any replay-visible change |
| Cohort model | `swarm-cohort/v1` | New value for any change to draw bands or child counts |
| Commitment | `reveal-engine/stage-commit-v1` | New rounds use current; older values verification-only |
| Transcript | `reveal-engine/stage-transcript-v1` | Bounded migration parser, fail closed on unknown |
| Receipt | `receipt-v1` (reused) | Immutable money-movement record |
| Snapshot | `stage-book-v1` | Reject unknown versions |
| Paytable fixture | `swarm/paytable-v1` | Regenerated and re-frozen with any of the above |

The adapter fingerprint binds: module API, adapter id and version, cohort model
version, draw modulus, every outcome band `(id, children, weight)` in order,
seed units, stage count, both thresholds, ladder base and step, target RTP,
rounding mode, and max-win multiple. Changing any of them changes the
fingerprint, and a transcript is only verifiable against the fingerprint it was
produced under.

---

## 3. Adapter surface

```ts
import type { Rational } from '@axiom-games/reveal-engine/core';

export const STAGED_SURVIVAL_API = 'reveal-engine/staged-survival-v1' as const;

/** One band of the per-unit draw. Bands must tile [0, drawModulus) exactly, in order. */
export interface CohortOutcome {
  readonly id: string;        // 'DIE' | 'HOLD' | 'SPLIT'
  readonly children: number;  // 0 <= children <= maxChildren
  readonly weight: bigint;    // > 0
}

export interface CohortModel {
  /** Adapter-owned promise: unchanged identity means unchanged draw behaviour. */
  readonly modelVersion: string;      // 'swarm-cohort/v1'
  readonly drawModulus: bigint;       // 20n
  readonly maxChildren: number;       // 2
  readonly outcomes: readonly CohortOutcome[];
}

/** value of one unit at stage t = base * step^(t-1). */
export interface LadderPolicy {
  readonly base: Rational;   // 19/48
  readonly step: Rational;   // 5/4
  readonly stages: number;   // 18
}

export interface StageThresholds {
  /** Force settlement when the population reaches this size (FULL BLOOM). */
  readonly settleAtOrAbove: number;   // 16
  /** Hard bound on population; must equal maxChildren * (settleAtOrAbove - 1). */
  readonly maxUnits: number;          // 30
}

export interface ThinningPolicy {
  /** Whether HARVEST exists at all. */
  readonly allowPartial: boolean;             // true
  /** The affordance a client should expose. The protocol always accepts any legal k. */
  readonly clientQuantum: 'floor-half' | 'any';
  /** Units are removed from the highest slots and the colony is recompacted. */
  readonly removal: 'highest-slots';
}

export interface StagedSurvivalDefinition {
  readonly apiVersion: typeof STAGED_SURVIVAL_API;
  readonly adapterVersion: string;
  readonly id: string;
  readonly seedUnits: number;         // 3
  readonly cohort: CohortModel;
  readonly ladder: LadderPolicy;
  readonly thresholds: StageThresholds;
  readonly thinning: ThinningPolicy;
  readonly pricing: {
    readonly targetRtp: Rational;     // 19/20
    readonly rounding: 'floor';
  };
  readonly risk: {
    /** Applied to the cumulative credit of a round, on the original stake basis. */
    readonly maxWinMultiple: bigint;  // 906n
  };
}
```

### 3.1 Engine-provided functions

```ts
/** The only supported construction path: validates, clones, deep-freezes. */
export function defineStagedSurvival(input: StagedSurvivalDefinition): StagedSurvivalDefinition;

export function stagedSurvivalFingerprint(game: StagedSurvivalDefinition): string;

/** Exact mean offspring of the cohort model. */
export function cohortMean(game: StagedSurvivalDefinition): Rational;

/** value of one unit at `stage`; throws outside [1, ladder.stages]. */
export function ladderValue(game: StagedSurvivalDefinition, stage: number): Rational;

/** value of `units` units at `stage`, exactly `ladderValue(game, stage) * units`. */
export function cohortValue(game: StagedSurvivalDefinition, stage: number, units: number): Rational;

/**
 * The fairness contract, checked mechanically at definition time:
 *   ladder.step * cohortMean(game) === 1
 *   ladder.base * seedUnits * cohortMean(game) === pricing.targetRtp
 * The first identity is what makes cohort value a martingale across a stage;
 * the second is what makes the entry price the entire house edge.
 * Throws INVALID_ADAPTER if either fails.
 */
export function assertLadderIsFair(game: StagedSurvivalDefinition): void;
```

`assertLadderIsFair` is the reason this module can be trusted with a new game
configuration: an adapter whose ladder does not exactly cancel its cohort drift
cannot be defined at all, so no future title built on this module can ship a
silently policy-dependent RTP.

### 3.2 The SWARM adapter

```ts
export const swarmColonyV1 = defineStagedSurvival({
  apiVersion: STAGED_SURVIVAL_API,
  adapterVersion: '1.0.0',
  id: 'swarm-colony-v1',
  seedUnits: 3,
  cohort: {
    modelVersion: 'swarm-cohort/v1',
    drawModulus: 20n,
    maxChildren: 2,
    outcomes: [
      { id: 'DIE',   children: 0, weight: 8n },   // draws 0-7
      { id: 'HOLD',  children: 1, weight: 8n },   // draws 8-15
      { id: 'SPLIT', children: 2, weight: 4n },   // draws 16-19
    ],
  },
  ladder: { base: rational(19n, 48n), step: rational(5n, 4n), stages: 18 },
  thresholds: { settleAtOrAbove: 16, maxUnits: 30 },
  thinning: { allowPartial: true, clientQuantum: 'floor-half', removal: 'highest-slots' },
  pricing: { targetRtp: rational(19n, 20n), rounding: 'floor' },
  risk: { maxWinMultiple: 906n },
});
```

---

## 4. Derivation and commitment

### 4.1 The draw grid

A round's randomness is a grid of `stages x (settleAtOrAbove - 1)` draws — for
SWARM, `18 x 15 = 270` — indexed by stage and slot:

```ts
export function drawIndex(game: StagedSurvivalDefinition, stage: number, slot: number): number;
// (stage - 1) * (thresholds.settleAtOrAbove - 1) + (slot - 1)

export function stageDraw(
  seedHex: string,
  context: StageContext,
  game: StagedSurvivalDefinition,
  stage: number,
  slot: number,
): bigint;
// uniformBigInt(seedHex, context, 'swarm-organism', drawIndex(...), game.cohort.drawModulus)
```

`uniformBigInt` is the engine's existing exact rejection sampler: a
domain-separated HMAC-SHA256 over the canonical field vector
`['sampler', commitmentVersion, gameId, roundId, label, counter, nonce, modulus]`,
retried until the 256-bit value falls below `2^256 - (2^256 mod modulus)`. No
modulo bias, no floats, no wall-clock input.

At stage `t` with `n` units entering, slots `1 ... n` are consumed. Harvest
removes the highest slots and recompacts, so the number of draws a stage
consumes is the population, and the population alone.

### 4.2 Commitment

```
commitment = sha256(encodeFields([
  'Axiom Games SWARM commitment',
  'reveal-engine/stage-commit-v1',
  seedBytes,                       // 32 bytes
  game.id,
  game.adapterVersion,
  stagedSurvivalFingerprint(game),
  roundId,
  game.ladder.stages,
  game.thresholds.settleAtOrAbove - 1,
  game.cohort.drawModulus,
]))
```

**This commits the seed and the grid shape, not the consumed transcript.** That
is a deliberate difference from `commit-v2`, and it is sound: the entire grid is
a deterministic function of the committed seed and the fingerprinted adapter, so
the operator cannot change a single draw after publication, whatever the player
does. What the player's actions determine is only *which* committed draws their
colony meets. The action log is bound separately by the receipt ledger and the
frame fence (§5), so an operator cannot rewrite history in either direction.

`adapterFingerprint()` in `tools/simulate.mjs` is the reference implementation
of `stagedSurvivalFingerprint` for this adapter, binding exactly the field list
in §2. For `swarm-colony-v1 @ 1.0.0` it is

```
0ce06d9c6d3f5d55cd7379c42c46d3efedae4d3966d103acd307038e9aa4290b
```

and `tests/derivation.test.mjs` freezes it, so any change to the offspring
bands, the ladder, the thresholds, the target RTP or the cap changes the
fingerprint and fails the build until the adapter version is bumped with it.

The commitment must be durably published before the round opens and before any
seed-dependent information reaches the client. The seed is revealed only at
settlement.

### 4.3 Verification algorithm

Given `{ commitment, revealedSeed, roundId, adapter, actionLog, receipts }` a
verifier must:

1. Recompute `stagedSurvivalFingerprint(adapter)` and compare with the recorded
   fingerprint. Mismatch -> `ADAPTER_MISMATCH`.
2. Recompute the commitment from the revealed seed. Mismatch ->
   `COMMITMENT_MISMATCH`.
3. Replay: `units := seedUnits`; for each stage in order, consume draws for
   slots `1 ... units`, map each draw through the cohort bands, sum children,
   apply the terminal rules (`0` -> EXTINCT, `>= settleAtOrAbove` -> THRESHOLD,
   `stage === stages` -> FINAL), then apply the action recorded for that stage.
4. Recompute every credit as `floor(stakeUnits * cohortValue(stage, k))` with
   the cumulative cap, and compare against the receipt ledger amount for amount
   and order. Mismatch -> `TRANSCRIPT_MISMATCH`.
5. Recompute side-bet resolutions on the **wild line** — the same replay with an
   empty action log — and compare. Mismatch -> `TRANSCRIPT_MISMATCH`.

Steps 3–5 are exactly what `tools/simulate.mjs` does, which is why that file is
part of the specification rather than a toy.

---

## 5. Lifecycle

```
        open()            advance()          advance()               settle()
IDLE ──────────► STAGED ──────────► STAGED ──────────► ... ──────────► SETTLED
                   │  ▲                                    ▲
         harvest() │  └────────────────────────────────────┘
                   ▼           (harvest never advances the stage)
                RESOLVED
```

States: `IDLE`, `STAGED` (a stage has resolved and the player owes a decision),
`SETTLED` (terminal). Terminal reasons: `EXTINCT`, `THRESHOLD`, `FINAL`,
`BANKED`.

```ts
export interface StageContext {
  readonly gameId: string;
  readonly roundId: string;
  readonly proofVersion: 'reveal-engine/stage-commit-v1';
}

export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;   // 0
  readonly stakeUnits: bigint;              // integer minor units
  readonly sideBets: readonly string[];     // 'FIRST_LIGHT' | 'DARK_VENT' | 'SWARM'
  readonly sideBetStakeUnits: bigint;
}

export interface AdvanceRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
}

export interface HarvestRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  /** 0 < units <= current population. `units === population` is a full bank. */
  readonly units: number;
}

export interface SettleRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly revealedSeed: string;            // 64 lowercase hex
}

export interface StageFrame {
  readonly revision: number;                // monotonic, bumped by advance/harvest
  readonly stage: number;                   // 0 before the first advance
  readonly units: number;
  readonly unitValue: Rational;             // ladderValue(game, stage)
  readonly colonyValue: Rational;           // unitValue * units
  readonly terminal: 'EXTINCT' | 'THRESHOLD' | 'FINAL' | 'BANKED' | null;
}

export interface Receipt {
  readonly schema: 'receipt-v1';
  readonly sequence: number;                // ledger revision, independent of frame revision
  readonly kind: 'OPEN' | 'HARVEST' | 'SETTLE';
  readonly stage: number;
  readonly unitsHarvested: number;
  readonly theoretical: Rational;           // exact, unrounded
  readonly creditedUnits: bigint;           // floor, after cap
  readonly capped: boolean;
}

export class StageBook {
  constructor(game: StagedSurvivalDefinition, context: StageContext, commitment: string);
  readonly frame: StageFrame;
  open(request: OpenRequest): Promise<Receipt>;
  advance(request: AdvanceRequest): Promise<StageFrame>;
  harvest(request: HarvestRequest): Promise<Receipt>;
  settle(request: SettleRequest): Promise<readonly Receipt[]>;
  snapshot(): StageBookSnapshot;            // schema 'stage-book-v1'
  static restore(game: StagedSurvivalDefinition, snapshot: unknown): StageBook;
}
```

Rules the module must enforce, all inherited from `RoundBook` discipline:

- **Frame fence.** Every mutating call carries `expectedFrameRevision`; a stale
  value fails `STALE_FRAME` and mutates nothing.
- **Idempotency.** Each successful command is bound to its key by a canonical
  fingerprint of the command payload. An exact retry replays the receipt; a
  changed payload under the same key fails `IDEMPOTENCY_CONFLICT`.
- **Separate revisions.** Frame revision (price/state) and ledger sequence
  (money) advance independently, so a duplicated advance can never look like a
  money movement and vice versa.
- **Cap basis.** The original stake is the cap basis for the whole round;
  `payableWithinCap` subtracts already-credited units, so the cumulative credit
  of a round can never exceed `stakeUnits * maxWinMultiple` even across many
  harvests.
- **Compute before mutate.** Validate and compute the receipt first, mutate
  state second, so a thrown error cannot leave a half-settled round.
- **Settlement is proof-bound.** `settle()` accepts only a seed whose
  commitment matches, and re-derives the entire round before crediting.
- **Advance cannot be initiated by the server.** There is no timer and no
  auto-advance; a round with no player input stays in `STAGED` forever, which is
  what makes the game latency-insensitive by construction.

---

## 6. Conformance requirements

A `staged-survival` conformance suite must mechanically check, for every bundled
adapter:

1. Draw bands tile `[0, drawModulus)` exactly, in order, with positive weights.
2. `maxUnits === maxChildren * (settleAtOrAbove - 1)`.
3. `assertLadderIsFair` passes: `step * mean === 1` and
   `base * seedUnits * mean === targetRtp`, exactly.
4. Derivation is deterministic: deriving the same grid twice yields identical
   draws; deriving with a different `roundId`, `gameId` or fingerprint yields a
   different grid.
5. The sampler is unbiased: for a small modulus, the rejection bound
   `2^256 - (2^256 mod modulus)` is respected (assert the bound, do not
   statistically test it).
6. Exhaustive value check: for every `(stage, units)` in the state space, the
   continuation value equals `cohortValue(stage, units)` exactly — the same
   backward induction `proveStrategyInvariance()` performs in this repository.
7. `maxWinMultiple` strictly exceeds the exact maximum total a round can credit,
   computed by the deterministic dynamic program, so the cap cannot truncate.
8. Snapshot round-trips: restore validates adapter identity, receipt ordering,
   cap accounting, and a deterministic checksum, and rejects any unknown schema
   version.

Checks 6 and 7 are what make this module different from a generic ride ledger:
the fairness of the whole game reduces to two exactly-checkable identities plus
one dynamic program, and all three are cheap enough to run in CI.

---

## 7. What this module needs that Reveal Engine 0.2 does not have

| Needed | Present in 0.2 | Note |
| --- | --- | --- |
| Exact `Rational`, `payable`, `payableWithinCap` | Yes | Reuse verbatim |
| `encodeFields`, `uniformBigInt`, error codes, limits | Yes | Reuse verbatim |
| Frame fence, idempotency, receipts, snapshots | Yes, in `RoundBook` | Generalize, do not fork |
| Population-based pricing with no posterior | **No** | New `ladderValue` / `cohortValue` |
| Action-dependent draw consumption | **No** | New grid indexing and commitment scheme |
| Multi-credit round with a cumulative cap | Partial | `payableWithinCap` exists; the ride ledger does not |
| Mechanical fairness identity check | **No** | New `assertLadderIsFair` |
| Staged conformance suite | **No** | New, per §6 |

The engine's own documentation already flags the gap: continuation economics are
declared out of scope of its within-round invariance theorem and its core
"validates continuation configuration but does not implement a production ride
ledger". `staged-survival` is that ledger, specified.

---

## 8. Boundary

This document is a contract, not evidence of an implementation. Until the module
exists in Reveal Engine and passes §6, SWARM's claims rest on the reference
implementations in this repository: `tools/lib/model.mjs` for pricing and
`tools/simulate.mjs` for derivation and settlement. Neither is a production
round server, neither has been reviewed against a jurisdictional requirement,
and neither replaces operator wallet integration, authenticated storage, seed
custody, or any laboratory process.
