/**
 * The verifier — `docs/ENGINE.md` §4.6, in the order that section mandates.
 *
 * `actionLog` is an **untrusted input**: it is what the operator claims the
 * player did. Step 8 re-seals the settlement body over the log that was actually
 * replayed and compares it in constant time, so a fabricated log — or a genuine
 * log attached to a fabricated ledger — fails closed. Every failure is one of the
 * public codes; nothing throws a parser trace at the caller.
 *
 * It is the same function the fairness sheet (screen S9) calls, and it goes
 * through `sealSettlement()`, so it re-derives a settlement through exactly the
 * code path a settlement was produced by.
 */
import { SWARM, adapterFingerprint } from './adapter.ts';
import {
  SETTLEMENT_MODES,
  bodyCommitment,
  publishedTerminal,
  seedCommitment,
  type SettlementMode,
} from './commitment.ts';
import {
  deriveGrid,
  replayRound,
  roundContext,
  wildLineOf,
  actionKind,
  type LoggedAction,
} from './derivation.ts';
import { constantTimeHexEqual, equal, normalizeSeed } from './engine.ts';
import { sealSettlement, type Receipt } from './settlement.ts';
import { frozenCopy } from './snapshot.ts';

export interface ProofBundle {
  readonly seedCommitment: string;
  readonly bodyCommitment: string;
  readonly actionChain: string;
  readonly revealedSeed: string;
  readonly roundId: string;
  readonly clientEntropy: string;
  readonly adapterFingerprint: string;
  readonly stakeUnits: bigint;
  readonly sideBetStakes: Readonly<Record<string, bigint>>;
  readonly actionLog: readonly LoggedAction[];
  readonly populations: readonly number[];
  readonly terminal: string;
  readonly settlementMode: string;
  readonly sideBetResults: readonly { readonly id: string; readonly resolved: string }[];
  readonly receipts: readonly Receipt[];
}

export interface VerificationStep {
  readonly step: number;
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string;
  readonly steps: readonly VerificationStep[];
  readonly seedCommitment?: string;
  readonly bodyCommitment?: string;
}

const STEP_NAMES = [
  'adapter fingerprint',
  'phase 1 — seed pre-commitment re-derives',
  'grid replayed from the submitted action log',
  'COLONY credits re-derive, in order',
  'wild line and side-bet credits re-derive',
  'no receipt reports a capped credit',
  'action chain re-derives',
  'phase 2 — settlement body re-derives',
] as const;

export function verifyRound(proof: ProofBundle): VerificationResult {
  const steps: VerificationStep[] = [];
  let cursor = 0;
  const nameAt = (index: number): string => STEP_NAMES[index] ?? 'verification';
  const pass = (detail: string): void => {
    steps.push({ step: cursor + 1, name: nameAt(cursor), ok: true, detail });
    cursor += 1;
  };
  const stop = (code: string, detail: string): VerificationResult => {
    steps.push({ step: cursor + 1, name: nameAt(cursor), ok: false, detail });
    return frozenCopy({ ok: false, code, detail, steps });
  };

  try {
    if (typeof proof !== 'object' || proof === null)
      return stop('INVALID_TRANSCRIPT', 'not an object');
    const snapshot = snapshotProof(proof);

    // 1. Definition identity.
    if (snapshot.adapterFingerprint !== adapterFingerprint())
      return stop('ADAPTER_MISMATCH', 'adapter fingerprint does not match this build');
    pass(`${SWARM.id} @ ${SWARM.adapterVersion} — ${adapterFingerprint()}`);

    const context = roundContext(snapshot.roundId, snapshot.clientEntropy);
    const seed = normalizeSeed(snapshot.revealedSeed);

    // 2. Phase 1 must re-derive from the revealed seed, compared in constant time.
    const phaseOne = seedCommitment(seed, context.roundId);
    if (!constantTimeHexEqual(phaseOne, snapshot.seedCommitment))
      return stop('COMMITMENT_MISMATCH', 'seed pre-commitment does not re-derive');
    pass(phaseOne);

    const settlementMode = snapshot.settlementMode as SettlementMode;
    if (!SETTLEMENT_MODES.includes(settlementMode))
      return stop('INVALID_TRANSCRIPT', 'unknown settlement mode');

    // 3. Replay the grid using the submitted action log and nothing else. A log
    //    that is out of order, short, long, mislabelled, that harvests more than
    //    the stage held, or that carries two entries for one stage, is refused.
    const log = snapshot.actionLog;
    if (!Array.isArray(log) || log.length > SWARM.ladder.stages - 1)
      return stop('INVALID_TRANSCRIPT', 'malformed action log');
    const grid = deriveGrid(seed, context);
    let index = 0;
    let lastStage = 0;
    const replay = replayRound(grid, (generation, population) => {
      const entry = log[index];
      index += 1;
      if (entry === undefined) throw new Error('action log is shorter than the round');
      if (entry.generation <= lastStage) throw new Error('action log commits a stage more than once');
      if (entry.generation !== generation) throw new Error('action log is out of order');
      lastStage = entry.generation;
      if (!Number.isSafeInteger(entry.units) || entry.units < 0 || entry.units > population)
        throw new Error('action log contains an illegal harvest');
      if (entry.kind !== actionKind(entry.units, population))
        throw new Error('action log mislabels an action');
      return entry.units;
    });
    if (index !== log.length) return stop('TRANSCRIPT_MISMATCH', 'action log has trailing entries');
    const populations = replay.trace.map((entry) => entry.population);
    if (
      !Array.isArray(snapshot.populations) ||
      snapshot.populations.length !== populations.length ||
      snapshot.populations.some((value, at) => value !== populations[at])
    )
      return stop('TRANSCRIPT_MISMATCH', 'resolved populations do not re-derive');
    if (snapshot.terminal !== publishedTerminal(replay.reason, settlementMode))
      return stop('TRANSCRIPT_MISMATCH', 'terminal reason does not re-derive');
    // The `detail` of a verification step is descriptive text for the Verify
    // sheet. It is not hashed into either commitment, is never compared, and
    // nothing re-derives from it — so correcting the prose here cannot move a
    // payout. Everything above it, which can, is untouched.
    pass(
      `${populations.length} generation${populations.length === 1 ? '' : 's'}, terminal ${snapshot.terminal} (${settlementMode}), populations ${populations.join(' → ')}`,
    );

    // 4 and 5. Recompute the whole per-line ledger, including the side bets,
    //          through the same sealing path a settlement was produced by.
    const receipts = snapshot.receipts;
    if (!Array.isArray(receipts)) return stop('INVALID_TRANSCRIPT', 'missing receipt ledger');
    const wild = wildLineOf(grid);
    const expected = sealSettlement({
      seedHex: seed,
      context,
      seedCommitment: phaseOne,
      stakeUnits: snapshot.stakeUnits,
      sideBetStakes: snapshot.sideBetStakes,
      round: replay,
      wild,
      settlementMode,
    });
    if (receipts.length !== expected.receipts.length)
      return stop('TRANSCRIPT_MISMATCH', 'receipt count does not re-derive');
    // Every receipt field the settlement body seals is compared, not only the
    // amount: the body is re-sealed from the recomputation, so a bundle whose
    // displayed `resolved` or `unitsHarvested` disagrees with the round would
    // otherwise reach a player as VERIFIED.
    const mismatch = (at: number): boolean => {
      const actual = receipts[at] as Receipt;
      const want = expected.receipts[at] as Receipt;
      return (
        actual.sequence !== want.sequence ||
        actual.schema !== want.schema ||
        actual.kind !== want.kind ||
        actual.line !== want.line ||
        actual.direction !== want.direction ||
        actual.stage !== want.stage ||
        actual.amountUnits !== want.amountUnits ||
        (actual.unitsHarvested ?? 0) !== want.unitsHarvested ||
        (actual.resolved ?? null) !== want.resolved ||
        !sameRational(actual.theoretical, want.theoretical) ||
        actual.capped !== want.capped ||
        (actual.terminal ?? null) !== (want.terminal ?? null)
      );
    };
    for (let at = 0; at < receipts.length; at += 1) {
      const receipt = receipts[at] as Receipt;
      if (receipt.line !== 'COLONY') continue;
      if (mismatch(at)) return stop('TRANSCRIPT_MISMATCH', `COLONY receipt ${at + 1} does not re-derive`);
    }
    pass(
      expected.receipts
        .filter((receipt) => receipt.line === 'COLONY' && receipt.direction === 'CREDIT')
        .map((receipt) => `g${receipt.stage}: ${receipt.amountUnits} units`)
        .join(', ') || 'no COLONY credit',
    );

    for (let at = 0; at < receipts.length; at += 1) {
      const receipt = receipts[at] as Receipt;
      if (receipt.line === 'COLONY') continue;
      if (mismatch(at))
        return stop('TRANSCRIPT_MISMATCH', `${receipt.line} receipt ${at + 1} does not re-derive`);
    }
    // The body seals the whole ordered result set, so the verifier requires the
    // whole ordered result set rather than checking whichever rows it was handed.
    const results = snapshot.sideBetResults;
    if (results.length !== expected.proof.sideBetResults.length)
      return stop('TRANSCRIPT_MISMATCH', 'side-bet results are incomplete');
    for (let at = 0; at < results.length; at += 1) {
      const actual = results[at] as { id: string; resolved: string };
      const want = expected.proof.sideBetResults[at];
      if (want === undefined || actual.id !== want.id || actual.resolved !== want.resolved)
        return stop('TRANSCRIPT_MISMATCH', `side bet ${actual.id} does not re-derive`);
    }
    pass(
      `wild line ${wild.populations.join(' → ')}, peak ${wild.peak}; ` +
        (expected.proof.sideBetResults.map((entry) => `${entry.id} ${entry.resolved}`).join(', ') ||
          'no side bet'),
    );

    // 6. A cap can only bind if the adapter is misconfigured.
    if (receipts.some((receipt) => receipt.capped === true))
      return stop('TRANSCRIPT_MISMATCH', 'a receipt reports a capped credit');
    pass('every credit was paid in full');

    // 7 and 8. The chain and the body, re-sealed over what was actually replayed.
    if (!constantTimeHexEqual(expected.proof.actionChain, snapshot.actionChain))
      return stop('COMMITMENT_MISMATCH', 'action chain does not re-derive');
    pass(expected.proof.actionChain);

    const actualBody = bodyCommitment({
      seedCommitment: phaseOne,
      revealedSeed: seed,
      context,
      stakeUnits: snapshot.stakeUnits,
      sideBetStakes: snapshot.sideBetStakes,
      round: replay,
      wild,
      sideBetResults: results,
      receipts,
      chainTerminal: snapshot.actionChain,
      settlementMode,
    });
    if (!constantTimeHexEqual(actualBody, snapshot.bodyCommitment))
      return stop('COMMITMENT_MISMATCH', 'settlement body does not re-derive');
    pass(actualBody);

    return frozenCopy({
      ok: true,
      code: 'VERIFIED',
      detail: 'every credit on every line re-derives from the revealed seed and the action log',
      steps,
      seedCommitment: phaseOne,
      bodyCommitment: actualBody,
    });
  } catch (error) {
    return stop('DERIVATION_FAILED', error instanceof Error ? error.message : 'unknown');
  }
}

function sameRational(left: Receipt['theoretical'], right: Receipt['theoretical']): boolean {
  if (left === null || right === null) return left === right;
  return equal(left, right);
}

/**
 * The verifier is also an in-process public boundary. Every property is read once
 * into plain data before replay or commitment work begins.
 */
function snapshotProof(input: ProofBundle): ProofBundle {
  const source = input as unknown as Record<string, unknown>;
  const sideBetStakesSource = source.sideBetStakes;
  const sideBetStakes: Record<string, bigint> = {};
  if (typeof sideBetStakesSource !== 'object' || sideBetStakesSource === null)
    throw new Error('side-bet stakes are not an object');
  for (const [id, value] of Object.entries(sideBetStakesSource))
    sideBetStakes[id] = value as bigint;

  const actionLogSource = source.actionLog;
  if (!Array.isArray(actionLogSource)) throw new Error('action log is not an array');
  const actionLogLength = actionLogSource.length;
  const actionLog = [];
  for (let index = 0; index < actionLogLength; index += 1) {
    const entry = actionLogSource[index] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null)
      throw new Error('action log entry is not an object');
    actionLog.push({
      generation: entry.generation as number,
      kind: entry.kind as LoggedAction['kind'],
      units: entry.units as number,
    });
  }

  const populationSource = source.populations;
  if (!Array.isArray(populationSource)) throw new Error('populations are not an array');
  const populationLength = populationSource.length;
  const populations: number[] = [];
  for (let index = 0; index < populationLength; index += 1)
    populations.push(populationSource[index] as number);

  const resultSource = source.sideBetResults;
  if (!Array.isArray(resultSource)) throw new Error('side-bet results are not an array');
  const resultLength = resultSource.length;
  const sideBetResults: { id: string; resolved: string }[] = [];
  for (let index = 0; index < resultLength; index += 1) {
    const entry = resultSource[index] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null)
      throw new Error('side-bet result is not an object');
    sideBetResults.push({ id: entry.id as string, resolved: entry.resolved as string });
  }

  const receiptSource = source.receipts;
  if (!Array.isArray(receiptSource)) throw new Error('receipt ledger is not an array');
  const receiptLength = receiptSource.length;
  const receipts: Receipt[] = [];
  for (let index = 0; index < receiptLength; index += 1) {
    const entry = receiptSource[index] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null)
      throw new Error('receipt is not an object');
    const theoreticalSource = entry.theoretical;
    const terminal = entry.terminal;
    let theoretical: Receipt['theoretical'] = null;
    if (theoreticalSource !== null && theoreticalSource !== undefined) {
      if (typeof theoreticalSource !== 'object')
        throw new Error('receipt theoretical value is not an object');
      const rational = theoreticalSource as Record<string, unknown>;
      theoretical = {
        numerator: rational.numerator as bigint,
        denominator: rational.denominator as bigint,
      };
    }
    receipts.push({
      schema: entry.schema as Receipt['schema'],
      sequence: entry.sequence as number,
      kind: entry.kind as Receipt['kind'],
      line: entry.line as string,
      direction: entry.direction as Receipt['direction'],
      stage: entry.stage as number,
      amountUnits: entry.amountUnits as bigint,
      unitsHarvested: entry.unitsHarvested as number,
      resolved: entry.resolved as Receipt['resolved'],
      theoretical,
      capped: entry.capped as boolean,
      ...(terminal === undefined
        ? {}
        : { terminal: terminal as Receipt['terminal'] }),
    });
  }

  return frozenCopy({
    seedCommitment: source.seedCommitment as string,
    bodyCommitment: source.bodyCommitment as string,
    actionChain: source.actionChain as string,
    revealedSeed: source.revealedSeed as string,
    roundId: source.roundId as string,
    clientEntropy: source.clientEntropy as string,
    adapterFingerprint: source.adapterFingerprint as string,
    stakeUnits: source.stakeUnits as bigint,
    sideBetStakes,
    actionLog,
    populations,
    terminal: source.terminal as string,
    settlementMode: source.settlementMode as string,
    sideBetResults,
    receipts,
  });
}
