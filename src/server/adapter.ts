/**
 * The `swarm-colony-v1` adapter, exactly as `docs/ENGINE.md` §3.2 declares it.
 *
 * Every value comes from `tools/lib/config.mjs`, the reference configuration the
 * enumeration, the frozen paytable and every published number are derived from.
 * Nothing is restated here, so this file cannot drift from the specification: a
 * change to the offspring bands or the ladder moves the fingerprint below, and
 * the fingerprint is frozen by `tests/derivation.test.mjs`.
 */
import {
  ACTION_CHAIN_DOMAIN,
  ADAPTER_ID,
  ADAPTER_VERSION,
  ABANDONED_ROUND_TIMEOUT_HOURS,
  BLOOM_THRESHOLD,
  BODY_COMMITMENT_VERSION,
  CLIENT_ENTROPY_BYTES,
  COHORT_MODEL_VERSION,
  COLONY_MAX_WIN_MULTIPLE,
  DRAW_MODULUS,
  HARVEST_COMMITS_PER_STAGE,
  HARVEST_QUANTUM,
  LADDER_BASE,
  MAX_GENERATIONS,
  MAX_POPULATION,
  MAX_SIDE_BET_STAKE_UNITS,
  MAX_STAKE_UNITS,
  MAX_TICKET_EXPOSURE_UNITS,
  MIN_SIDE_BET_STAKE_UNITS,
  MIN_STAKE_UNITS,
  MODULE_API,
  MU,
  OFFSPRING,
  SAMPLER_DOMAIN,
  SEED_COMMITMENT_VERSION,
  SEED_COUNT,
  SIDE_BET_MAX_WIN_MULTIPLES,
  TARGET_RTP,
  UNITS_PER_CREDIT,
  assertConfig,
  colonyMultiplier,
  organismValue,
  ticketExposureUnits,
} from '../../tools/lib/config.mjs';
import { encodeFields, type CanonicalField } from './canonical.ts';
import { compare, divide, equal, multiply, rational, sha256Hex, type Rational } from './engine.ts';
import { fail } from './errors.ts';

assertConfig();

/** Slots per generation: the widest colony that can still take a decision. */
export const SLOTS = BLOOM_THRESHOLD - 1;
/** Draws in one round's committed grid. 18 x 15. */
export const GRID_SIZE = MAX_GENERATIONS * SLOTS;

/** The ladder step, `1 / mu`, exactly `5/4`. */
export const LADDER_STEP: Rational = divide(rational(1n), MU);

/** Side-bet ids in declaration order. The body commitment walks them in this order, always. */
export const SIDE_BET_IDS: readonly string[] = Object.freeze(
  Object.keys(SIDE_BET_MAX_WIN_MULTIPLES),
);

export interface CohortOutcome {
  readonly id: string;
  readonly children: number;
  readonly weight: bigint;
  readonly lowDraw: bigint;
  readonly highDraw: bigint;
}

export interface SwarmAdapter {
  readonly apiVersion: string;
  readonly adapterVersion: string;
  readonly id: string;
  readonly seedUnits: number;
  readonly cohort: {
    readonly modelVersion: string;
    readonly drawModulus: bigint;
    readonly maxChildren: number;
    readonly outcomes: readonly CohortOutcome[];
  };
  readonly ladder: { readonly base: Rational; readonly step: Rational; readonly stages: number };
  readonly thresholds: { readonly settleAtOrAbove: number; readonly maxUnits: number };
  readonly thinning: {
    readonly allowPartial: boolean;
    readonly clientQuantum: string;
    readonly commitsPerStage: number;
    readonly removal: 'highest-slots';
  };
  readonly entropy: {
    readonly clientEntropyBytes: number;
    readonly required: true;
    readonly playerEditable: boolean;
  };
  readonly proof: {
    readonly seedCommitmentVersion: string;
    readonly bodyCommitmentVersion: string;
    readonly samplerDomain: string;
    readonly actionChainDomain: string;
  };
  readonly sideBets: readonly { readonly id: string; readonly maxWinMultiple: bigint }[];
  readonly pricing: { readonly targetRtp: Rational; readonly rounding: 'floor' };
  readonly risk: {
    readonly colonyMaxWinMultiple: bigint;
    readonly minStakeUnits: bigint;
    readonly maxStakeUnits: bigint;
    readonly minSideBetStakeUnits: bigint;
    readonly maxSideBetStakeUnits: bigint;
    readonly maxTicketExposureUnits: bigint;
  };
  readonly lifecycle: { readonly abandonedRoundTimeoutHours: number };
  readonly money: { readonly unitsPerCredit: bigint };
}

export const SWARM: SwarmAdapter = Object.freeze({
  apiVersion: MODULE_API,
  adapterVersion: ADAPTER_VERSION,
  id: ADAPTER_ID,
  seedUnits: SEED_COUNT,
  cohort: Object.freeze({
    modelVersion: COHORT_MODEL_VERSION,
    drawModulus: DRAW_MODULUS,
    maxChildren: Math.max(...OFFSPRING.map((outcome) => outcome.children)),
    outcomes: OFFSPRING,
  }),
  ladder: Object.freeze({ base: LADDER_BASE, step: LADDER_STEP, stages: MAX_GENERATIONS }),
  thresholds: Object.freeze({ settleAtOrAbove: BLOOM_THRESHOLD, maxUnits: MAX_POPULATION }),
  thinning: Object.freeze({
    allowPartial: true,
    clientQuantum: HARVEST_QUANTUM,
    commitsPerStage: HARVEST_COMMITS_PER_STAGE,
    removal: 'highest-slots' as const,
  }),
  entropy: Object.freeze({
    clientEntropyBytes: CLIENT_ENTROPY_BYTES,
    required: true as const,
    playerEditable: true,
  }),
  proof: Object.freeze({
    seedCommitmentVersion: SEED_COMMITMENT_VERSION,
    bodyCommitmentVersion: BODY_COMMITMENT_VERSION,
    samplerDomain: SAMPLER_DOMAIN,
    actionChainDomain: ACTION_CHAIN_DOMAIN,
  }),
  sideBets: Object.freeze(
    SIDE_BET_IDS.map((id) =>
      Object.freeze({
        id,
        maxWinMultiple: SIDE_BET_MAX_WIN_MULTIPLES[id as keyof typeof SIDE_BET_MAX_WIN_MULTIPLES],
      }),
    ),
  ),
  pricing: Object.freeze({ targetRtp: TARGET_RTP, rounding: 'floor' as const }),
  risk: Object.freeze({
    colonyMaxWinMultiple: COLONY_MAX_WIN_MULTIPLE,
    minStakeUnits: MIN_STAKE_UNITS,
    maxStakeUnits: MAX_STAKE_UNITS,
    minSideBetStakeUnits: MIN_SIDE_BET_STAKE_UNITS,
    maxSideBetStakeUnits: MAX_SIDE_BET_STAKE_UNITS,
    maxTicketExposureUnits: MAX_TICKET_EXPOSURE_UNITS,
  }),
  lifecycle: Object.freeze({ abandonedRoundTimeoutHours: ABANDONED_ROUND_TIMEOUT_HOURS }),
  money: Object.freeze({ unitsPerCredit: UNITS_PER_CREDIT }),
});

/**
 * The adapter fingerprint, over exactly the field list `docs/ENGINE.md` §2
 * declares — module API, adapter identity, cohort model, both commitment
 * versions, the sampler and action-chain domains, the client-entropy width, the
 * draw modulus, every band in order, the shape, the harvest quantum and the
 * number of commitments a stage accepts, the ladder, the target RTP, the
 * rounding mode, the colony cap, and every side-bet line with its own cap.
 *
 * It is a field of the sampler payload and of both commitments, so a transcript
 * is only verifiable against the adapter it was produced under. For
 * `swarm-colony-v1 @ 1.3.0` it is
 * `3fc7b96ea3546f14169032d070aa48f103de7db048cc8a306cf99227d33d36cf`, which
 * `tests/derivation.test.mjs` freezes and `tests/server-derivation.test.mjs`
 * re-derives from this definition.
 */
let fingerprintCache: string | null = null;
export function adapterFingerprint(): string {
  if (fingerprintCache !== null) return fingerprintCache;
  const fields: CanonicalField[] = [
    SWARM.apiVersion,
    SWARM.id,
    SWARM.adapterVersion,
    SWARM.cohort.modelVersion,
    SWARM.proof.seedCommitmentVersion,
    SWARM.proof.bodyCommitmentVersion,
    SWARM.proof.samplerDomain,
    SWARM.proof.actionChainDomain,
    SWARM.entropy.clientEntropyBytes,
    SWARM.cohort.drawModulus,
  ];
  for (const outcome of SWARM.cohort.outcomes)
    fields.push(outcome.id, outcome.children, outcome.weight);
  fields.push(
    SWARM.seedUnits,
    SWARM.ladder.stages,
    SWARM.thresholds.settleAtOrAbove,
    SWARM.thresholds.maxUnits,
    SWARM.thinning.clientQuantum,
    SWARM.thinning.commitsPerStage,
    SWARM.ladder.base.numerator,
    SWARM.ladder.base.denominator,
    SWARM.ladder.step.numerator,
    SWARM.ladder.step.denominator,
    SWARM.pricing.targetRtp.numerator,
    SWARM.pricing.targetRtp.denominator,
    SWARM.pricing.rounding,
    SWARM.risk.colonyMaxWinMultiple,
  );
  for (const bet of SWARM.sideBets) fields.push(bet.id, bet.maxWinMultiple);
  fingerprintCache = sha256Hex(encodeFields(fields));
  return fingerprintCache;
}

/** Exact mean offspring of the cohort model. */
export function cohortMean(): Rational {
  return MU;
}

/**
 * Value of one organism at `stage`. Throws outside `[1, stages]`.
 *
 * **Stage 0 has no ladder value, deliberately** (`docs/ENGINE.md` §3.1): `c(0)`
 * is an accounting identity outside the ladder, and paying it would be paying a
 * `0.95x` settlement on a round in which nothing was revealed.
 */
export function ladderValue(stage: number): Rational {
  return organismValue(stage);
}

/** Value of `units` organisms at `stage`, exactly `ladderValue(stage) * units`. */
export function cohortValue(stage: number, units: number): Rational {
  return colonyMultiplier(stage, units);
}

export { ticketExposureUnits };

/**
 * The fairness contract, checked mechanically at load time (`docs/ENGINE.md` §3.1):
 *   ladder.step * cohortMean() === 1
 *   ladder.base * seedUnits * cohortMean() === targetRtp
 * The first makes colony value a martingale across a stage; the second makes the
 * entry price the entire house edge.
 */
export function assertLadderIsFair(): void {
  if (!equal(multiply(SWARM.ladder.step, cohortMean()), rational(1n)))
    fail('INVALID_ADAPTER', 'The ladder step does not cancel the cohort drift', '$.ladder.step');
  const entry = multiply(
    multiply(SWARM.ladder.base, rational(BigInt(SWARM.seedUnits))),
    cohortMean(),
  );
  if (!equal(entry, SWARM.pricing.targetRtp))
    fail('INVALID_ADAPTER', 'The entry price is not the target RTP', '$.ladder.base');
}

/**
 * The proof contract (`docs/ENGINE.md` §3.1): a choice-timed adapter must declare
 * both commitment phases and a client-entropy width, or it does not build.
 */
export function assertCommitmentIsTwoPhase(): void {
  const { seedCommitmentVersion, bodyCommitmentVersion } = SWARM.proof;
  if (!seedCommitmentVersion || !bodyCommitmentVersion)
    fail('INVALID_ADAPTER', 'A choice-timed adapter needs both commitment phases', '$.proof');
  if (seedCommitmentVersion === bodyCommitmentVersion)
    fail('INVALID_ADAPTER', 'The two commitment phases must be distinct', '$.proof');
  if (SWARM.entropy.required !== true || SWARM.entropy.clientEntropyBytes !== 32)
    fail('INVALID_ADAPTER', 'Client entropy is mandatory and 32 bytes wide', '$.entropy');
}

/**
 * The risk contract (`docs/ENGINE.md` §3.1), per line. The maxima are the
 * enumerated ones — the exact maximum cumulative COLONY credit over every grid
 * and every harvest policy, and each side bet's exact multiplier — so a
 * configuration in which a cap could truncate a credit cannot be served at all.
 */
export function assertRiskIsHeadroom(
  colonyMaximumCredit: Rational,
  sideBetMultipliers: ReadonlyMap<string, Rational>,
): void {
  if (compare(colonyMaximumCredit, rational(SWARM.risk.colonyMaxWinMultiple)) >= 0)
    fail('INVALID_ADAPTER', 'The COLONY cap could truncate a reachable round total', '$.risk');
  for (const bet of SWARM.sideBets) {
    const multiplier = sideBetMultipliers.get(bet.id);
    if (multiplier === undefined)
      fail('INVALID_ADAPTER', `Side bet ${bet.id} has no enumerated price`, '$.sideBets');
    if (compare(multiplier, rational(bet.maxWinMultiple)) >= 0)
      fail('INVALID_ADAPTER', `Side bet ${bet.id} prices at or above its own cap`, '$.sideBets');
  }
  const worst = ticketExposureUnits(
    SWARM.risk.maxStakeUnits,
    Object.fromEntries(SIDE_BET_IDS.map((id) => [id, SWARM.risk.maxSideBetStakeUnits])),
  );
  if (worst >= SWARM.risk.maxTicketExposureUnits)
    fail('INVALID_ADAPTER', 'The worst admissible ticket reaches the exposure limit', '$.risk');
}

assertLadderIsFair();
assertCommitmentIsTwoPhase();
