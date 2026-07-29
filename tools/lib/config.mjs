/**
 * SWARM reference configuration — the single source of truth for every number
 * published in docs/MATH.md, docs/DESIGN.md and README.md.
 *
 * Nothing here is tuneable at runtime. A change to any field is a new
 * `adapterVersion` and a new frozen paytable fixture (see docs/ENGINE.md).
 */

import { rat, multiply, divide, add, power, compare, fail, ONE } from './rational.mjs';

/** Wire identity of this configuration. Bumped whenever any number below changes. */
export const ADAPTER_ID = 'swarm-colony-v1';
/**
 * 1.1.0 replaced the single round-level max-win multiple with one cap basis per
 * bet line and bound the side-bet caps into the adapter fingerprint.
 *
 * 1.2.0 changed the derivation and the proof: player-supplied client entropy now
 * enters every draw, the single-phase commitment became the mandatory two-phase
 * scheme (seed pre-commitment before the first decision, settlement body
 * commitment binding the action log), and the harvest quantum opened from
 * `floor-half` to any legal `k`. All of that is replay-visible, so it takes a
 * new adapter version, a new fingerprint and a re-frozen fixture, exactly as
 * docs/ENGINE.md §2 requires.
 *
 * 1.3.0 closed the protocol against the transcript: a stage now accepts exactly
 * one harvest commitment (`HARVEST_COMMITS_PER_STAGE`), which is what the
 * verifier, the action-log bound and docs/MATH.md §1.1 always assumed and the
 * command surface did not enforce; the settlement body gained the settlement
 * mode, so a reconciled round is distinguishable from a player-settled one
 * inside the commitment rather than only beside it; and stage-0 abandonment got
 * a defined settlement. All three constrain which transcripts are legal, so
 * again: new adapter version, new fingerprint, re-frozen fixture.
 */
export const ADAPTER_VERSION = '1.3.0';
/**
 * v2 added the risk, bloom, feedback, break-even and variance-bound sections.
 * v3 added the presentation contracts (verdict bands, chord ladder, settlement
 * classes, colony layout), the shared-cap binding bound, and the stake-boundary
 * lemma — every number docs/DESIGN.md used to assert by hand.
 */
export const PAYTABLE_SCHEMA = 'swarm/paytable-v3';
/** The Reveal Engine lifecycle module this adapter targets (docs/ENGINE.md). */
export const MODULE_API = 'reveal-engine/staged-survival-v1';
/** Adapter-owned promise: unchanged identity means unchanged draw behaviour. */
export const COHORT_MODEL_VERSION = 'swarm-cohort/v1';

/**
 * Commit-reveal identities. Two phases, because SWARM's transcript depends on
 * player decisions: phase 1 seals the server seed before the round accepts a
 * decision, phase 2 seals the settled body — seed, client entropy, resolved
 * populations, the ordered action log and the per-line credit ledger — at
 * settlement. Reveal Engine's module contract makes the pair mandatory for any
 * choice-timed module; see docs/ENGINE.md §4.
 */
export const SEED_COMMITMENT_VERSION = 'reveal-engine/stage-seed-commit-v1';
/**
 * v2 adds the settlement mode to the sealed body, so "the player settled this"
 * and "the abandonment rule settled this" are two different digests rather than
 * two readings of one. Bumped rather than amended in place, because a body field
 * set is a wire format and an older transcript must stay verifiable as what it
 * was (docs/ENGINE.md §2).
 */
export const BODY_COMMITMENT_VERSION = 'reveal-engine/stage-body-commit-v2';
/** Domain tag of the draw sampler. Bumped with 1.2.0 because client entropy joined the payload. */
export const SAMPLER_DOMAIN = 'reveal-engine/stage-draw-v2';
/** Domain tag of the live action chain the client accumulates during the round. */
export const ACTION_CHAIN_DOMAIN = 'reveal-engine/stage-action-chain-v1';
/** Player-supplied entropy contributed to every draw, in bytes. */
export const CLIENT_ENTROPY_BYTES = 32;
/**
 * The harvest quantum the client exposes. `any` means every legal `k` in
 * `[0, n]` is reachable from the UI, not only `floor(n/2)`: the proof covers
 * every `k` and docs/MATH.md §11 publishes a volatility interval whose maximum
 * is attained by harvesting exactly one organism, so a client that could not
 * express it would be publishing a range it could not sell.
 */
export const HARVEST_QUANTUM = 'any';
/**
 * How many harvest commitments one stage accepts. One: the decision at a stage
 * is a single choice of `k` in `[0, n]` — `k = 0` is CONTINUE, `k = n` is BANK,
 * anything between is a partial harvest — and committing it closes that stage's
 * decision (docs/ENGINE.md §5.3).
 *
 * This costs the player nothing and buys three things. Splitting a harvest is
 * never worth more, because `floor(x) + floor(y) <= floor(x + y)` and the two
 * pieces are credited at the same ladder value, so the shipped rule is weakly
 * better for the player at every state. The action log stays one entry per
 * stage, which is what the verifier, the transcript bound and docs/MATH.md §1.1
 * already assumed. And the floor-rounding bound stays at 18 credit events per
 * round instead of 117 (`maximumCreditEvents()` computes both).
 *
 * It is replay-visible — it decides which action logs are legal — so it is bound
 * into the adapter fingerprint.
 */
export const HARVEST_COMMITS_PER_STAGE = 1;

/**
 * One uniform draw per organism per generation, over a modulus of 20.
 * Draw d in [0,20): d < 8 -> DIE, 8 <= d < 16 -> HOLD, d >= 16 -> SPLIT.
 */
export const DRAW_MODULUS = 20n;

export const OFFSPRING = Object.freeze([
  Object.freeze({ id: 'DIE', children: 0, weight: 8n, lowDraw: 0n, highDraw: 7n }),
  Object.freeze({ id: 'HOLD', children: 1, weight: 8n, lowDraw: 8n, highDraw: 15n }),
  Object.freeze({ id: 'SPLIT', children: 2, weight: 4n, lowDraw: 16n, highDraw: 19n }),
]);

/** Organisms seeded at t = 0. */
export const SEED_COUNT = 3;
/** Hard round length. Generation `MAX_GENERATIONS` force-settles the colony. */
export const MAX_GENERATIONS = 18;
/** FULL BLOOM: a population of at least this many organisms force-settles the round. */
export const BLOOM_THRESHOLD = 16;
/** Largest population the state space can hold: 2 * (BLOOM_THRESHOLD - 1). */
export const MAX_POPULATION = 2 * (BLOOM_THRESHOLD - 1);

/** Target theoretical return to player. Every bet type is priced to exactly this. */
export const TARGET_RTP = rat(19n, 20n);

/**
 * Declared risk ceiling of the COLONY line, as a multiple of *that line's own
 * stake*, applied to the cumulative credit of one round on that line. It is the
 * smallest integer strictly above the exact maximum total the colony can pay
 * (905.776494...x, see `maximumRoundPayout()`), so it is a real contractual
 * ceiling that provably never truncates a payout.
 * `assertRiskPolicy()` in tools/lib/model.mjs re-proves this from the model.
 *
 * **Every bet line has its own cap basis.** There is no round-level cap that
 * sums lines: a side-bet credit is never charged against the colony's ceiling,
 * and vice versa. See docs/MATH.md §11 for why a summing cap would break the
 * invariance theorem, and docs/ENGINE.md §5 for the ledger rule.
 */
export const COLONY_MAX_WIN_MULTIPLE = 906n;

/**
 * Declared risk ceiling of each side-bet line, on that line's own stake. Each is
 * the smallest integer strictly above that bet's exact multiplier, which is the
 * largest amount the line can ever credit (a side bet credits at most once).
 * `assertRiskPolicy()` re-derives each of these from the enumerated prices.
 */
export const SIDE_BET_MAX_WIN_MULTIPLES = Object.freeze({
  FIRST_LIGHT: 5n,
  DARK_VENT: 3n,
  SWARM: 249n,
});

/** Money is integer minor units. 1 credit = 10^6 units, so a floor crumb is 1e-6 credits. */
export const UNITS_PER_CREDIT = 1000000n;
export const MIN_STAKE_UNITS = UNITS_PER_CREDIT / 10n; // 0.10 credits
export const MAX_STAKE_UNITS = 1000n * UNITS_PER_CREDIT; // 1000 credits
/** Side-bet stakes are independent of the colony stake and bounded on their own line. */
export const MIN_SIDE_BET_STAKE_UNITS = UNITS_PER_CREDIT / 10n; // 0.10 credits
export const MAX_SIDE_BET_STAKE_UNITS = 100n * UNITS_PER_CREDIT; // 100 credits

/**
 * Operator admission limit on the total liability of one ticket, in minor units.
 * Checked when the round is opened, never at settlement: a ticket that could
 * exceed it is refused before money moves, so no credit is ever truncated.
 * `assertRiskPolicy()` proves the worst ticket the stake bounds allow sits
 * strictly below it, which is why the check cannot reject a legal ticket today
 * and exists as a fence against a future bounds change.
 */
export const MAX_TICKET_EXPOSURE_UNITS = 1000000n * UNITS_PER_CREDIT; // 1,000,000 credits

/**
 * A round left with no player command for this long is reconciled by a forced
 * BANK at the exact current colony value (docs/ENGINE.md §5.1). Every action
 * ties in expectation, so a forced bank is exactly EV-neutral; it exists so that
 * staked funds and a committed seed cannot sit in suspense indefinitely.
 * It is four orders of magnitude above any human decision latency, so it does
 * not make any money decision latency-sensitive.
 */
export const ABANDONED_ROUND_TIMEOUT_HOURS = 72;

/** Mean offspring per organism, exact. */
export const MU = (() => {
  const weighted = OFFSPRING.reduce((total, o) => total + o.weight * BigInt(o.children), 0n);
  return rat(weighted, DRAW_MODULUS);
})();

/** Value of one organism at generation 1, exact: RTP / (SEED_COUNT * MU). */
export const LADDER_BASE = divide(TARGET_RTP, multiply(rat(BigInt(SEED_COUNT)), MU));

/**
 * Value of one organism at generation t (t >= 1), exact:
 *   c(t) = LADDER_BASE * (1/MU)^(t-1)
 * The ladder step 1/MU is exactly the drift of the colony, which is what makes
 * colony value a martingale from generation 1 onward. See docs/MATH.md.
 */
export function organismValue(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATIONS)
    fail('INVALID_GENERATION', `Generation ${generation} is outside [1, ${MAX_GENERATIONS}]`);
  return multiply(LADDER_BASE, power(divide(ONE, MU), generation - 1));
}

/** Colony multiplier for `population` organisms at `generation`, exact. */
export function colonyMultiplier(generation, population) {
  if (!Number.isSafeInteger(population) || population < 0 || population > MAX_POPULATION)
    fail('INVALID_POPULATION', `Population ${population} is outside [0, ${MAX_POPULATION}]`);
  if (population === 0) return rat(0n);
  return multiply(organismValue(generation), rat(BigInt(population)));
}

/** The largest multiplier the paytable can produce. Reached only by a full-bloom final generation. */
export function structuralMaxMultiplier() {
  return colonyMultiplier(MAX_GENERATIONS, MAX_POPULATION);
}

/** Validates every internal consistency claim the documentation makes. Throws on any violation. */
export function assertConfig() {
  const weightTotal = OFFSPRING.reduce((total, o) => total + o.weight, 0n);
  if (weightTotal !== DRAW_MODULUS)
    fail('INVALID_CONFIG', 'Offspring weights must sum to the draw modulus');
  let cursor = 0n;
  for (const outcome of OFFSPRING) {
    if (outcome.lowDraw !== cursor || outcome.highDraw !== cursor + outcome.weight - 1n)
      fail('INVALID_CONFIG', `Draw band for ${outcome.id} is not contiguous`);
    cursor += outcome.weight;
  }
  if (compare(MU, ONE) >= 0)
    fail('INVALID_CONFIG', 'Mean offspring must be < 1 so the value ladder climbs');
  // RTP identity: expected colony value after the mandatory first generation.
  const entry = multiply(
    multiply(LADDER_BASE, rat(BigInt(SEED_COUNT))),
    MU,
  );
  if (compare(entry, TARGET_RTP) !== 0)
    fail('INVALID_CONFIG', 'Entry price does not reproduce the target RTP');
  // The declared cap must sit above the structural maximum so it can never truncate a payout.
  if (compare(structuralMaxMultiplier(), rat(COLONY_MAX_WIN_MULTIPLE)) >= 0)
    fail('INVALID_CONFIG', 'Declared max-win multiple would truncate the paytable');
  if (MIN_STAKE_UNITS <= 0n || MAX_STAKE_UNITS < MIN_STAKE_UNITS)
    fail('INVALID_CONFIG', 'Stake bounds are inconsistent');
  if (MIN_SIDE_BET_STAKE_UNITS <= 0n || MAX_SIDE_BET_STAKE_UNITS < MIN_SIDE_BET_STAKE_UNITS)
    fail('INVALID_CONFIG', 'Side-bet stake bounds are inconsistent');
  return true;
}

/**
 * Worst-case liability of one ticket, in minor units: the colony line at its own
 * ceiling plus every selected side-bet line at its own ceiling. This is a
 * *disclosure and an admission check*, not a truncating cap — no settlement is
 * ever reduced to fit it. `selections` maps side-bet id to that line's stake.
 */
export function ticketExposureUnits(colonyStakeUnits, selections = {}) {
  if (typeof colonyStakeUnits !== 'bigint' || colonyStakeUnits < MIN_STAKE_UNITS ||
      colonyStakeUnits > MAX_STAKE_UNITS)
    fail('INVALID_STAKE', 'Colony stake is outside the declared bounds', '$.stakeUnits');
  let exposure = colonyStakeUnits * COLONY_MAX_WIN_MULTIPLE;
  for (const [id, stakeUnits] of Object.entries(selections)) {
    const cap = SIDE_BET_MAX_WIN_MULTIPLES[id];
    if (cap === undefined) fail('UNKNOWN_SIDE_BET', `No such side bet: ${id}`, '$.sideBets');
    if (typeof stakeUnits !== 'bigint' || stakeUnits < MIN_SIDE_BET_STAKE_UNITS ||
        stakeUnits > MAX_SIDE_BET_STAKE_UNITS)
      fail('INVALID_STAKE', `Side-bet stake for ${id} is outside the declared bounds`, '$.sideBets');
    exposure += stakeUnits * cap;
  }
  return exposure;
}

/** The largest ticket the declared stake bounds allow, in minor units. */
export function maximumTicketExposureUnits() {
  const selections = {};
  for (const id of Object.keys(SIDE_BET_MAX_WIN_MULTIPLES))
    selections[id] = MAX_SIDE_BET_STAKE_UNITS;
  return ticketExposureUnits(MAX_STAKE_UNITS, selections);
}

/** Offspring probability mass function as exact rationals, indexed by child count. */
export function offspringPmf() {
  const pmf = [rat(0n), rat(0n), rat(0n)];
  for (const outcome of OFFSPRING)
    pmf[outcome.children] = add(pmf[outcome.children], rat(outcome.weight, DRAW_MODULUS));
  return Object.freeze(pmf);
}

/** Integer numerators of the offspring pmf over `DRAW_MODULUS`, indexed by child count. */
export function offspringWeights() {
  const weights = [0n, 0n, 0n];
  for (const outcome of OFFSPRING) weights[outcome.children] += outcome.weight;
  return Object.freeze(weights);
}

export const CONFIG = Object.freeze({
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  paytableSchema: PAYTABLE_SCHEMA,
  seedCommitmentVersion: SEED_COMMITMENT_VERSION,
  bodyCommitmentVersion: BODY_COMMITMENT_VERSION,
  samplerDomain: SAMPLER_DOMAIN,
  actionChainDomain: ACTION_CHAIN_DOMAIN,
  clientEntropyBytes: CLIENT_ENTROPY_BYTES,
  harvestQuantum: HARVEST_QUANTUM,
  harvestCommitsPerStage: HARVEST_COMMITS_PER_STAGE,
  drawModulus: DRAW_MODULUS,
  offspring: OFFSPRING,
  seedCount: SEED_COUNT,
  maxGenerations: MAX_GENERATIONS,
  bloomThreshold: BLOOM_THRESHOLD,
  maxPopulation: MAX_POPULATION,
  targetRtp: TARGET_RTP,
  colonyMaxWinMultiple: COLONY_MAX_WIN_MULTIPLE,
  sideBetMaxWinMultiples: SIDE_BET_MAX_WIN_MULTIPLES,
  maxTicketExposureUnits: MAX_TICKET_EXPOSURE_UNITS,
  unitsPerCredit: UNITS_PER_CREDIT,
  minStakeUnits: MIN_STAKE_UNITS,
  maxStakeUnits: MAX_STAKE_UNITS,
  minSideBetStakeUnits: MIN_SIDE_BET_STAKE_UNITS,
  maxSideBetStakeUnits: MAX_SIDE_BET_STAKE_UNITS,
  abandonedRoundTimeoutHours: ABANDONED_ROUND_TIMEOUT_HOURS,
  mu: MU,
  ladderBase: LADDER_BASE,
});
