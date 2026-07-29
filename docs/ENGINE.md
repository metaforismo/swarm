# SWARM on Reveal Engine — the `staged-survival` module

SWARM does not fit the progressive-information-market core that Reveal Engine
0.2 was built for. This document specifies the lifecycle module it does need,
`staged-survival`, and the exact adapter surface SWARM expects from it.

**Status, stated plainly: this module does not exist in Reveal Engine 0.2.**
Nothing here is implemented in the engine repository yet. This is the contract
SWARM is written against; `tools/simulate.mjs` in this repository is a working
reference implementation of the derivation, the side-bet resolution and the
settlement ledger, and `tools/lib/model.mjs` is a working reference
implementation of the pricing.

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
| Adapter | `swarm-colony-v1` @ `1.1.0` | New `adapterVersion` for any replay-visible change |
| Cohort model | `swarm-cohort/v1` | New value for any change to draw bands or child counts |
| Commitment | `reveal-engine/stage-commit-v1` | New rounds use current; older values verification-only |
| Transcript | `reveal-engine/stage-transcript-v1` | Bounded migration parser, fail closed on unknown |
| Receipt | `receipt-v2` | Immutable money-movement record; v2 added `line` and `direction` |
| Snapshot | `stage-book-v1` | Reject unknown versions |
| Paytable fixture | `swarm/paytable-v2` | Regenerated and re-frozen with any of the above |

**Adapter changelog.** `1.1.0` replaced the single round-level max-win multiple
with **one cap basis per bet line**, gave every side bet its own stake and its
own declared cap, and bound those caps into the adapter fingerprint. That is a
change to what a round can credit, so it is replay-visible and takes a new
adapter version, a new fingerprint and a re-frozen fixture — which is the change
rule above being used rather than described.

The adapter fingerprint binds: module API, adapter id and version, cohort model
version, draw modulus, every outcome band `(id, children, weight)` in order,
seed units, stage count, both thresholds, ladder base and step, target RTP,
rounding mode, the colony cap, and every side-bet line with its own cap in
declaration order. Changing any of them changes the fingerprint, and a
transcript is only verifiable against the fingerprint it was produced under.

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
     * BANK (§5.4). There is still no timer inside a live session: this is four
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

/** value of one unit at `stage`; throws outside [1, ladder.stages]. */
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
```

`assertLadderIsFair` is the reason this module can be trusted with a new game
configuration: an adapter whose ladder does not exactly cancel its cohort drift
cannot be defined at all, so no future title built on this module can ship a
silently policy-dependent RTP. `assertRiskIsHeadroom` is the reason it can be
trusted with money: a cap that could bite would break the invariance theorem
([MATH.md §12](MATH.md)), and the only way to be sure it cannot bite is to prove
it from the model on every build.

### 3.2 The SWARM adapter

```ts
export const swarmColonyV1 = defineStagedSurvival({
  apiVersion: STAGED_SURVIVAL_API,
  adapterVersion: '1.1.0',
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

**The wild line** is the same grid replayed with an empty action log, so it
always occupies slots `1 ... W(t)` with `W(t) >= N(t)`, and the player's units
sit in a *prefix* of the wild line's slots. That containment is why §5.2
forbids revealing wild-line state early: it is not a spoiler, it is a disclosure
of draws the player has not yet consumed ([MATH.md §7.3](MATH.md)).

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
in §2. For `swarm-colony-v1 @ 1.1.0` it is

```
598cf417489aea9710f37026d6814da8f390fde2db532c5e3ce06fa3760150e4
```

and `tests/derivation.test.mjs` freezes it, so any change to the offspring
bands, the ladder, the thresholds, the target RTP or any line's cap changes the
fingerprint and fails the build until the adapter version is bumped with it.
(The `1.0.0` fingerprint was `0ce06d9c…`; it is listed here only so that a
transcript produced under it can be identified, never replayed as current.)

The commitment must be durably published before the round opens and before any
seed-dependent information reaches the client. The seed is revealed only at
settlement — including settlement by reconciliation (§5.4).

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

Steps 3–6 are exactly what `settleTicket()` in `tools/simulate.mjs` does, which
is why that file is part of the specification rather than a toy.

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
`BANKED`, `RECONCILED`.

```ts
export interface StageContext {
  readonly gameId: string;
  readonly roundId: string;
  readonly proofVersion: 'reveal-engine/stage-commit-v1';
}

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
  readonly terminal: 'EXTINCT' | 'THRESHOLD' | 'FINAL' | 'BANKED' | 'RECONCILED' | null;
  /**
   * Deliberately absent: any wild-line or side-bet field. A live frame carries
   * no information about draws the colony has not consumed (§5.2).
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
  readonly capped: boolean;                 // always false; see §4.3 step 6
}

export class StageBook {
  constructor(game: StagedSurvivalDefinition, context: StageContext, commitment: string);
  readonly frame: StageFrame;
  open(request: OpenRequest): Promise<readonly Receipt[]>;   // one DEBIT per line
  advance(request: AdvanceRequest): Promise<StageFrame>;
  harvest(request: HarvestRequest): Promise<Receipt>;
  settle(request: SettleRequest): Promise<readonly Receipt[]>;
  reconcile(request: ReconcileRequest): Promise<readonly Receipt[]>;
  snapshot(): StageBookSnapshot;            // schema 'stage-book-v1'
  static restore(game: StagedSurvivalDefinition, snapshot: unknown): StageBook;
}
```

### 5.1 Rules inherited from `RoundBook` discipline

- **Frame fence.** Every mutating call carries `expectedFrameRevision`; a stale
  value fails `STALE_FRAME` and mutates nothing.
- **Idempotency.** Each successful command is bound to its key by a canonical
  fingerprint of the command payload. An exact retry replays the receipt; a
  changed payload under the same key fails `IDEMPOTENCY_CONFLICT`.
- **Separate revisions.** Frame revision (price/state) and ledger sequence
  (money) advance independently, so a duplicated advance can never look like a
  money movement and vice versa.
- **Compute before mutate.** Validate and compute the receipt first, mutate
  state second, so a thrown error cannot leave a half-settled round.
- **Settlement is proof-bound.** `settle()` accepts only a seed whose
  commitment matches, and re-derives the entire round before crediting.
- **Advance cannot be initiated by the server.** There is no timer, no
  auto-advance and no countdown; the stage advances only when the player calls
  `advance()` or `harvest()`. That is what makes the game latency-insensitive by
  construction, and it is the reason a slow connection cannot cost a payout.

### 5.2 Side-bet reveal rule

Binding on the protocol, not only on the UI:

- `open()` returns one `DEBIT` receipt per line and nothing else. It must not
  return, log to a client-readable channel, or vary its timing with, any
  seed-dependent value.
- `advance()` and `harvest()` responses contain no wild-line and no side-bet
  field. `StageFrame` has no place to put one.
- Side bets are resolved **only during `settle()` or `reconcile()`**, after the
  COLONY line has reached a terminal state, and are credited as `SIDE_BET`
  receipts in the definition order of `game.sideBets`.
- A player who banks at stage 2 with a live SWARM bet sees the wild line
  animated *after* their own round is over, from the revealed seed, in the
  settlement sheet ([DESIGN.md §5](DESIGN.md), screen S8a).

The reason is arithmetic, not taste: the wild line's population at stage `t + 1`
is a sum over slots that contains the player's own next population as a partial
sum, so an early wild-line reveal tells the player something about draws they
have not consumed. A wild line that goes to zero proves the player's colony is
extinct next stage and makes `BANK` a strictly winning move, which is exactly
the assumption the invariance theorem is built on
([MATH.md §6.1, §7.3](MATH.md)).

### 5.3 Cap and exposure rules

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

### 5.4 Abandoned rounds

"There is no timer" is a statement about play, not a lifecycle policy. Staked
funds cannot sit in suspense indefinitely and a committed seed cannot stay
unrevealed forever, so the module defines exactly one server-initiated
transition:

- **Trigger.** A round in `STAGED` with no successful player command for
  `lifecycle.abandonedRoundTimeoutHours` (72 h). The clock is reset by any
  successful `advance()` or `harvest()`, and never runs while a command is
  in flight.
- **Action.** `reconcile()` performs a **forced BANK of the entire colony at the
  exact current stage value** — `k = units`, no advance, no extra draw — settles
  with terminal reason `RECONCILED`, resolves any side bets on the wild line,
  reveals the seed and posts the receipts.
- **A round already at a terminal.** If the last stage resolved to `EXTINCT`,
  `THRESHOLD` or `FINAL` and the player simply never returned to see it, there
  is no decision left to force. `reconcile()` settles at the terminal that
  actually occurred, with that terminal's reason and that terminal's payout, and
  the ledger is indistinguishable from the one a returning player would have
  produced. `RECONCILED` is reserved for rounds that still owed a decision.
- **Why a forced bank and not a void or a forced advance.** Every action at
  every state has identical exact value ([MATH.md §6](MATH.md)), so a forced
  bank is exactly EV-neutral: it neither takes value from an absent player nor
  gives them any. It is the unique action that also removes all remaining risk
  from someone who is not there to manage it. A void would have to return the
  stake and unwind a resolved generation the player has already seen; a forced
  advance would expose an absent player to extinction.
- **Seed consequence.** Reconciliation is a settlement, so the seed is revealed
  and the round becomes verifiable by the normal §4.3 algorithm. Seed custody
  therefore has a bounded horizon: no seed outlives its round by more than the
  abandonment timeout plus the reveal window, and there is no state in which a
  committed seed can never be published.
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
   draws; deriving with a different `roundId`, `gameId` or fingerprint yields a
   different grid.
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
8. Every side bet is priced at exactly `targetRtp`:
   `sideBetMultiplier(id) * sideBetProbability(id) === targetRtp`.
9. No `advance()` or `harvest()` response, and no `StageFrame`, exposes a
   wild-line or side-bet value; a replay in which side bets are resolved before
   the COLONY terminal fails.
10. `reconcile()` credits exactly `cohortValue(stage, units)` on the COLONY line,
    is idempotent, and is refused before the timeout.
11. Snapshot round-trips: restore validates adapter identity, receipt ordering,
    per-line cap accounting, and a deterministic checksum, and rejects any
    unknown schema version.

Checks 6, 7 and 8 are what make this module different from a generic ride
ledger: the fairness of the whole game reduces to two exactly-checkable
identities plus one dynamic program per line, and all of them are cheap enough
to run in CI.

---

## 7. What this module needs that Reveal Engine 0.2 does not have

| Needed | Present in 0.2 | Note |
| --- | --- | --- |
| Exact `Rational`, `payable`, `payableWithinCap` | Yes | Reuse verbatim |
| `encodeFields`, `uniformBigInt`, error codes, limits | Yes | Reuse verbatim |
| Frame fence, idempotency, receipts, snapshots | Yes, in `RoundBook` | Generalize, do not fork |
| Population-based pricing with no posterior | **No** | New `ladderValue` / `cohortValue` |
| Action-dependent draw consumption | **No** | New grid indexing and commitment scheme |
| Multi-credit round with a per-line cumulative cap | Partial | `payableWithinCap` exists; the ride ledger and the line attribution do not |
| Multi-line ticket with per-line cap bases | **No** | New `SideBetDefinition`, `receipt-v2` `line`/`direction` |
| Mechanical fairness identity check | **No** | New `assertLadderIsFair` |
| Mechanical risk-headroom check | **No** | New `assertRiskIsHeadroom` |
| Server-initiated reconciliation with no in-play timer | **No** | New `reconcile()` |
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
`tools/simulate.mjs` for derivation, side-bet resolution and the settlement
ledger. Neither is a production round server, neither has been reviewed against
a jurisdictional requirement, and neither replaces operator wallet integration,
authenticated storage, seed custody, or any laboratory process.
