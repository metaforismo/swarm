# SWARM on Reveal Engine — the `staged-survival` module

SWARM does not fit the progressive-information-market core that Reveal Engine
0.2 was built for. This document specifies the lifecycle module it does need,
`staged-survival`, and the exact adapter surface SWARM expects from it.

**Status, stated plainly: this module does not exist in Reveal Engine 0.2.**
Nothing here is implemented in the engine repository yet. This is the contract
SWARM is written against; `tools/simulate.mjs` in this repository is a working
reference implementation of the derivation, the two-phase commitment, the
side-bet resolution, the settlement ledger and the verifier, and
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

That third row is the load-bearing one. In Reveal Engine's own vocabulary SWARM
is a **choice-timed** module (`choiceTiming: 'before-step'`), and the module
contract makes one thing mandatory for those: a **two-phase** commitment.
Section 4 is that scheme. Round 2 of this specification shipped phase 1 only and
asserted that the receipt ledger closed the gap; it does not, and section 4.6
says so in the same words the finding used.

What SWARM does share with the existing core, and must reuse verbatim rather
than re-implement: exact `Rational` arithmetic, `payable()` /
`payableWithinCap()`, the canonical length-prefixed `encodeFields` encoding,
domain-separated rejection sampling (`uniformBigInt`), constant-time digest
comparison, the `RevealEngineError` code taxonomy, `ENGINE_LIMITS`, and the
frame-revision / idempotency / receipt discipline of `RoundBook`.

---

## 2. Identity and versions

| Identity | Value | Change rule |
| --- | --- | --- |
| Module API | `reveal-engine/staged-survival-v1` | New value for any breaking runtime or type contract, **from the first released implementation**. There is none yet (§8), so a pre-release amendment to this document is recorded in the changelog below rather than by a version bump |
| Adapter | `swarm-colony-v1` @ `1.3.0` | New `adapterVersion` for any replay-visible change |
| Cohort model | `swarm-cohort/v1` | New value for any change to draw bands or child counts |
| Seed pre-commitment | `reveal-engine/stage-seed-commit-v1` | Phase 1. New rounds use current; older values verification-only |
| Settlement body commitment | `reveal-engine/stage-body-commit-v2` | Phase 2. Same rule |
| Draw sampler domain | `reveal-engine/stage-draw-v2` | New value for any change to the sampler payload |
| Action chain domain | `reveal-engine/stage-action-chain-v1` | New value for any change to the live chain |
| Transcript | `reveal-engine/stage-transcript-v1` | Bounded migration parser, fail closed on unknown |
| Receipt | `receipt-v2` | Immutable money-movement record; v2 added `line` and `direction` |
| Paytable fixture | `swarm/paytable-v3` | Regenerated and re-frozen with any of the above |

**Adapter changelog.** `1.1.0` replaced the single round-level max-win multiple
with **one cap basis per bet line**. `1.2.0` changed the proof surface and the
derivation:

- player-supplied **client entropy** enters every draw (§4.1, §4.5);
- the single-phase commitment became the mandatory **two-phase** scheme, with a
  settlement body that seals the action log (§4.2, §4.3);
- a **live action chain** is returned with every frame, so the player holds a
  pre-reveal witness of their own decision log (§4.3);
- the harvest quantum opened from `floor-half` to **any legal `k`** (§3, and
  [MATH.md §11](MATH.md), whose published volatility maximum needs it);
- the wild line became disclosable **one generation behind the player's own**
  (§5.2), which is what the leak argument actually permits.

`1.3.0` closed the protocol against its own transcript:

- a stage accepts **exactly one harvest commitment** (`thinning.commitsPerStage`,
  §5.3). Round 3 let the command surface accept a second harvest at the same
  stage while the verifier, the action-log bound and [MATH.md §1.1](MATH.md) all
  assumed it could not, so a legal command sequence produced a round the
  published verifier refused;
- the settlement body seals the **settlement mode** (§4.4), so an abandoned
  round and a player-settled round with the same log are two distinguishable
  digests rather than two readings of one — which is what the `RECONCILED`
  terminal needs in order to mean anything;
- **stage 0 has a defined settlement** (§5.5). It previously did not, and stage 0
  is a `STAGED` state that the abandonment trigger covers.

Every one of those is replay-visible, so all of them take one new adapter
version, one new fingerprint and one re-frozen fixture — which is the change
rule above being used rather than described.

The adapter fingerprint binds: module API, adapter id and version, cohort model
version, **both commitment versions, the sampler domain, the action-chain domain
and the client-entropy width**, draw modulus, every outcome band
`(id, children, weight)` in order, seed units, stage count, both thresholds, the
harvest quantum, **the number of harvest commitments a stage accepts**, ladder
base and step, target RTP, rounding mode, the colony cap, and every side-bet line
with its own cap in declaration order. Changing any of them changes the
fingerprint, and a transcript is only verifiable against the fingerprint it was
produced under. `commitsPerStage` is in that list because it decides which action
logs are legal, and a rule about legal transcripts is part of the replay contract
exactly like a draw band is.

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
  /**
   * The affordance a client must expose. `any` means every legal k in [0, n] is
   * reachable from the UI. It is `any` and not `floor-half` because MATH.md §11
   * publishes a volatility interval whose maximum is attained by harvesting
   * exactly one organism, and a published range the client cannot reach is a
   * range the product does not actually offer.
   */
  readonly clientQuantum: 'any';
  /**
   * How many harvest commitments one stage accepts. One: the decision at a
   * stage is a single choice of `k` in `[0, units]`, and committing it closes
   * that stage's decision (§5.3).
   *
   * It costs the player nothing — `floor(x) + floor(y) <= floor(x + y)`, so
   * splitting a harvest at one ladder value never pays more
   * ([MATH.md §13](MATH.md)) — and it is what makes the action log one entry per
   * stage, which the verifier, the transcript bound and MATH.md §1.1 all assume.
   */
  readonly commitsPerStage: 1;
  /** Units are removed from the highest slots and the colony is recompacted. */
  readonly removal: 'highest-slots';
}

/** Player entropy contributed to the derivation. See section 4.1 and 4.5. */
export interface EntropyPolicy {
  /** Width of the player's contribution. Rejected if it is not exactly this. */
  readonly clientEntropyBytes: number;   // 32
  /** Mandatory: a round cannot open without one. */
  readonly required: true;
  /**
   * The client generates one by default and the player may replace it before
   * SEED. It is published in the clear with the round, because its only job is
   * to be chosen after the seed commitment.
   */
  readonly playerEditable: boolean;      // true
}

/**
 * A side bet resolved on the wild line: the same committed grid replayed with an
 * empty action log. `maxWinMultiple` is this line's own ceiling on this line's
 * own stake — never on the colony stake, never shared with another line.
 */
export interface SideBetDefinition {
  readonly id: string;                  // 'FIRST_LIGHT' | 'DARK_VENT' | 'SWARM'
  readonly predicate:
    | { readonly kind: 'UNITS_AT_STAGE_AT_LEAST'; readonly stage: number; readonly units: number }
    | { readonly kind: 'EXTINCT_BY_STAGE'; readonly stage: number }
    | { readonly kind: 'PEAK_UNITS_AT_LEAST'; readonly units: number };
  readonly maxWinMultiple: bigint;
  readonly minStakeUnits: bigint;
  readonly maxStakeUnits: bigint;
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
  readonly entropy: EntropyPolicy;
  readonly sideBets: readonly SideBetDefinition[];
  readonly pricing: {
    readonly targetRtp: Rational;     // 19/20
    readonly rounding: 'floor';
  };
  readonly risk: {
    /**
     * Cap on the cumulative credit of the COLONY line, on the COLONY stake.
     * Every line is capped on its own stake; there is no cap that sums lines.
     */
    readonly colonyMaxWinMultiple: bigint;    // 906n
    readonly minStakeUnits: bigint;
    readonly maxStakeUnits: bigint;
    /**
     * Operator admission limit on the whole ticket's worst-case liability,
     * checked at `open()`. A refusal happens before money moves; nothing is
     * ever truncated at settlement to fit this number.
     */
    readonly maxTicketExposureUnits: bigint;  // 1_000_000_000_000n
  };
  readonly lifecycle: {
    /**
     * A round with no player command for this long is reconciled by a forced
     * BANK (§5.5). There is still no timer inside a live session: this is four
     * orders of magnitude above any human decision latency.
     */
    readonly abandonedRoundTimeoutHours: number;   // 72
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

/**
 * value of one unit at `stage`; throws outside [1, ladder.stages].
 *
 * **Stage 0 has no ladder value, deliberately.** [MATH.md §5](MATH.md) defines
 * `c(0) = 19/60` as the accounting identity that makes the entry price the whole
 * house edge, and that value is outside the ladder on purpose: paying it would
 * be paying a `0.95x` settlement on a round in which nothing was revealed. A
 * stage-0 frame therefore carries a null unit value (§5), and the abandonment
 * rule never needs one (§5.5).
 */
export function ladderValue(game: StagedSurvivalDefinition, stage: number): Rational;

/** value of `units` units at `stage`, exactly `ladderValue(game, stage) * units`. */
export function cohortValue(game: StagedSurvivalDefinition, stage: number, units: number): Rational;

/** Exact probability of a side bet, by enumeration over the wild line. */
export function sideBetProbability(game: StagedSurvivalDefinition, id: string): Rational;

/** Exact price of a side bet: targetRtp / probability. Never a rounded decimal. */
export function sideBetMultiplier(game: StagedSurvivalDefinition, id: string): Rational;

/** Worst-case liability of a ticket, in minor units. A disclosure, not a clip. */
export function ticketExposureUnits(
  game: StagedSurvivalDefinition,
  stakeUnits: bigint,
  sideBetStakes: ReadonlyMap<string, bigint>,
): bigint;

/**
 * The fairness contract, checked mechanically at definition time:
 *   ladder.step * cohortMean(game) === 1
 *   ladder.base * seedUnits * cohortMean(game) === pricing.targetRtp
 * The first identity is what makes cohort value a martingale across a stage;
 * the second is what makes the entry price the entire house edge.
 * Throws INVALID_ADAPTER if either fails.
 */
export function assertLadderIsFair(game: StagedSurvivalDefinition): void;

/**
 * The risk contract, checked mechanically at definition time, per line:
 *   colonyMaxWinMultiple  >  max cumulative COLONY credit (dynamic program)
 *   sideBet.maxWinMultiple > sideBetMultiplier(id)          for every side bet
 *   maxTicketExposureUnits > ticketExposureUnits at the declared stake bounds
 * Throws INVALID_ADAPTER on any violation, so no configuration in which a cap
 * could truncate a credit can be defined at all.
 */
export function assertRiskIsHeadroom(game: StagedSurvivalDefinition): void;

/**
 * The proof contract, checked mechanically at definition time. A choice-timed
 * definition must declare both commitment phases and a client-entropy width, and
 * `defineStagedSurvival()` refuses to build one that does not — the same refusal
 * `defineLifecycleModule()` performs in the engine, applied one level down at
 * the adapter.
 */
export function assertCommitmentIsTwoPhase(game: StagedSurvivalDefinition): void;
```

`assertLadderIsFair` is the reason this module can be trusted with a new game
configuration: an adapter whose ladder does not exactly cancel its cohort drift
cannot be defined at all, so no future title built on this module can ship a
silently policy-dependent RTP. `assertRiskIsHeadroom` is the reason it can be
trusted with money: a cap that could bite would break the invariance theorem
([MATH.md §12](MATH.md)). `assertCommitmentIsTwoPhase` is the reason it can be
trusted with a decision: a choice-timed round whose body does not bind its own
action log has a verifier that verifies nothing about what the player did.

#### 3.1.1 The payable boundary

The invariant is exact for the **theoretical rational value**. Wallet credits are
integer minor units and apply `floor` once per credit event, so payable value is
never higher:

```
0 <= sum(x_i) - sum(floor(x_i)) < m minor units
```

for `m` credit events. The shipped one-commit-per-generation protocol permits at
most `m = 18` COLONY credits (`17` harvests plus settlement), so its absolute
shortfall is **strictly less than 18 units = 0.000018 credits**. At the minimum
COLONY stake of `100,000` units, that is **less than `1.8e-4` of stake, or 0.018
percentage points of RTP**. Each selected side bet has one independently floored
credit on its own stake, so a four-line ticket has at most 21 floor events across
four separate bases. Splitting value across more payable events can only move the
result downward (`floor(x) + floor(y) <= floor(x + y)`), never in the player's
favor. [MATH.md §13](MATH.md) derives the 18-event maximum by dynamic program.

### 3.2 The SWARM adapter

```ts
export const swarmColonyV1 = defineStagedSurvival({
  apiVersion: STAGED_SURVIVAL_API,
  adapterVersion: '1.3.0',
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
  thinning: {
    allowPartial: true,
    clientQuantum: 'any',
    commitsPerStage: 1,
    removal: 'highest-slots',
  },
  entropy: { clientEntropyBytes: 32, required: true, playerEditable: true },
  sideBets: [
    {
      id: 'FIRST_LIGHT',
      predicate: { kind: 'UNITS_AT_STAGE_AT_LEAST', stage: 1, units: 4 },
      maxWinMultiple: 5n,      // exact price 19/4 = 4.75x
      minStakeUnits: 100_000n,
      maxStakeUnits: 100_000_000n,
    },
    {
      id: 'DARK_VENT',
      predicate: { kind: 'EXTINCT_BY_STAGE', stage: 3 },
      maxWinMultiple: 3n,      // exact price 2.689446...x
      minStakeUnits: 100_000n,
      maxStakeUnits: 100_000_000n,
    },
    {
      id: 'SWARM',
      predicate: { kind: 'PEAK_UNITS_AT_LEAST', units: 10 },
      maxWinMultiple: 249n,    // exact price 248.798505...x
      minStakeUnits: 100_000n,
      maxStakeUnits: 100_000_000n,
    },
  ],
  pricing: { targetRtp: rational(19n, 20n), rounding: 'floor' },
  risk: {
    colonyMaxWinMultiple: 906n,
    minStakeUnits: 100_000n,
    maxStakeUnits: 1_000_000_000n,
    maxTicketExposureUnits: 1_000_000_000_000n,
  },
  lifecycle: { abandonedRoundTimeoutHours: 72 },
});
```

---

## 4. Derivation and the two-phase commitment

SWARM's transcript is a function of the player's decisions, so it does not exist
when the round opens. One commitment cannot cover both "the seed predates every
decision" and "this settlement is the settlement of that decision log": the
first must be published before the round, the second cannot be computed until
after it. The scheme is therefore two-phase, and both phases are mandatory.

| Phase | Published | Binds | Attack it closes |
| --- | --- | --- | --- |
| 1 — seed pre-commitment | before the round opens | the server seed, adapter identity and fingerprint, round id, grid shape | the operator choosing a seed after seeing a decision |
| live — action chain | with every frame, during the round | every frame the client has observed, folded in order | the operator rewriting a log the player already witnessed |
| 2 — settlement body | at settlement, with the revealed seed | the seed, the client entropy, every resolved population, **the ordered action log**, the terminal, the wild line, every side-bet resolution and the whole per-line credit ledger | one published commitment being settled two mutually inconsistent ways |

### 4.1 The draw grid

A round's randomness is a grid of `stages x (settleAtOrAbove - 1)` draws — for
SWARM, `18 x 15 = 270` — indexed by stage and slot:

```ts
export function drawIndex(game: StagedSurvivalDefinition, stage: number, slot: number): number;
// (stage - 1) * (thresholds.settleAtOrAbove - 1) + (slot - 1)

export interface StageContext {
  readonly gameId: string;
  readonly roundId: string;
  /** 32 bytes of player entropy, lowercase hex. Chosen after phase 1. */
  readonly clientEntropy: string;
  readonly proofVersion: 'reveal-engine/stage-draw-v2';
}

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
domain-separated HMAC-SHA256, keyed by the server seed, over the canonical field
vector

```
['sampler', samplerDomain, adapterId, adapterVersion, adapterFingerprint,
 roundId, clientEntropy, label, counter, nonce, modulus]
```

retried until the 256-bit value falls below `2^256 - (2^256 mod modulus)`. No
modulo bias, no floats, no wall-clock input. **The client entropy is a payload
field, not a key**, so the server seed remains the only secret and the player's
contribution is public from the moment the round opens.

At stage `t` with `n` units entering, slots `1 ... n` are consumed. Harvest
removes the highest slots and recompacts, so the number of draws a stage
consumes is the population, and the population alone.

**The wild line** is the same grid replayed with an empty action log, so it
always occupies slots `1 ... W(t)` with `W(t) >= N(t)`, and the player's units
sit in a *prefix* of the wild line's slots. §5.2 turns that containment into the
exact rule for when wild-line state may be shown.

### 4.2 Phase 1 — the seed pre-commitment

```
seedCommitment = sha256(encodeFields([
  'Axiom Games SWARM seed pre-commitment',
  'reveal-engine/stage-seed-commit-v1',
  seedBytes,                       // 32 bytes, unrevealed
  game.id,
  game.adapterVersion,
  stagedSurvivalFingerprint(game),
  roundId,
  game.ladder.stages,
  game.thresholds.settleAtOrAbove - 1,
  game.cohort.drawModulus,
]))
```

It binds the seed and the frozen economics and discloses nothing — it is a hash
of an unrevealed 32-byte seed. It deliberately does **not** bind the client
entropy, because the entropy does not exist yet, and that ordering is the entire
point: the seed is sealed first, the player contributes second, and neither side
can see the other's choice before making its own.

It must be durably published before the round opens and before any
seed-dependent information reaches the client. The seed is revealed only at
settlement — including settlement by reconciliation (§5.5).

`adapterFingerprint()` in `tools/simulate.mjs` is the reference implementation
of `stagedSurvivalFingerprint` for this adapter, binding exactly the field list
in §2. For `swarm-colony-v1 @ 1.3.0` it is

```
3fc7b96ea3546f14169032d070aa48f103de7db048cc8a306cf99227d33d36cf
```

and `tests/derivation.test.mjs` freezes it, so any change to the offspring
bands, the ladder, the thresholds, the target RTP, the commitment scheme, the
transcript rules or any line's cap changes the fingerprint and fails the build
until the adapter version is bumped with it. (The `1.0.0` fingerprint was
`0ce06d9c…`, `1.1.0` was `598cf417…` and `1.2.0` was `e0bd79df…`; they are listed
here only so that a transcript produced under any of them can be identified,
never replayed as current. The fingerprint is a field of the sampler payload, so
a change to it changes every draw: transcripts do not cross versions.)

### 4.3 Live — the action chain

Between the two phases the round is running, the seed is still sealed, and the
player is making decisions. The action chain is the witness they accumulate
while that is true.

```
chain(0) = seedCommitment
chain(i) = sha256(encodeFields([
  'reveal-engine/stage-action-chain-v1',
  chain(i - 1),
  i - 1,                 // event index
  event.kind,            // 'RESOLVE' | 'CONTINUE' | 'HARVEST' | 'BANK'
  event.generation,
  event.value,           // resolved population, or units harvested
]))
```

The event sequence is exactly what the client observed, in order: one `RESOLVE`
per generation that resolved, one action event per decision the player made.
`chain(i)` is returned on the `StageFrame` of command `i`, so a client that
retains the values it was handed holds a hash chain over its own decision log
that predates the seed reveal. An operator that later re-writes the log cannot
produce a chain the player's retained values are a prefix of.

### 4.4 Phase 2 — the settlement body commitment

Published at settlement, together with the revealed seed:

```
bodyCommitment = sha256(encodeFields([
  'Axiom Games SWARM settlement body',
  'reveal-engine/stage-body-commit-v2',
  seedCommitment,                          // ties phase 2 to phase 1
  seedBytes,                               // now revealed
  clientEntropyBytes,
  game.id, game.adapterVersion, stagedSurvivalFingerprint(game), roundId,
  colonyStakeUnits,
  sideBetCount, ...(id, stakeUnits or 0) per declared side bet, in order,
  resolvedGenerationCount, ...(stage, units) per resolved generation, in order,
  actionCount, ...(stage, kind, units) per logged action, in order,
                                           // at most one action per stage (§5.3)
  replayedTerminal,                        // what the grid produced
  settlementMode,                          // 'PLAYER' | 'RECONCILED'
  terminalReason,                          // what the round publishes
  terminalStage, terminalUnits,
  wildStageCount, ...wild units per stage, wildPeak, wildTerminal,
  sideBetResultCount, ...(id, 'WON' | 'LOST' | 'NOT_SELECTED') in order,
  receiptCount, ...(sequence, kind, line, direction, stage, amountUnits,
                    unitsHarvested, resolved, theoretical) per receipt, in order,
  chainTerminal,                           // the last action-chain value
]))
```

`v2` added the settlement mode, and the field earns its place: a round the
abandonment rule settled and a round the player settled can have the *same* grid,
the same action log and the same ledger, so without it the two are one digest and
the `RECONCILED` terminal is an operator annotation sitting outside the proof.
With it they are two, and the mode cannot be changed after publication. What it
does not prove is that the clock actually ran out — a wall-clock claim is not in
the transcript, and §8 lists that residual rather than implying it away.

**This is the phase round 2 did not have, and its absence was the finding.** The
previous text committed only the seed and the grid shape, and defended the
omission with "the action log is bound separately by the receipt ledger and the
frame fence". Nothing supported that: the verifier took the action log as an
input and reconciled it against the receipt ledger, which is the same
operator-supplied artifact, and no receipt was signed. One published commitment
could be settled under many mutually inconsistent logs and every artifact would
still verify. With the body commitment, two settlements of one seed
pre-commitment produce two different, publicly distinguishable digests.

`bodyCommitment()` and `actionChain()` in `tools/simulate.mjs` are the reference
implementations, and `npm run simulate` prints the attack being rejected: the
same seed settled under two different logs, and the verifier refusing the
mismatch.

### 4.5 What client entropy is for

Deterministic derivation stops an operator from changing a draw after publishing
a commitment. It does **not** stop an operator from generating many seeds,
looking at the grid each one produces, and publishing the convenient one. Reveal
Engine's own threat model names this and marks it *not closed there*, and
SWARM's exposure is structurally worse than a generic round: the whole 270-draw
grid is a pure function of one seed, and because the player's colony occupies a
prefix of the wild line's slots, a single grind target — draws `(1,1)`, `(1,2)`
and `(1,3)` all in the DIE band, `P = (2/5)^3 = 0.064`, about 16 attempts —
simultaneously zeroes the COLONY line, loses FIRST LIGHT, loses SWARM and wins
only DARK VENT.

Client entropy is the control. The publication order is fixed and it is the
whole mechanism:

1. the operator publishes `seedCommitment` and binds it to `roundId`;
2. the client generates 32 bytes (the player may replace them) and sends them
   with `open()`;
3. every draw is a function of both.

An operator grinding seeds before step 1 is grinding against an entropy value it
cannot predict, so the grind buys nothing. An operator that wanted to grind
*after* step 2 would have to publish a second commitment for a round that
already has one, which is exactly what a durably published, round-bound
commitment prevents.

Residual, stated rather than implied: this depends on the publication ordering
above actually being enforced by the operator's storage, on the entropy being
generated by the client rather than echoed from the server, and on the player
(or a third party) retaining the published commitment. §8 lists it with the rest
of the boundary.

### 4.6 Verification algorithm

Given `{ seedCommitment, bodyCommitment, actionChain, revealedSeed,
clientEntropy, roundId, adapter, stakeUnits, sideBetStakes, actionLog,
populations, terminal, settlementMode, sideBetResults, receipts }` a verifier
must, in this order:

1. Recompute `stagedSurvivalFingerprint(adapter)` and compare with the recorded
   fingerprint. Mismatch -> `ADAPTER_MISMATCH`.
2. Recompute the **seed pre-commitment** from the revealed seed and the round id
   and compare it, in constant time, against the one published before the round.
   Mismatch -> `COMMITMENT_MISMATCH`.
3. Reject a `settlementMode` that is neither `PLAYER` nor `RECONCILED` as
   `INVALID_TRANSCRIPT`, then replay the grid **using the submitted action log
   and nothing else**: `units := seedUnits`; for each stage in order, consume
   draws for slots `1 ... units`, map each draw through the cohort bands, sum
   children, apply the terminal rules (`0` -> EXTINCT,
   `>= settleAtOrAbove` -> THRESHOLD, `stage === stages` -> FINAL), then apply
   **the one logged action for that stage**. A log that is out of order, short,
   longer than `stages - 1` entries, mislabelled, that harvests more units than
   the stage holds, or that **carries two entries for one stage** is
   `DERIVATION_FAILED`; resolved populations or a terminal that do not match the
   submitted ones are `TRANSCRIPT_MISMATCH`. The published terminal is a function
   of the replayed terminal and the settlement mode: a forced bank publishes
   `RECONCILED`, everything else publishes what the grid produced (§5.5).
4. Recompute every COLONY credit as `floor(stakeUnits * cohortValue(stage, k))`
   with the cumulative cap on the COLONY stake, and compare against the receipt
   ledger lines whose `line` is `COLONY`, for amount and order. Mismatch ->
   `TRANSCRIPT_MISMATCH`.
5. Recompute the **wild line** — the same replay with an empty action log —
   evaluate every selected side bet's predicate against it, recompute
   `floor(sideBetStakeUnits * sideBetMultiplier(id))` with that line's own cap,
   and compare against the receipt ledger lines whose `line` is that side bet.
   Mismatch -> `TRANSCRIPT_MISMATCH`.
6. Assert no receipt carries `capped: true`. A cap can only bind if the adapter
   is misconfigured, so a capped receipt is a build failure, not a payout.
7. Re-derive the **action chain** over the replayed event sequence and compare it
   in constant time. Mismatch -> `COMMITMENT_MISMATCH`.
8. Re-seal the **settlement body commitment** over the replayed round — the
   revealed seed, the client entropy, the resolved populations, the action log,
   the terminal, the wild line, the side-bet resolutions, the recomputed ledger
   and the chain terminal — and compare it in constant time against the published
   body. Mismatch -> `COMMITMENT_MISMATCH`.

**Step 8 is what makes step 3's input trustworthy.** Without it the action log is
an assertion; with it, the log is the only free variable in a digest that was
published at settlement, so a log that was not the log produces a body that is
not the body. Compare with `constantTimeHexEqual`, never `!==`.

Steps 3–8 are exactly what `verifyRound()` in `tools/simulate.mjs` does, which is
why that file is part of the specification rather than a toy. It takes the action
log as an untrusted input and returns a public code, never a stack trace.

---

## 5. Lifecycle

```
  IDLE
    │  open()                     stake debited, client entropy bound, stage 0
    ▼
  STAGED ◄──────────────────┐
    │                       │  advance()            a stage resolved, still non-terminal
    │                       │  harvest(k < units)   same stage, new revision, decision open
    ├───────────────────────┘
    │
    │  advance() resolving to EXTINCT / THRESHOLD / FINAL
    │  harvest(k === units)  ->  terminal BANKED
    ▼
  AWAITING_SETTLEMENT
    │  settle(revealedSeed)  or  reconcile()
    ▼
  SETTLED
```

**States.** `IDLE` (no stake), `STAGED` (the round is live and awaiting a player
command), `AWAITING_SETTLEMENT` (the round has a terminal and owes no further
decision; the seed is still sealed), `SETTLED` (terminal, seed revealed, body
commitment published).

**Stage 0 is a `STAGED` state with exactly one legal command.** Immediately after
`open()` the book holds `stage = 0` and `units = seedUnits`, and generation 1 is
mandatory ([MATH.md §5](MATH.md) — it is where the entire house edge is taken).
So at `stage === 0`, `advance()` is legal and `harvest()` fails
`INVALID_REQUEST`: there is nothing to bank yet, and a client that offered a
control there would be offering a decision the game does not have. Stage 0 has no
ladder value (§3.1), so its frame carries a null `unitValue` and a null
`colonyValue`, and §5.5 says what happens if a round is abandoned there.

**Terminal reasons.** `EXTINCT`, `THRESHOLD`, `FINAL`, `BANKED`, `RECONCILED`.
`THRESHOLD` is the wire name for the terminal [MATH.md](MATH.md) calls FULL
BLOOM when it is describing the event; they are one terminal with two names, and
the wire name is the one a transcript carries.

```ts
/** One side-bet line on the ticket, with its own stake. */
export interface SideBetSelection {
  readonly id: string;              // must match a SideBetDefinition
  readonly stakeUnits: bigint;      // that line's own stake, in minor units
}

export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;   // 0
  /** The COLONY line's stake. Mandatory: there is no side-bet-only ticket. */
  readonly stakeUnits: bigint;
  /** Zero to three distinct side bets, each carrying its own stake. */
  readonly sideBets: readonly SideBetSelection[];
  /**
   * 32 bytes of player entropy, lowercase hex, chosen after the seed
   * pre-commitment was published. Missing, short, long or non-hex is
   * INVALID_REQUEST; the round does not open.
   */
  readonly clientEntropy: string;
}

export interface AdvanceRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
}

export interface HarvestRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  /**
   * 0 < units <= current population. `units === population` is a full BANK and
   * has its own terminal semantics (§5.3). Every legal k is accepted; the
   * client exposes every legal k (`thinning.clientQuantum === 'any'`).
   */
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
  /** ladderValue(game, stage), and `null` at stage 0, which has no ladder value. */
  readonly unitValue: Rational | null;
  readonly colonyValue: Rational | null;    // unitValue * units, or null at stage 0
  /**
   * Whether this stage still accepts a harvest commitment. `false` at stage 0
   * (nothing has resolved) and after any harvest at this stage, because a stage
   * commits once (§5.3). A client renders the decision controls from this field
   * rather than inferring them, so it can never offer a command that would be
   * refused.
   */
  readonly decisionOpen: boolean;
  readonly terminal: 'EXTINCT' | 'THRESHOLD' | 'FINAL' | 'BANKED' | 'RECONCILED' | null;
  readonly state: 'STAGED' | 'AWAITING_SETTLEMENT' | 'SETTLED';
  /** The live action-chain value after this frame's event (§4.3). */
  readonly actionChain: string;
  /**
   * Wild-line population at stage `stage` — the stage the player has just
   * resolved — and the wild line's peak through that stage. Never a later
   * stage: §5.2 is the exact rule and the reason it is exact.
   */
  readonly wildUnits: number;
  readonly wildPeakUnits: number;
  /**
   * Deliberately absent: any side-bet resolution, any wild-line value for a
   * stage the player has not resolved, and any credit amount not already on a
   * receipt.
   */
}

export type BetLine = 'COLONY' | string;    // 'COLONY' or a SideBetDefinition id

export interface Receipt {
  readonly schema: 'receipt-v2';
  readonly sequence: number;                // ledger revision, independent of frame revision
  readonly kind: 'OPEN' | 'HARVEST' | 'SETTLE' | 'SIDE_BET';
  /** Which bet the movement belongs to. Every receipt names exactly one line. */
  readonly line: BetLine;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly stage: number;
  /** Non-negative. A DEBIT is a stake, a CREDIT is a payout. */
  readonly amountUnits: bigint;
  readonly unitsHarvested: number;          // COLONY harvests only, else 0
  readonly resolved: 'WON' | 'LOST' | null; // side-bet lines only
  readonly theoretical: Rational | null;    // exact, unrounded; null for a DEBIT
  readonly capped: boolean;                 // always false; see §4.6 step 6
}

/** Every mutating call returns the receipt(s) it produced *and* the new frame. */
export interface CommandResult<T> {
  readonly receipts: readonly Receipt[];
  readonly frame: StageFrame;
  readonly value: T;
}

export class StageBook {
  constructor(
    game: StagedSurvivalDefinition,
    context: StageContext,
    seedCommitment: string,
  );
  readonly frame: StageFrame;
  open(request: OpenRequest): Promise<CommandResult<null>>;        // one DEBIT per line
  advance(request: AdvanceRequest): Promise<CommandResult<null>>;
  harvest(request: HarvestRequest): Promise<CommandResult<null>>;  // one COLONY CREDIT
  settle(request: SettleRequest): Promise<CommandResult<SettlementProof>>;
  reconcile(request: ReconcileRequest): Promise<CommandResult<SettlementProof>>;
}

/** What settlement publishes. Exactly the input set §4.6 verifies. */
export interface SettlementProof {
  readonly seedCommitment: string;
  readonly bodyCommitment: string;
  readonly actionChain: string;
  readonly revealedSeed: string;
  readonly clientEntropy: string;
  /** One entry per resolved non-terminal stage, and never two for one stage. */
  readonly actionLog: readonly { stage: number; kind: string; units: number }[];
  readonly populations: readonly number[];
  readonly terminal: string;
  /** Who settled it. Sealed in the body, so it cannot be relabelled later. */
  readonly settlementMode: 'PLAYER' | 'RECONCILED';
  readonly sideBetResults: readonly { id: string; resolved: string }[];
}
```

### 5.1 Rules inherited from `RoundBook` discipline

- **Frame fence.** Every mutating call carries `expectedFrameRevision`; a stale
  value fails `STALE_FRAME` and mutates nothing.
- **Idempotency.** Each successful command is bound to its key by a canonical
  fingerprint of the command payload. An exact retry replays the receipt *and the
  frame, including its action-chain value*; a changed payload under the same key
  fails `IDEMPOTENCY_CONFLICT`.
- **Separate revisions.** Frame revision (price/state) and ledger sequence
  (money) advance independently, so a duplicated advance can never look like a
  money movement and vice versa.
- **Compute before mutate.** Validate and compute the receipt first, mutate
  state second, so a thrown error cannot leave a half-settled round.
- **Settlement is proof-bound.** `settle()` accepts only a seed whose
  pre-commitment matches, re-derives the entire round from the logged actions
  before crediting, and publishes the body commitment atomically with the last
  receipt.
- **Advance cannot be initiated by the server.** There is no timer, no
  auto-advance, no countdown and no in-round plan the server executes on the
  player's behalf; the stage advances only when the player calls `advance()` or
  `harvest()`. That is what makes the game latency-insensitive by construction,
  and it is the reason a slow connection cannot cost a payout. The only
  server-initiated transition in the module is abandonment reconciliation, §5.5.

### 5.2 Wild-line disclosure rule

Round 2 forbade every wild-line value from reaching a live client, and justified
the ban with the leak argument in [MATH.md §7.3](MATH.md). The argument does not
support a ban that wide, and the cost of the wider rule was real: a player
holding a 248.798x SWARM bet got no indicator of any kind for the whole round.
The correct rule is one generation narrower and is stated exactly:

> A response may carry wild-line state for **stage `t` and every earlier stage**
> once the player's own stage `t` has resolved. It may never carry, or vary its
> timing with, any wild-line state for a stage the player has not resolved.

**Why that is exactly safe.** The wild line's population at stage `t` is a sum
over slots `1 ... W(t-1)` of **row `t` only**. The player's own future consumes
rows `t+1 ... 18`, which are disjoint draws, domain-separated by counter in the
sampler payload; treating HMAC-SHA256 as a PRF, a function of row `t` gives no
advantage on any later row. So conditioning on `W(t)` does not change the
distribution of the player's future at all, and the invariance theorem's
"adapted to the revealed history" hypothesis still holds
([MATH.md §7.3](MATH.md) carries the derivation).

**Why one generation further is not safe.** `W(t+1)` is a sum over slots
`1 ... W(t)` of row `t+1`, and the player's own next population is a partial sum
of exactly those draws. A wild line that goes to zero at `t+1` proves the
player's colony is extinct at `t+1`, which makes `BANK` a strictly winning move.
That is the leak, and it is the only leak.

Binding consequences on the protocol:

- `open()` returns one `DEBIT` receipt per line and nothing else. It must not
  return, log to a client-readable channel, or vary its timing with, any
  seed-dependent value.
- `advance()` returns a frame whose `wildUnits` and `wildPeakUnits` are for the
  stage it just resolved. `harvest()` does not advance the stage, so it returns
  the same two values it returned for the current stage — a harvest must never
  reveal anything new about the grid.
- Responses are constant-shape and constant-work with respect to the wild line:
  the whole grid is derived at `open()`, so no branch of the response path can be
  timed to learn a draw.
- Side bets are **resolved and credited only during `settle()` or
  `reconcile()`**, in the declaration order of `game.sideBets`. A frame never
  carries a resolution, only the wild population it is already safe to show.
  `SWARM` is the one bet whose win condition can be *observed* early — the peak
  is monotone — and the client may say so; it may not credit it.
- A player who banks at stage 2 with a live SWARM bet has seen the wild line
  through stage 2 and no further. The rest of it animates after their own round
  is over, from the revealed seed, in the settlement sheet
  ([DESIGN.md §5](DESIGN.md), screen S8a).

### 5.3 Terminals, and what a full BANK does

The full bank is the most common non-extinct terminal in the game — it is the
whole of `BANK_FIRST`, the lowest-friction policy — so its semantics are spelled
out rather than implied.

| Trigger | Terminal | State after the call | Receipts from that call |
| --- | --- | --- | --- |
| `harvest({ units: n })` with `n === frame.units` | `BANKED` | `AWAITING_SETTLEMENT` | one `HARVEST` `CREDIT` on `COLONY` for the full colony |
| `harvest({ units: k })` with `0 < k < frame.units` | `null` | `STAGED`, same stage, revision + 1, **`decisionOpen: false`** | one `HARVEST` `CREDIT` on `COLONY` for `k` units |
| `harvest()` on a stage whose decision is closed | — | unchanged | none; fails `INVALID_REQUEST` |
| `advance()` resolving to `0` units | `EXTINCT` | `AWAITING_SETTLEMENT` | none |
| `advance()` resolving to `>= 16` units | `THRESHOLD` | `AWAITING_SETTLEMENT` | none |
| `advance()` resolving stage 18 | `FINAL` | `AWAITING_SETTLEMENT` | none |

**One harvest commitment per stage.** The decision at a stage is a single choice
of `k` in `[0, units]` — `k = 0` is CONTINUE, `k = units` is BANK, anything
between is a partial harvest — and committing it closes that stage's decision:
`decisionOpen` goes false, and the only mutating command left at that stage is
`advance()`. Round 3 specified a partial harvest as leaving "the decision still
open", which had three consequences it did not intend:

- a player who tapped HARVEST twice in one stage produced an action log with two
  entries for one stage, and the published verifier replays one action per stage,
  so an honest round failed `DERIVATION_FAILED`;
- [MATH.md §1.1](MATH.md)'s model, which the invariance proof is written against,
  consults the player once per generation;
- [MATH.md §13](MATH.md)'s floor-rounding bound of 18 credit events per round was
  false — the true maximum under repeated harvests is 117.

**It costs the player nothing.** Two harvests at one stage credit the same
organisms at the same ladder value as one harvest of their sum, and
`floor(x) + floor(y) <= floor(x + y)`, so splitting is never worth more and is
usually worth one minor unit less. The set of reachable round outcomes is
unchanged; only the number of floor events is. The affordance a client must
expose is unchanged too: the stepper reaches every `k`, so every position on the
continuum from CONTINUE to BANK is still one tap away — it is simply one tap.

The client consequence is in [DESIGN.md §4.3 and §5](DESIGN.md): after a partial
harvest the decision panel collapses to `NEXT`, because a control the protocol
would refuse must not be on screen.

`AWAITING_SETTLEMENT` is not optional and not cosmetic. **`settle()` is required
on every path**, including a full bank, because it is the only call that reveals
the seed, resolves the side bets, and publishes the body commitment — and a round
whose seed is never revealed is a round nobody can verify.

- After `BANKED`, `settle()` credits **nothing further** on the `COLONY` line: it
  emits a `SETTLE` `CREDIT` receipt of `0` units carrying the terminal reason, so
  the ledger has one and only one shape, then one `SIDE_BET` receipt per selected
  side bet.
- After `EXTINCT`, the same: a `SETTLE` receipt of `0` units, then the side bets.
- After `THRESHOLD` or `FINAL`, the `SETTLE` receipt carries
  `floor(stakeUnits * cohortValue(stage, units))`.
- `advance()` and `harvest()` on a book in `AWAITING_SETTLEMENT` fail
  `ROUND_SETTLED` with the terminal attached, so a duplicate tap shows the player
  their terminal rather than an error.
- `settle()` is idempotent on its key like every other command, and the second
  call replays the receipts and the same body commitment.

### 5.4 Cap and exposure rules

- **One cap basis per line.** `payableWithinCap` is applied with *that line's*
  stake as the basis and *that line's* already-credited units subtracted. A
  side-bet credit is never charged against the COLONY ceiling and vice versa.
  Enumeration proves every line's cap sits strictly above what that line can owe
  ([MATH.md §12](MATH.md)), so `capped` is always `false` in practice and a
  `true` is a build failure.
- **Ticket exposure is admitted, never truncated.** `open()` computes
  `ticketExposureUnits` and fails `EXPOSURE_LIMIT` if it reaches
  `risk.maxTicketExposureUnits`, before any money moves. At the declared stake
  bounds the worst ticket is 931,700 credits against a 1,000,000 credit limit,
  so the check cannot refuse a legal ticket today; it exists so that a future
  bounds change fails loudly instead of creating unpriced liability.
- **Stake validation is per line.** The COLONY stake must lie in
  `[risk.minStakeUnits, risk.maxStakeUnits]`; each side-bet stake must lie in
  that side bet's own bounds. Duplicate side-bet ids fail `INVALID_REQUEST`.

### 5.5 Abandoned rounds

"There is no timer" is a statement about play, not a lifecycle policy. Staked
funds cannot sit in suspense indefinitely and a committed seed cannot stay
unrevealed forever, so the module defines exactly one server-initiated
transition:

- **Trigger.** A round that is not yet `SETTLED` and has had no successful player
  command for `lifecycle.abandonedRoundTimeoutHours` (72 h). That is both live
  states, and it has to be both: a round in `STAGED` still owes a decision, and a
  round in `AWAITING_SETTLEMENT` still owes a `settle()` — which is the only call
  that reveals the seed. Round 3 scoped the trigger to `STAGED` alone and then
  described `reconcile()`'s behaviour for an `AWAITING_SETTLEMENT` round that no
  trigger could reach, which left a player who reached a terminal and never came
  back holding a seed nobody could ever publish.
- **The clock.** It starts at the `open()` that debited the stake, and is reset by
  any successful `advance()` or `harvest()`. It never runs while a command is in
  flight. In `AWAITING_SETTLEMENT` it runs from the command that produced the
  terminal.
- **Action, at stage 1 or later.** `reconcile()` performs a **forced BANK of the
  entire colony at the exact current stage value** — `k = units`, no advance, no
  extra draw — settles with terminal reason `RECONCILED`, resolves any side bets
  on the wild line, reveals the seed, publishes the body commitment and posts the
  receipts.
- **Action, at stage 0.** A round can be abandoned before it has resolved
  anything: `open()` debits the stake and leaves the book at stage 0, which is a
  `STAGED` state and therefore in scope. There is no colony value to bank there —
  stage 0 has no ladder value, and [MATH.md §5](MATH.md)'s `c(0) = 19/60` is an
  accounting identity deliberately outside the ladder, so paying it would be
  paying a `0.95x` settlement on a round in which nothing was revealed. Instead,
  **reconciliation performs the round's one legal command and then the forced
  bank**: it resolves the mandatory generation 1 and banks whatever survives at
  stage 1. If generation 1 resolves to extinction, the terminal is `EXTINCT` and
  the settlement credits nothing, exactly as it would for a player who was
  watching.
- **Why performing the advance is not taking a decision away.** Everywhere else,
  a forced advance would expose an absent player to extinction *instead of* an
  action they might have preferred. At stage 0 there is no such preference to
  violate: `advance()` is the only legal command, `harvest()` is refused there by
  §5, and generation 1 is mandatory for every round ever played. The server is
  performing the player's only move, not choosing between their moves. The
  resulting transcript is identical to the one a returning player who tapped once
  and banked would have produced — same log, same populations, same money — and
  only the settlement mode, and therefore the terminal reason, distinguishes
  them.
- **Why not a void.** A void would return the stake, which is `1.00x` on a round
  worth `19/20`, so it would pay an absent player more than a present one and
  make "walk away before generation 1" the only action in the game that beats
  `19/20`. The invariance theorem would still be true of every *decision*, and
  the game's central claim — every choice returns the same — would still be false
  in the way that matters. Reconciliation is EV-neutral by construction instead:
  every action ties ([MATH.md §6](MATH.md)), so a forced bank neither takes value
  from an absent player nor gives them any.
- **A round already at a terminal.** If the round is in `AWAITING_SETTLEMENT`
  because the last stage resolved to `EXTINCT`, `THRESHOLD` or `FINAL` and the
  player simply never returned to see it, there is no decision left to force.
  `reconcile()` settles at the terminal that actually occurred, with that
  terminal's reason and that terminal's payout, and the ledger is
  indistinguishable from the one a returning player would have produced.
  `RECONCILED` is reserved for rounds that still owed a decision; the settlement
  mode records that the clock, not the player, closed the round in either case.
- **Proof consequence.** Reconciliation is a settlement, so it reveals the seed
  and publishes a body commitment whose action log ends with the forced bank and
  whose sealed `settlementMode` says the clock closed it (§4.4). Seed custody
  therefore has a bounded horizon: no seed outlives its round by more than the
  abandonment timeout plus the reveal window. **There is now no state in which a
  committed seed can never be published** — the trigger covers `STAGED` and
  `AWAITING_SETTLEMENT`, and stage 0 is inside `STAGED` with a defined
  settlement, which are the two holes that sentence had in round 3.
- **Reference implementation.** `reconcileTicket()` in `tools/simulate.mjs`
  performs exactly this, including the stage-0 case, and `npm run simulate`
  prints an abandoned-at-stage-0 round settling and verifying. The one thing it
  cannot model is the clock; §8 says so.
- **Not a latency-sensitive decision.** 72 hours is four orders of magnitude
  above any human or network decision latency. Nothing about it makes a money
  decision depend on connection speed, which is the property
  [DESIGN.md §9.5](DESIGN.md) protects.
- **Mechanics.** `reconcile()` carries a reserved idempotency key derived from
  the round id, is refused with `TOO_EARLY` if the round is not past the timeout,
  and produces a receipt ledger indistinguishable in structure from a
  player-initiated bank. It takes the round's current frame revision from the
  book rather than from a request, so it cannot race a player command: whichever
  lands first wins the fence, and a player command that arrives after
  reconciliation fails `ROUND_SETTLED` with the settled receipts attached, so a
  returning player is shown what they were paid rather than an error.

---

## 6. Conformance requirements

A `staged-survival` conformance suite must mechanically check, for every bundled
adapter:

1. Draw bands tile `[0, drawModulus)` exactly, in order, with positive weights.
2. `maxUnits === maxChildren * (settleAtOrAbove - 1)`.
3. `assertLadderIsFair` passes: `step * mean === 1` and
   `base * seedUnits * mean === targetRtp`, exactly.
4. Derivation is deterministic: deriving the same grid twice yields identical
   draws; deriving with a different `roundId`, `gameId`, `clientEntropy` or
   fingerprint yields a different grid.
5. The sampler is unbiased: for a small modulus, the rejection bound
   `2^256 - (2^256 mod modulus)` is respected (assert the bound, do not
   statistically test it).
6. Exhaustive value check: for every `(stage, units)` in the state space, the
   continuation value equals `cohortValue(stage, units)` exactly — the same
   backward induction `proveStrategyInvariance()` performs in this repository.
7. `assertRiskIsHeadroom` passes: the COLONY cap strictly exceeds the exact
   maximum cumulative COLONY credit (dynamic program), every side bet's cap
   strictly exceeds its exact multiplier, and the worst admissible ticket sits
   strictly below the exposure limit. No cap may be reachable.
8. Every side bet is priced at exactly the theoretical `targetRtp` before its
   payable credit is floored:
   `sideBetMultiplier(id) * sideBetProbability(id) === targetRtp`.
9. **Two-phase commitment.** `assertCommitmentIsTwoPhase` passes; a definition
   missing either phase or the entropy policy fails to build. The seed
   pre-commitment re-derives from the revealed seed. The body commitment
   re-derives from the replayed round.
10. **The body binds the log.** Settling one seed pre-commitment under two
    different action logs produces two different body commitments, and a verifier
    handed one body with the other log fails `COMMITMENT_MISMATCH` or
    `TRANSCRIPT_MISMATCH`. This is the check that would have caught the round-2
    scheme, and it is not optional.
11. **The chain binds the frames.** Every `chain(i)` returned mid-round is a
    prefix of the terminal chain value bound into the body.
12. **Client entropy is live.** Two rounds with the same seed and round id but
    different client entropy produce different grids, and a round cannot open
    without entropy of exactly the declared width.
13. **Wild-line disclosure.** No `advance()` or `harvest()` response, and no
    `StageFrame`, exposes a wild-line value for a stage the player has not
    resolved, or any side-bet resolution; a replay in which side bets resolve
    before the COLONY terminal fails.
14. **Harvest quantum.** Every `k` in `[0, units]` is accepted, produces the
    exact credit `floor(stakeUnits * cohortValue(stage, k))`, and a full bank
    reaches `AWAITING_SETTLEMENT` with terminal `BANKED` and still requires
    `settle()`.
15. **One commitment per stage.** A second `harvest()` at a stage whose decision
    is closed fails `INVALID_REQUEST` and mutates nothing; the action log carries
    at most one entry per stage and at most `stages - 1` entries in total; a
    transcript with two entries for one stage fails `DERIVATION_FAILED`. The
    maximum number of COLONY credit events in a round is `stages`, and it is
    computed from the adapter rather than asserted ([MATH.md §13](MATH.md)).
16. `reconcile()` credits exactly `cohortValue(stage, units)` on the COLONY line,
    is idempotent, and is refused before the timeout.
17. **Abandonment covers every unsettled state, including stage 0.** A round
    abandoned at stage 0 reconciles to the transcript a player who advanced once
    and banked would have produced, with terminal `RECONCILED` (or `EXTINCT`);
    a round abandoned in `AWAITING_SETTLEMENT` settles at its own terminal; no
    reachable state leaves a committed seed unpublishable. Settling one round in
    both modes produces two different body commitments, and a verifier handed a
    relabelled mode fails.

Checks 6, 7 and 8 are what make this module different from a generic ride
ledger. Checks 9 to 12 are what make it a *choice-timed* module rather than a
choice-timed module's shape. Checks 15 and 17 are the round-4 findings: a command
surface that accepted a transcript its own verifier refused, and a lifecycle
state with no defined settlement. All of them are cheap enough to run in CI.

---

## 7. What this module needs that Reveal Engine 0.2 does not have

| Needed | Present in 0.2 | Note |
| --- | --- | --- |
| Exact `Rational`, `payable`, `payableWithinCap` | Yes | Reuse verbatim |
| `encodeFields`, `uniformBigInt`, error codes, limits | Yes | Reuse verbatim |
| Constant-time digest comparison | Yes | Reuse verbatim |
| Two-phase commitment for a choice-timed round | Yes, as a contract | The engine mandates it; SWARM is the first adapter that has to satisfy it |
| Frame fence, idempotency, receipts | Yes, in `RoundBook` | Reuse the discipline; SWARM implements no snapshot/restore surface |
| Client entropy in the sampler payload | **No** | New `EntropyPolicy` and a new sampler domain |
| Live action chain returned on every frame | **No** | New; the pre-reveal witness of §4.3 |
| Population-based pricing with no posterior | **No** | New `ladderValue` / `cohortValue` |
| Action-dependent draw consumption | **No** | New grid indexing |
| Multi-credit round with a per-line cumulative cap | Partial | `payableWithinCap` exists; the ride ledger and the line attribution do not |
| Multi-line ticket with per-line cap bases | **No** | New `SideBetDefinition`, `receipt-v2` `line`/`direction` |
| Mechanical fairness identity check | **No** | New `assertLadderIsFair` |
| Mechanical risk-headroom check | **No** | New `assertRiskIsHeadroom` |
| Lagged counterfactual-line disclosure | **No** | New; §5.2 |
| Server-initiated reconciliation with no in-play timer | **No** | New `reconcile()` |
| Staged conformance suite | **No** | New, per §6 |

This free-play implementation is deliberately process-local. It exposes neither
`snapshot()` nor `restore()`, makes no cross-process recovery claim, and does not
present an in-memory object graph as durable persistence.

The engine's own documentation already flags the gap: continuation economics are
declared out of scope of its within-round invariance theorem and its core
"validates continuation configuration but does not implement a production ride
ledger". `staged-survival` is that ledger, specified.

---

## 8. Boundary

**Status against Reveal Engine 0.4.** Since this document was written the engine
has shipped a lifecycle module named `staged-survival`. It is not this one, and
its own documentation says so: it resolves a shrinking subset of a fixed entity
set and "cannot express offspring"
(`reveal-engine/docs/modules/staged-survival.md` §10), which is the whole of
SWARM's cohort. Its §10.1 carries an item-by-item verdict against §6 above, and
the items it marks *not provided* — side bets and per-line cap bases (§6.8, half
of §6.7), the action chain (§6.11), reconciliation and abandonment (§6.16,
§6.17) — are exactly the ones SWARM implements above it. So the branching
population, the ladder, the wild line, the per-line ledger, both commitment
phases, the chain and the verifier live in this repository's `src/server/`,
built on the engine primitives §1 requires reused verbatim rather than on a
module that models a different game. The engine's `staged-survival` is still the
right neighbour to sit beside: the entropy contract, the fairness identity, the
cap-unreachability obligation and the choice-timed two-phase scheme are the same
argument in both, and a future `branching-population` module — which the engine
names as the honest answer — would replace `src/server/`'s derivation without
moving a number in this document.

**And the running surface has to say so, not just this document.** The identity in
§2 — `reveal-engine/staged-survival-v1` — is *this document's*, owned here and
implemented in `src/server/`. It is not the identity of the module Reveal Engine
0.4 ships, which is `staged-survival` @ `1.0.0` under module API
`reveal-engine/module-v1`. The first graybox published the first string in a field
called `moduleApi` and rendered it in a row labelled `MODULE`, directly above the
engine's package name and version, on the panel where a player evaluates
fairness — where one version string beside another reads as a conformance claim.
`/api/config` now publishes both, each with its owner and with the split between
what the engine provides and what it does not, and the help and verify sheets
render them. Provenance is a fairness claim: a repository this careful about what
commit-reveal does not prove has to be equally careful about who wrote the
lifecycle being proved.

This document is a contract, not evidence of an implementation. Until such a
module exists in Reveal Engine and passes §6, SWARM's claims rest on the
reference implementations in this repository: `tools/lib/model.mjs` for pricing
and `tools/simulate.mjs` for derivation, the two-phase commitment, side-bet
resolution, the settlement ledger and the verifier — and on the round service in
`src/server/`, whose every settlement is re-verified by that published verifier
in the test suite.

What the scheme in §4 does **not** close, stated rather than implied:

- **Seed selection before publication.** Client entropy makes grinding useless
  *provided the publication order in §4.5 holds*. Nothing in this document
  enforces that order; it is a property of the operator's storage and release
  process, and it needs auditable seed generation, publication ordering and
  retention to be worth anything. Reveal Engine's threat model marks seed
  grinding "not closed here" and this document inherits that boundary rather
  than quietly dropping it.
- **Client entropy that is not the client's.** If the client echoes a value the
  server suggested, the control is gone and nothing in the transcript shows it.
  A player who wants the property has to set the value themselves, which is why
  `playerEditable` is `true` and why [DESIGN.md §5](DESIGN.md) puts the control
  on screen S1 rather than hiding it.
- **A log the player never witnessed.** The body commitment makes two
  settlements of one round publicly distinguishable, and the action chain gives
  the player pre-reveal evidence of their own log. Neither creates a
  third-party-verifiable log on its own: that needs the player (or an external
  notary) to retain the chain values they were handed. This is the honest scope
  of the phrase "verifiable by re-derivation" here.
- **The clock behind a reconciled settlement.** `settlementMode` is sealed into
  the body (§4.4), so a settlement cannot be relabelled after publication and an
  abandoned round is a different digest from a player-settled one with the same
  log. What no transcript can show is that 72 hours actually elapsed: a
  wall-clock claim is not derivable from a seed. An operator that reconciled a
  round early would produce a perfectly verifiable transcript of a settlement the
  player did not ask for — EV-neutral, because every action ties, but not
  consented to. Closing that needs an authenticated timestamp on the last player
  command, which is an operator storage property this document does not
  specify.
- **Everything outside the round.** Neither file is a production round server,
  neither has been reviewed against a jurisdictional requirement, and neither
  replaces operator wallet integration, authenticated storage, seed custody, or
  any laboratory process.
