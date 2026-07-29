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
import { SETTLEMENT_MODES, publishedTerminal, seedCommitment, type SettlementMode } from './commitment.ts';
import {
  deriveGrid,
  replayRound,
  roundContext,
  wildLineOf,
  actionKind,
  type LoggedAction,
} from './derivation.ts';
import { constantTimeHexEqual, normalizeSeed } from './engine.ts';
import { sealSettlement, type Receipt } from './settlement.ts';

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
  const pass = (detail: string): void => {
    steps.push({ step: cursor + 1, name: STEP_NAMES[cursor] as string, ok: true, detail });
    cursor += 1;
  };
  const stop = (code: string, detail: string): VerificationResult => {
    steps.push({ step: cursor + 1, name: STEP_NAMES[cursor] as string, ok: false, detail });
    return { ok: false, code, detail, steps: Object.freeze(steps) };
  };

  try {
    if (typeof proof !== 'object' || proof === null)
      return stop('INVALID_TRANSCRIPT', 'not an object');

    // 1. Definition identity.
    if (proof.adapterFingerprint !== adapterFingerprint())
      return stop('ADAPTER_MISMATCH', 'adapter fingerprint does not match this build');
    pass(`${SWARM.id} @ ${SWARM.adapterVersion} — ${adapterFingerprint()}`);

    const context = roundContext(proof.roundId, proof.clientEntropy);
    const seed = normalizeSeed(proof.revealedSeed);

    // 2. Phase 1 must re-derive from the revealed seed, compared in constant time.
    const phaseOne = seedCommitment(seed, context.roundId);
    if (!constantTimeHexEqual(phaseOne, proof.seedCommitment))
      return stop('COMMITMENT_MISMATCH', 'seed pre-commitment does not re-derive');
    pass(phaseOne);

    const settlementMode = proof.settlementMode as SettlementMode;
    if (!SETTLEMENT_MODES.includes(settlementMode))
      return stop('INVALID_TRANSCRIPT', 'unknown settlement mode');

    // 3. Replay the grid using the submitted action log and nothing else. A log
    //    that is out of order, short, long, mislabelled, that harvests more than
    //    the stage held, or that carries two entries for one stage, is refused.
    const log = proof.actionLog;
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
      !Array.isArray(proof.populations) ||
      proof.populations.length !== populations.length ||
      proof.populations.some((value, at) => value !== populations[at])
    )
      return stop('TRANSCRIPT_MISMATCH', 'resolved populations do not re-derive');
    if (proof.terminal !== publishedTerminal(replay.reason, settlementMode))
      return stop('TRANSCRIPT_MISMATCH', 'terminal reason does not re-derive');
    pass(
      `${populations.length} generation(s), terminal ${proof.terminal} (${settlementMode}), populations ${populations.join(' → ')}`,
    );

    // 4 and 5. Recompute the whole per-line ledger, including the side bets,
    //          through the same sealing path a settlement was produced by.
    const receipts = proof.receipts;
    if (!Array.isArray(receipts)) return stop('INVALID_TRANSCRIPT', 'missing receipt ledger');
    const wild = wildLineOf(grid);
    const expected = sealSettlement({
      seedHex: seed,
      context,
      seedCommitment: phaseOne,
      stakeUnits: proof.stakeUnits,
      sideBetStakes: proof.sideBetStakes ?? {},
      round: replay,
      wild,
      settlementMode,
    });
    if (receipts.length !== expected.receipts.length)
      return stop('TRANSCRIPT_MISMATCH', 'receipt count does not re-derive');
    const mismatch = (at: number): boolean => {
      const actual = receipts[at] as Receipt;
      const want = expected.receipts[at] as Receipt;
      return (
        actual.sequence !== want.sequence ||
        actual.kind !== want.kind ||
        actual.line !== want.line ||
        actual.direction !== want.direction ||
        actual.stage !== want.stage ||
        actual.amountUnits !== want.amountUnits
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
    for (const result of proof.sideBetResults ?? []) {
      const want = expected.proof.sideBetResults.find((entry) => entry.id === result.id);
      if (want === undefined) return stop('TRANSCRIPT_MISMATCH', `unknown side bet ${result.id}`);
      if (result.resolved !== want.resolved)
        return stop('TRANSCRIPT_MISMATCH', `side bet ${result.id} does not re-derive`);
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
    if (!constantTimeHexEqual(expected.proof.actionChain, proof.actionChain))
      return stop('COMMITMENT_MISMATCH', 'action chain does not re-derive');
    pass(expected.proof.actionChain);

    if (!constantTimeHexEqual(expected.proof.bodyCommitment, proof.bodyCommitment))
      return stop('COMMITMENT_MISMATCH', 'settlement body does not re-derive');
    pass(expected.proof.bodyCommitment);

    return {
      ok: true,
      code: 'VERIFIED',
      detail: 'every credit on every line re-derives from the revealed seed and the action log',
      steps: Object.freeze(steps),
      seedCommitment: phaseOne,
      bodyCommitment: expected.proof.bodyCommitment,
    };
  } catch (error) {
    return stop('DERIVATION_FAILED', error instanceof Error ? error.message : 'unknown');
  }
}
