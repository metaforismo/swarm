/**
 * The wire format.
 *
 * Two rules, both from `docs/MATH.md` and `docs/DESIGN.md` §9.3 rather than from
 * taste: money crosses as an integer string of **minor units**, never as a float;
 * and every exact value crosses as its canonical `numerator/denominator` fraction
 * next to a decimal that is **truncated toward zero**, so a displayed multiplier
 * is never above what the game will actually pay.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toDecimal } from '../../tools/lib/rational.mjs';
import { GRID_SIZE, SLOTS, SWARM, adapterFingerprint } from './adapter.ts';
import type { StageFrame } from './book.ts';
import type { Rational } from './engine.ts';
import { fail } from './errors.ts';
import { PAYTABLE, SIDE_BETS } from './paytable.ts';
import type { Receipt, Settlement } from './settlement.ts';
import type { HistoryEntry } from './service.ts';
import type { ProofBundle } from './verify.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../spec/paytable.v3.json', import.meta.url));
const ENGINE_PACKAGE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../node_modules/@axiom-games/reveal-engine/package.json', import.meta.url)),
    'utf8',
  ),
) as { name: string; version: string };

/** Digest of the frozen fixture, the value `docs/MATH.md` publishes as its identity. */
const FIXTURE_DIGEST = createHash('sha256').update(readFileSync(FIXTURE_PATH, 'utf8'), 'utf8').digest('hex');

export interface WireRational {
  readonly fraction: string;
  readonly decimal: string;
}

export function wireRational(value: Rational | null, digits = 6): WireRational | null {
  if (value === null) return null;
  return { fraction: `${value.numerator}/${value.denominator}`, decimal: toDecimal(value, digits) };
}

export function wireReceipt(receipt: Receipt): Record<string, unknown> {
  return {
    schema: receipt.schema,
    sequence: receipt.sequence,
    kind: receipt.kind,
    line: receipt.line,
    direction: receipt.direction,
    stage: receipt.stage,
    amountUnits: receipt.amountUnits.toString(),
    unitsHarvested: receipt.unitsHarvested,
    resolved: receipt.resolved,
    theoretical: wireRational(receipt.theoretical),
    capped: receipt.capped,
    terminal: receipt.terminal ?? null,
  };
}

export function wireFrame(frame: StageFrame): Record<string, unknown> {
  return {
    revision: frame.revision,
    stage: frame.stage,
    units: frame.units,
    unitValue: wireRational(frame.unitValue),
    colonyValue: wireRational(frame.colonyValue),
    nextUnitValue: wireRational(frame.nextUnitValue),
    decisionOpen: frame.decisionOpen,
    terminal: frame.terminal,
    state: frame.state,
    actionChain: frame.actionChain,
    wildUnits: frame.wildUnits,
    wildPeakUnits: frame.wildPeakUnits,
    sideBetChips: frame.sideBetChips,
    creditedUnits: frame.creditedUnits.toString(),
    lastResolution: frame.lastResolution,
  };
}

export function wireSettlement(settlement: Settlement): Record<string, unknown> {
  const proof = settlement.proof;
  return {
    creditedUnits: settlement.creditedUnits.toString(),
    stakedUnits: settlement.stakedUnits.toString(),
    netUnits: (settlement.creditedUnits - settlement.stakedUnits).toString(),
    exposureUnits: settlement.exposureUnits.toString(),
    receipts: settlement.receipts.map(wireReceipt),
    /** Exactly the input set §4.6 verifies, and nothing a verifier has to trust. */
    proof: {
      seedCommitment: proof.seedCommitment,
      bodyCommitment: proof.bodyCommitment,
      actionChain: proof.actionChain,
      liveChainValues: proof.liveChainValues,
      revealedSeed: proof.revealedSeed,
      roundId: proof.roundId,
      clientEntropy: proof.clientEntropy,
      adapterFingerprint: proof.adapterFingerprint,
      stakeUnits: proof.stakeUnits.toString(),
      sideBetStakes: Object.fromEntries(
        Object.entries(proof.sideBetStakes).map(([id, units]) => [id, units.toString()]),
      ),
      actionLog: proof.actionLog,
      populations: proof.populations,
      terminal: proof.terminal,
      settlementMode: proof.settlementMode,
      sideBetResults: proof.sideBetResults,
      receipts: settlement.receipts.map(wireReceipt),
    },
    /** The completed wild line, drawn for the first time after the round (screen S8a). */
    wild: {
      populations: proof.wild.populations,
      peak: proof.wild.peak,
      terminal: proof.wild.terminal,
      extinctGeneration: proof.wild.extinctGeneration,
    },
  };
}

export function wireHistory(entry: HistoryEntry): Record<string, unknown> {
  return {
    roundId: entry.roundId,
    terminal: entry.terminal,
    settlementMode: entry.settlementMode,
    stakedUnits: entry.stakedUnits.toString(),
    creditedUnits: entry.creditedUnits.toString(),
    netUnits: entry.netUnits.toString(),
    generations: entry.generations,
    settledAt: entry.settledAt,
  };
}

/** Parses an untrusted proof bundle from the verify endpoint. Fails closed, always. */
export function parseProofBundle(input: unknown): ProofBundle {
  if (typeof input !== 'object' || input === null)
    fail('INVALID_TRANSCRIPT', 'A proof bundle must be an object', '$.proof');
  const source = input as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    if (typeof value !== 'string' || value.length > 512)
      fail('INVALID_TRANSCRIPT', `Field ${key} must be a short string`, `$.${key}`);
    return value;
  };
  const units = (value: unknown, path: string): bigint => {
    if (typeof value !== 'string' || !/^\d{1,25}$/u.test(value))
      fail('INVALID_TRANSCRIPT', 'Money must be an integer string of minor units', path);
    return BigInt(value);
  };
  const stakes: Record<string, bigint> = {};
  const rawStakes = source.sideBetStakes;
  if (rawStakes !== undefined && rawStakes !== null) {
    if (typeof rawStakes !== 'object')
      fail('INVALID_TRANSCRIPT', 'Side-bet stakes must be an object', '$.sideBetStakes');
    for (const [id, value] of Object.entries(rawStakes as Record<string, unknown>)) {
      if (!SWARM.sideBets.some((bet) => bet.id === id))
        fail('INVALID_TRANSCRIPT', `Unknown side bet ${id}`, '$.sideBetStakes');
      stakes[id] = units(value, `$.sideBetStakes.${id}`);
    }
  }
  const log = source.actionLog;
  if (!Array.isArray(log) || log.length > SWARM.ladder.stages)
    fail('INVALID_TRANSCRIPT', 'Malformed action log', '$.actionLog');
  const populations = source.populations;
  if (!Array.isArray(populations) || populations.length > SWARM.ladder.stages)
    fail('INVALID_TRANSCRIPT', 'Malformed population list', '$.populations');
  const receipts = source.receipts;
  if (!Array.isArray(receipts) || receipts.length > 128)
    fail('INVALID_TRANSCRIPT', 'Malformed receipt ledger', '$.receipts');
  const results = source.sideBetResults;
  if (results !== undefined && (!Array.isArray(results) || results.length > 8))
    fail('INVALID_TRANSCRIPT', 'Malformed side-bet results', '$.sideBetResults');

  return {
    seedCommitment: text('seedCommitment'),
    bodyCommitment: text('bodyCommitment'),
    actionChain: text('actionChain'),
    revealedSeed: text('revealedSeed'),
    roundId: text('roundId'),
    clientEntropy: text('clientEntropy'),
    adapterFingerprint: text('adapterFingerprint'),
    stakeUnits: units(source.stakeUnits, '$.stakeUnits'),
    sideBetStakes: stakes,
    actionLog: log.map((entry: Record<string, unknown>, index: number) => {
      if (typeof entry !== 'object' || entry === null)
        fail('INVALID_TRANSCRIPT', 'Malformed action', `$.actionLog[${index}]`);
      return {
        generation: Number(entry.generation),
        kind: String(entry.kind) as 'CONTINUE' | 'HARVEST' | 'BANK',
        units: Number(entry.units),
      };
    }),
    populations: populations.map((value: unknown) => Number(value)),
    terminal: text('terminal'),
    settlementMode: text('settlementMode'),
    sideBetResults: (results ?? []).map((entry: Record<string, unknown>) => ({
      id: String(entry.id),
      resolved: String(entry.resolved),
    })),
    receipts: receipts.map((entry: Record<string, unknown>, index: number) => {
      if (typeof entry !== 'object' || entry === null)
        fail('INVALID_TRANSCRIPT', 'Malformed receipt', `$.receipts[${index}]`);
      return {
        schema: 'receipt-v2',
        sequence: Number(entry.sequence),
        kind: String(entry.kind),
        line: String(entry.line),
        direction: String(entry.direction),
        stage: Number(entry.stage),
        amountUnits: units(entry.amountUnits, `$.receipts[${index}].amountUnits`),
        unitsHarvested: Number(entry.unitsHarvested ?? 0),
        resolved: entry.resolved === null || entry.resolved === undefined ? null : String(entry.resolved),
        theoretical: null,
        capped: entry.capped === true,
      } as unknown as Receipt;
    }),
  };
}

/**
 * The configuration and the whole published paytable, served to the client.
 *
 * The client renders its help screen, its side-bet drawer and its fairness sheet
 * from this and from nothing else, so every number a player can read is the
 * enumerated one: the source is `spec/paytable.v3.json`, the frozen artifact CI
 * compares byte for byte against a fresh enumeration.
 */
export function wireConfig(options: { abandonedRoundTimeoutHours: number }): Record<string, unknown> {
  return {
    identity: {
      adapterId: SWARM.id,
      adapterVersion: SWARM.adapterVersion,
      moduleApi: SWARM.apiVersion,
      cohortModel: SWARM.cohort.modelVersion,
      adapterFingerprint: adapterFingerprint(),
      paytableSchema: PAYTABLE.schema,
      paytableDigest: FIXTURE_DIGEST,
      engine: { name: ENGINE_PACKAGE.name, version: ENGINE_PACKAGE.version },
      proof: SWARM.proof,
    },
    money: {
      unitsPerCredit: SWARM.money.unitsPerCredit.toString(),
      minStakeUnits: SWARM.risk.minStakeUnits.toString(),
      maxStakeUnits: SWARM.risk.maxStakeUnits.toString(),
      minSideBetStakeUnits: SWARM.risk.minSideBetStakeUnits.toString(),
      maxSideBetStakeUnits: SWARM.risk.maxSideBetStakeUnits.toString(),
      maxTicketExposureUnits: SWARM.risk.maxTicketExposureUnits.toString(),
      colonyMaxWinMultiple: SWARM.risk.colonyMaxWinMultiple.toString(),
    },
    rules: {
      seedUnits: SWARM.seedUnits,
      stages: SWARM.ladder.stages,
      bloomThreshold: SWARM.thresholds.settleAtOrAbove,
      maxUnits: SWARM.thresholds.maxUnits,
      slotsPerStage: SLOTS,
      gridSize: GRID_SIZE,
      drawModulus: SWARM.cohort.drawModulus.toString(),
      offspring: SWARM.cohort.outcomes.map((outcome) => ({
        id: outcome.id,
        children: outcome.children,
        band: `${outcome.lowDraw}-${outcome.highDraw}`,
        percent: (Number(outcome.weight) * 100) / Number(SWARM.cohort.drawModulus),
      })),
      harvestQuantum: SWARM.thinning.clientQuantum,
      commitsPerStage: SWARM.thinning.commitsPerStage,
      clientEntropyBytes: SWARM.entropy.clientEntropyBytes,
      abandonedRoundTimeoutHours: options.abandonedRoundTimeoutHours,
      targetRtp: wireRational(SWARM.pricing.targetRtp, 4),
    },
    /**
     * `docs/DESIGN.md` §9.7. The floors are a speed-of-play control, never a
     * deadline on a decision: no floor can cost a payout, and nothing in the game
     * is timed.
     */
    pacing: { roundCycleMs: 2500, decisionDeadPeriodMs: 350, settlementHoldMs: 600 },
    ladder: PAYTABLE.ladder,
    sideBets: SIDE_BETS.map((bet) => ({
      id: bet.id,
      label: bet.label,
      description: bet.description,
      multiplier: { fraction: `${bet.multiplier.numerator}/${bet.multiplier.denominator}`, decimal: bet.multiplierDecimal },
      probabilityDecimal: bet.probabilityDecimal,
      oneIn: bet.oneIn,
      capMultiple: bet.capMultiple.toString(),
    })),
    /** Everything the help screen prints, straight from the frozen enumeration. */
    published: {
      totals: PAYTABLE.totals,
      policies: PAYTABLE.policies,
      risk: PAYTABLE.risk,
      roundMaximum: PAYTABLE.roundMaximum,
      structuralMaximum: PAYTABLE.structuralMaximum,
      bloom: PAYTABLE.bloom,
      breakEven: PAYTABLE.breakEven,
      underwater: PAYTABLE.underwater,
      generationOne: PAYTABLE.generationOne,
      survival: PAYTABLE.survival,
      reach: PAYTABLE.reach,
      nearMiss: PAYTABLE.nearMiss,
      ticketPairings: PAYTABLE.ticketPairings,
      roundingBound: PAYTABLE.roundingBound,
      terminalCategories: PAYTABLE.terminalCategories,
      presentation: PAYTABLE.presentation,
      proofSurface: PAYTABLE.proofSurface,
    },
  };
}
