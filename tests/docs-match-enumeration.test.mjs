import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PATH, extractBlock, renderBlocks } from '../tools/lib/doctables.mjs';
import { DOCUMENTS, applyBlocks } from '../tools/syncdocs.mjs';
import { buildPaytable } from '../tools/lib/report.mjs';
import {
  bloomPayoutProfile,
  extremalRoundVariance,
  maximumRoundPayout,
  peakBand,
  reachProbability,
  sideBets,
} from '../tools/lib/model.mjs';
import {
  ABANDONED_ROUND_TIMEOUT_HOURS,
  BLOOM_THRESHOLD,
  COLONY_MAX_WIN_MULTIPLE,
  SIDE_BET_MAX_WIN_MULTIPLES,
  structuralMaxMultiplier,
  organismValue,
} from '../tools/lib/config.mjs';
import { toDecimal, toOneIn, toSqrtDecimal } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

const math = read('docs/MATH.md');
const design = read('docs/DESIGN.md');
const engine = read('docs/ENGINE.md');
const readme = read('README.md');
const decisions = read('docs/DECISIONS.md');
const documents = { readme, math, design, engine, decisions };
/** Markdown hard-wraps sentences, so prose assertions run on a single line. */
const flat = (text) => text.replace(/\s+/gu, ' ');
const paytable = buildPaytable();
const blocks = renderBlocks(paytable);

const MARKER = /<!-- generated:([a-z][a-z0-9-]*) -->/gu;
const blocksIn = (text) => [...text.matchAll(MARKER)].map((match) => match[1]);

describe('generated tables', () => {
  it('publishes every block the generator produces, somewhere', () => {
    const published = new Set(Object.values(documents).flatMap(blocksIn));
    expect([...Object.keys(blocks)].sort()).toEqual([...published].sort());
    expect(published.size).toBeGreaterThanOrEqual(23);
  });

  for (const [name, text] of Object.entries(documents))
    for (const block of blocksIn(text))
      it(`${name}: block "${block}" matches the enumeration byte for byte`, () => {
        expect(extractBlock(text, block)).toBe(blocks[block]);
      });

  it('fails loudly when a block is missing', () => {
    expect(() => extractBlock('# nothing here', 'ladder')).toThrow(/Missing generated block/u);
  });

  it('rejects a document that references an unknown block', () => {
    expect(() =>
      applyBlocks('<!-- generated:invented -->\nx\n<!-- /generated:invented -->', blocks, 'test.md'),
    ).toThrow(/unknown generated block/u);
  });

  it('rewrites a stale block in place and reports it', () => {
    const stale = '<!-- generated:risk -->\nold and wrong\n<!-- /generated:risk -->';
    const { updated, seen } = applyBlocks(stale, blocks);
    expect(seen).toEqual([{ name: 'risk', stale: true }]);
    expect(updated).toContain(blocks.risk);
    expect(applyBlocks(updated, blocks).seen).toEqual([{ name: 'risk', stale: false }]);
  });

  it('covers every document the sync tool knows about', () => {
    expect(DOCUMENTS.sort()).toEqual(
      ['README.md', 'docs/DESIGN.md', 'docs/ENGINE.md', 'docs/MATH.md'].sort(),
    );
  });
});

describe('prose numbers agree with the model', () => {
  it('README states the derived headline numbers', () => {
    expect(readme).toContain(`${toDecimal(maximumRoundPayout().multiplier, 2)}x`);
    expect(readme).toContain(`${toDecimal(structuralMaxMultiplier(), 2)}x`);
    expect(readme).toContain(`\`${COLONY_MAX_WIN_MULTIPLE}x\``);
    expect(readme).toContain(toDecimal(organismValue(1), 4));
    expect(readme).toContain(toDecimal(organismValue(18), 2));
    expect(readme).toContain(toOneIn(reachProbability(4), 2));
    expect(readme).toContain(paytable.totals.expectedGenerations.slice(0, 4));
    const bloomOneIn = Math.round(Number(paytable.terminalCategories.BLOOM.oneIn));
    expect(readme).toContain(bloomOneIn.toLocaleString('en-US'));
    for (const bet of sideBets()) {
      const shortest = toDecimal(bet.multiplier, 3).replace(/0+$/u, '').replace(/\.$/u, '');
      expect(readme, bet.id).toContain(shortest);
    }
  });

  it('README publishes the proven volatility interval, not a sampled range', () => {
    const minimum = toSqrtDecimal(extremalRoundVariance('min').variance, 6);
    const maximum = toSqrtDecimal(extremalRoundVariance('max').variance, 6);
    expect(readme).toContain(minimum);
    expect(readme).toContain(maximum);
    expect(readme).toMatch(/[Pp]roven interval/u);
    // The old copy quoted RUN's standard deviation as if it were the maximum.
    const run = paytable.policies.find((policy) => policy.id === 'RUN');
    expect(maximum).not.toBe(run.standardDeviation);
  });

  it('README leads with the profit rate, not the hit rate', () => {
    const bankFirst = paytable.policies.find((policy) => policy.id === 'BANK_FIRST');
    const percent = (value) => `${(Number(value) * 100).toFixed(2)}%`;
    expect(readme).toContain(percent(bankFirst.profitRate));
    expect(readme).toMatch(/return > stake|P\(return > stake\)/u);
  });

  it('README publishes how often a round returns less than the stake', () => {
    const percent = (value) => `${(Number(value) * 100).toFixed(2)}%`;
    const settlement = paytable.presentation.settlement;
    for (const id of ['BANK_FIRST', 'HALF_EVERY']) {
      const row = settlement.find((entry) => entry.id === id);
      expect(readme, id).toContain(percent(row.belowStake));
    }
    expect(flat(readme)).toMatch(/less than you staked/iu);
  });

  it('DESIGN states the derived numbers it quotes', () => {
    expect(design).toContain(`${toDecimal(maximumRoundPayout().multiplier, 2)}x`);
    expect(design).toContain(`${COLONY_MAX_WIN_MULTIPLE}x`);
    expect(design).toContain(paytable.totals.expectedGenerations.slice(0, 4));
    for (const bet of paytable.sideBets) {
      expect(design, bet.id).toContain(`1 in ${bet.oneIn.replace(/\.?0+$/u, '')}`);
      expect(design, bet.id).toContain(`${bet.capMultiple}x`);
    }
    expect(design).toContain('6.4%');
    // FULL BLOOM payout floors quoted from the ladder.
    expect(design).toContain(paytable.ladder[9].bloomFloor.slice(0, 5));
    expect(design).toContain(paytable.ladder[17].bloomFloor.slice(0, 6));
    // The near-miss band, not the reach probability it used to be confused with.
    const grouped = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
    expect(design).toContain(grouped(toOneIn(peakBand(12, BLOOM_THRESHOLD), 0)));
    expect(design).not.toContain(`1 in ${grouped(toOneIn(reachProbability(12), 0))} rounds`);
  });

  it('DESIGN quotes the real FULL BLOOM range, not only the flattering end', () => {
    const bloom = bloomPayoutProfile();
    expect(design).toContain(toDecimal(bloom.smallest, 2));
    expect(design).toContain(toDecimal(bloom.largest, 2));
  });

  it('MATH states the derived structural numbers', () => {
    expect(math).toContain(String(paytable.totals.terminalCount));
    expect(math).toContain(String(paytable.proof.statesChecked));
    expect(math).toContain(String(paytable.proof.actionsChecked));
    expect(math).toContain(paytable.roundMaximum.multiplier);
    expect(math).toContain(paytable.structuralMaximum.multiplier);
    expect(math).toContain(paytable.underwater.afterGenerationOne);
    expect(math).toContain(paytable.roundingBound.relativeAtMinimumStake);
  });

  it('ENGINE states the adapter constants it specifies', () => {
    expect(engine).toContain(`colonyMaxWinMultiple: ${COLONY_MAX_WIN_MULTIPLE}n`);
    expect(engine).toContain('drawModulus: 20n');
    expect(engine).toContain('stages: 18');
    expect(engine).toContain('settleAtOrAbove: 16');
    expect(engine).toContain('maxUnits: 30');
    expect(engine).toContain('seedUnits: 3');
    expect(engine).toContain(`${paytable.config.drawGridSize}`);
    for (const [id, cap] of Object.entries(SIDE_BET_MAX_WIN_MULTIPLES)) {
      expect(engine, id).toContain(`id: '${id}'`);
      expect(engine, id).toContain(`maxWinMultiple: ${cap}n`);
    }
    expect(engine).toContain(`abandonedRoundTimeoutHours: ${ABANDONED_ROUND_TIMEOUT_HOURS}`);
  });

  it('publishes the strict payable bound and no unsupported snapshot contract', () => {
    const oneLineEngine = flat(engine);
    expect(oneLineEngine).toMatch(
      /0 <= sum\(x_i\) - sum\(floor\(x_i\)\) < m minor units/u,
    );
    expect(oneLineEngine).toMatch(
      /strictly less than 18 units = 0\.000018 credits/u,
    );
    expect(oneLineEngine).toMatch(
      /less than `1\.8e-4` of stake, or 0\.018 percentage points of RTP/u,
    );
    expect(oneLineEngine).toMatch(
      /exposes neither `snapshot\(\)` nor `restore\(\)`/u,
    );
    expect(engine).not.toContain('snapshot(): StageBookSnapshot');
    expect(engine).not.toContain('static restore(game: StagedSurvivalDefinition');
  });
});

describe('documentation discipline', () => {
  // A document may *cite* a banned phrase inside quotes or code spans (the
  // responsible-design section has to list the copy the game may not use);
  // it may not assert one in its own voice.
  const unquoted = (text) =>
    text.replace(/"[^"]*"/gu, '""').replace(/`[^`]*`/gu, '``').replace(/\*"[^"]*"\*/gu, '""');

  it('never claims a certification it does not have', () => {
    const forbidden = [
      /\b(?:is|are|has been|have been|fully) certified\b/iu,
      /\bcertification (?:granted|obtained|complete)\b/iu,
      /\bguarantee/iu,
      /\bapproved by\b/iu,
      /\bprovably fair certificate\b/iu,
      /\bregulator(?:y|ily) (?:approved|cleared)\b/iu,
    ];
    for (const [name, text] of Object.entries(documents))
      for (const pattern of forbidden)
        expect(pattern.test(unquoted(text)), `${name} matches ${pattern}`).toBe(false);
  });

  it('states the certification boundary explicitly', () => {
    expect(math).toMatch(/not a certification|No RNG certification/u);
    expect(readme).toMatch(/Not an RNG certificate/u);
    expect(engine).toMatch(/does not exist in Reveal Engine 0\.2/u);
  });

  it('never frames play as skill or loss recovery', () => {
    const forbidden = [
      /\bwin it back\b/iu,
      /\brecover your\b/iu,
      /\bbeat the game\b/iu,
      /\bskill-based\b/iu,
      /\bwinning strategy\b/iu,
      /\boptimal strategy pays\b/iu,
    ];
    for (const [name, text] of Object.entries(documents))
      for (const pattern of forbidden)
        expect(pattern.test(unquoted(text)), `${name} matches ${pattern}`).toBe(false);
  });

  it('never claims market novelty in its own voice', () => {
    // The Round 1 pitch asserted "the mechanic no crash game has" with no
    // competitive evidence behind it. Any novelty claim now has to be scoped.
    const forbidden = [
      /\bno crash (?:game|title)s? (?:has|have|offers?)\b/iu,
      /\bthe (?:only|first) (?:game|title) (?:that|to)\b/iu,
      /\bnobody else (?:has|does|offers)\b/iu,
    ];
    for (const [name, text] of Object.entries(documents))
      for (const pattern of forbidden)
        expect(pattern.test(unquoted(text)), `${name} matches ${pattern}`).toBe(false);
    expect(flat(design)).toMatch(/not a commissioned competitive audit/u);
  });

  it('addresses the states the model proves the player will be in', () => {
    // Round 1 was silent on all four of these, and each is load-bearing.
    expect(design).toMatch(/underwater/iu);
    expect(design).toMatch(/below (?:the|your) stake/iu);
    expect(design).toMatch(/break[- ]even/iu);
    expect(design).toMatch(/profit rate/iu);
    expect(math).toMatch(/not monotone/iu);
    expect(engine).toMatch(/[Aa]bandoned rounds?/u);
    expect(engine).toMatch(/RECONCILED/u);
  });

  it('keeps the feedback rule keyed to money rather than to events', () => {
    expect(design).toMatch(/signed value change/iu);
    // The Round 1 rule made splits "always the loudest thing on screen".
    expect(design).not.toMatch(/[Ss]plits are always the loudest/u);
    expect(design).toMatch(/verdict/iu);
  });

  // -------------------------------------------------------------------------
  // Regression guards for the round-2 findings. Each of these was a real defect
  // that no test could see, so each gets a test that would have seen it.
  // -------------------------------------------------------------------------

  it('splits the settlement ceremony on the stake, not only on 2x', () => {
    // BLOCKER: tier T0 spanned X < 2, so a 0.40x return and a 1.90x win got the
    // same balance-chip count-up. That is the most common outcome class in the
    // game (48.00% of BANK_FIRST rounds) presented as a win.
    const settlement = paytable.presentation.settlement;
    const bankFirst = settlement.find((row) => row.id === 'BANK_FIRST');
    expect(design).toMatch(/T0-loss/u);
    expect(design).toMatch(/T0-win/u);
    expect(flat(design)).toMatch(/no count-up into the balance chip/iu);
    expect(flat(design)).toMatch(/signed net result/iu);
    // The frequency must be published, not merely alluded to.
    const percent = (value) => `${(Number(value) * 100).toFixed(2)}%`;
    expect(design).toContain(percent(bankFirst.belowStake));
    // And the boundary has to be the one MATH proves is unambiguous.
    expect(math).toMatch(/never settle at exactly one stake/iu);
  });

  it('binds the action log with a settlement-time body commitment', () => {
    // BLOCKER: a choice-timed round shipped a single-phase commitment, so the
    // action log was an unverified input to its own verifier.
    expect(flat(engine)).toMatch(/two-phase/iu);
    expect(engine).toContain(paytable.proofSurface.seedCommitmentVersion);
    expect(engine).toContain(paytable.proofSurface.bodyCommitmentVersion);
    expect(flat(engine)).toMatch(/settlement body commitment/iu);
    // The verifier must re-derive the body, not accept it.
    expect(flat(engine)).toMatch(/Re-seal the \*\*settlement body commitment\*\*/u);
    expect(flat(readme)).toMatch(/two-phase commit-reveal/iu);
    // The round-2 defence may be *quoted* while explaining why it was wrong, but
    // the document must not assert it in its own voice.
    expect(unquoted(flat(engine))).not.toMatch(
      /action log is bound separately by the receipt ledger and the frame fence/iu,
    );
  });

  it('discloses seed grinding and ships client entropy', () => {
    for (const [name, text] of Object.entries({ readme, math, engine }))
      expect(flat(text), name).toMatch(/client entropy|client seed/iu);
    expect(flat(math)).toMatch(/how that seed was chosen/iu);
    expect(flat(engine)).toMatch(/grind/iu);
    expect(flat(readme)).toMatch(/What this does not prove/u);
    // The exposure is specific to SWARM and the number is stated.
    expect(engine).toContain('(2/5)^3 = 0.064');
  });

  it('specifies the lifecycle states and the full-bank path', () => {
    for (const state of ['IDLE', 'STAGED', 'AWAITING_SETTLEMENT', 'SETTLED'])
      expect(engine, state).toContain(state);
    // The round-2 diagram transitioned into a state it never declared.
    expect(engine).not.toMatch(/\bRESOLVED\b/u);
    expect(flat(engine)).toMatch(/`settle\(\)` is required on every path/u);
    // A full bank is a terminal with its own row, not an implication.
    expect(flat(engine)).toMatch(/full BANK.*?`BANKED`.*?`AWAITING_SETTLEMENT`/u);
  });

  it('replaces the in-round harvest plan with a stepper, and says why', () => {
    // The presets may be *named* in the paragraph that cuts them; they may not
    // be offered.
    for (const gone of ['RIDE TO 18', 'HARVEST HALF EVERY GENERATION', 'BANK AT 2x'])
      expect(unquoted(design), gone).not.toContain(gone);
    expect(flat(design)).toMatch(/no harvest plan and no in-round auto-play/iu);
    expect(flat(design)).toMatch(/stepper/iu);
    // MATH publishes a volatility maximum at k = 1, so the client must reach it.
    expect(flat(math)).toMatch(/client can reach both ends/iu);
    expect(engine).toContain("clientQuantum: 'any'");
  });

  it('keys the verdict bands to money, and proves every note reachable', () => {
    expect(flat(design)).toMatch(/stake multiples/iu);
    expect(flat(design)).toMatch(/R5 — Reachable/u);
    expect(flat(math)).toMatch(/structurally unreachable/iu);
    // The exact claim the round-2 text made, which was false.
    expect(design).not.toMatch(/every organism in the colony splits at once/u);
    const top = paytable.presentation.chord.ladder.at(-1);
    expect(design).toContain(top.thresholdDecimal.replace(/0+$/u, ''));
    expect(math).toContain(top.oneInBeats);
  });

  it('gives a live side bet in-round feedback within the proven bound', () => {
    expect(flat(design)).toMatch(/wild-line ghost/iu);
    expect(flat(design)).toMatch(/PEAK 7 \/ 10|peak so far/iu);
    // The rule must be the one-generation-lagged one, not the blanket ban.
    expect(flat(math)).toMatch(/what is safe/iu);
    expect(flat(math)).toMatch(/what is not/iu);
    expect(flat(engine)).toMatch(/wildUnits/u);
    expect(flat(design)).not.toMatch(
      /Nothing about the wild line — not a count, not a hint/u,
    );
  });

  it('states the shared-ceiling frequency against the right scenario', () => {
    const shared = paytable.risk.sharedCeilingCounterfactual;
    expect(math).toContain(shared.colonyThresholdDecimal);
    expect(math).toContain(shared.bindingProbabilityBound);
    expect(math).toContain(String(shared.minimumPeakPopulation));
    // The exact wrong sentence from round 2, which attached P(SWARM wins) to the
    // equal-stake bind, must be gone.
    expect(flat(math)).not.toMatch(
      /it would bind on a `1 in 261\.89` event, not a tail event/u,
    );
    // And the document must say where that frequency actually belongs.
    expect(flat(math)).toMatch(/On unequal stakes it is not rare at all/u);
  });

  it('makes the colony layout buildable', () => {
    const { layout } = paytable.presentation;
    expect(flat(design)).toMatch(/rho_i\s*=\s*R\(n\) \* sqrt\(i \/ n\)/u);
    expect(design).toContain(`\`n = ${layout.firstClampedPopulation}\``);
    // The round-2 text gave one radius per population and called it a spiral.
    expect(flat(design)).toMatch(/which is a ring/iu);
  });

  it('specifies the signature visual with the same rigour as the rest of §6', () => {
    for (const marker of ['silt', 'plankton', 'roughness', 'parallax', 'Asset list'])
      expect(design, marker).toMatch(new RegExp(marker, 'iu'));
    // Beat table, camera note and a bounded asset count, not two sentences.
    expect(flat(design)).toMatch(/Camera and composition/u);
    expect(flat(design)).toMatch(/dollies back \*\*8%\*\*/u);
  });

  // -------------------------------------------------------------------------
  // Regression guards for the round-4 findings. Same discipline as above: each
  // was a real defect nothing could see, so each gets a test that can.
  // -------------------------------------------------------------------------

  it('never publishes the FULL BLOOM frequency without the play pattern it belongs to', () => {
    // BLOCKER: the headline frequency is the never-harvest one, and it is
    // exactly zero under the client's own one-tap default harvest.
    const run = paytable.policies.find((policy) => policy.id === 'RUN');
    const grouped = Math.round(Number(run.bloomOneIn)).toLocaleString('en-US');
    const qualifier = /RUN|never[- ]harvest|play pattern|wild line|policy/iu;
    for (const [name, text] of Object.entries(documents)) {
      const flattened = flat(text);
      for (const needle of [run.bloomOneIn, grouped]) {
        let cursor = flattened.indexOf(needle);
        while (cursor !== -1) {
          const window = flattened.slice(Math.max(0, cursor - 320), cursor + 320);
          expect(qualifier.test(window), `${name}: unqualified "${needle}" near ...${window}...`).toBe(
            true,
          );
          cursor = flattened.indexOf(needle, cursor + 1);
        }
      }
    }
    // And the zero is published, not merely implied.
    expect(paytable.policies.find((policy) => policy.id === 'HALF_EVERY').bloomOneIn).toBe('never');
    expect(flat(math)).toMatch(/unreachable — not rare, unreachable|not rare, unreachable/u);
    expect(flat(design)).toMatch(/never appears without the play pattern/iu);
  });

  it('makes one harvest commitment per stage a rule in all three documents', () => {
    // BLOCKER: a legal command sequence produced a round the verifier refused.
    expect(engine).toContain('commitsPerStage');
    expect(flat(engine)).toMatch(/One harvest commitment per stage/u);
    expect(flat(engine)).toMatch(/decisionOpen/u);
    expect(flat(math)).toMatch(/One `k` per generation/u);
    // The client may not offer a control the protocol would refuse.
    expect(flat(design)).toMatch(/collapses to `NEXT`/u);
    // And the reason it costs nothing has to be stated, not assumed.
    expect(flat(math)).toMatch(/floor\(x\) \+ floor\(y\)/u);
    expect(flat(engine)).toMatch(/floor\(x\) \+ floor\(y\)/u);
  });

  it('derives the floor-rounding bound and prices the alternative', () => {
    // BLOCKER: "absolute bound: 18" was true only under a rule nothing enforced.
    const bound = paytable.roundingBound;
    expect(math).toContain(String(bound.maximumCreditEvents));
    expect(math).toContain(String(bound.maximumCreditEventsIfStagesAcceptedRepeatedHarvests));
    expect(flat(math)).toMatch(/computed, not asserted|dynamic program/iu);
    // The old sentence claimed an absolute bound with no protocol behind it.
    expect(flat(math)).not.toMatch(/\*\*Absolute bound:\*\* `18` units/u);
    expect(readme).toContain(String(bound.maximumCreditEvents));
  });

  it('defines a settlement for a round abandoned before anything resolved', () => {
    // BLOCKER: stage 0 is a STAGED state the 72-hour trigger covers, and the
    // ladder has no value there.
    expect(flat(engine)).toMatch(/Action, at stage 0/u);
    expect(flat(engine)).toMatch(/no ladder value/iu);
    expect(flat(engine)).toMatch(/Why not a void/u);
    // The trigger must reach both live states, not only STAGED.
    expect(flat(engine)).toMatch(/not yet `SETTLED`/u);
    expect(flat(engine)).toMatch(/starts at the `open\(\)`/u);
    // The claim that motivated all of it must still be made, and now be true.
    expect(flat(engine)).toMatch(/no state in which a committed seed can never be published/u);
    expect(flat(design)).toMatch(/before its first tap/u);
  });

  it('keys the environment reveal to value and publishes how often it fires', () => {
    // MAJOR: the reveal claimed to be a consequence of the exposure curve while
    // firing on a population event the curve cannot distinguish.
    const environment = paytable.presentation.environment;
    expect(design).toContain(environment.thresholdDecimal);
    expect(design).toContain(environment.threshold);
    expect(flat(design)).toMatch(/not a bloom effect|it is not a bloom effect/iu);
    // The old claim, which was false, must be gone from the document's voice.
    expect(unquoted(flat(design))).not.toMatch(/It is unique and stays unique/u);
    expect(unquoted(flat(design))).not.toMatch(/Nothing is switched on\. The environment was always/u);
    // The frequency comparison is published, per policy.
    const run = environment.policies.find((row) => row.policy === 'RUN');
    expect(design).toContain(run.reachOneIn);
  });

  it('runs the wild-line ghost past the responsible-design rules', () => {
    // MAJOR: a permanent counterfactual colony was specified in §4 and never
    // evaluated in §9.
    expect(flat(design)).toMatch(/### 9\.8/u);
    expect(flat(design)).toMatch(/the persistent ghost is cut/iu);
    expect(flat(design)).toMatch(/state of a bet the player has placed/iu);
    // It may still exist as a teaching beat, so the ban has to be specific.
    expect(flat(design)).toMatch(/400 ms/u);
  });

  it('applies the feedback doctrine to the harvest beat', () => {
    // MAJOR: the loudest beat in the game fired on a pathwise wealth-neutral
    // event, and R1 was scoped so it never reached it.
    expect(flat(design)).toMatch(/R6 — A transfer is not a gain/u);
    expect(flat(design)).toMatch(/perverse incentive/iu);
    // The round-3 treatment, by name.
    expect(unquoted(flat(design))).not.toMatch(/granular amber pour, 400 ms, ending in a soft click/u);
    expect(unquoted(flat(design))).not.toMatch(/spiral into the balance chip as amber particles/u);
  });

  it('publishes ticket-level profit rates for the pairings it flags', () => {
    // MAJOR: §9.4 defended a pairing with an RTP, and §9.3 makes the profit rate
    // the binding figure.
    const banked = paytable.ticketPairings.find(
      (row) => row.policy === 'BANK_FIRST' && row.sideBet === 'DARK_VENT',
    );
    expect(math).toContain(banked.ticketProfitRate);
    expect(design).toContain(banked.ticketProfitRate);
    expect(readme).toMatch(/36\.09%|0\.3608881499/u);
    expect(flat(design)).toMatch(/profit rate of a ticket is\s*not the average of its lines/iu);
    expect(flat(math)).toMatch(/The profit rate is not linear/u);
  });

  it('sets a speed-of-play floor and an input guard', () => {
    // MAJOR: every beat was skippable and no cycle floor existed.
    expect(flat(design)).toMatch(/### 9\.7 Speed of play/u);
    expect(design).toContain('2,500 ms');
    expect(design).toContain('350 ms');
    expect(flat(design)).toMatch(/Skipping buys the resolved state, not the next decision/u);
    expect(flat(design)).toMatch(/No turbo, no quick-spin/u);
  });

  it('keeps the rounding qualifier in the client copy', () => {
    // MAJOR: MATH is careful that "theoretical" is doing work; three mandated
    // copy strings dropped it and became false as absolute statements.
    // Only the mandated copy strings, which always name the percentage; prose
    // *about* the claim is allowed to quote it in order to correct it.
    const claims = [...flat(design).matchAll(/returns the same 95%[^."]*/gu)].map(
      (match) => match[0],
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims)
      expect(claim, claim).toMatch(/before rounding|to within|rounded down/u);
    expect(flat(design)).toMatch(/same expected return, before rounding/u);
    expect(flat(design)).toMatch(/rounded down to the nearest 0\.000001/u);
    expect(flat(design)).toMatch(/The rounding sentence is mandatory/u);
  });

  it('points at a fixture that exists', () => {
    // MINOR: the one pointer for the two values MATH elides named a file that
    // was never in the repository.
    for (const [name, text] of Object.entries(documents))
      expect(text, name).not.toMatch(/paytable\.v2\.json/u);
    expect(math).toContain(FIXTURE_PATH);
    expect(existsSync(`${root}${FIXTURE_PATH}`)).toBe(true);
  });

  it('specifies a first-time experience and keeps it out of a live round', () => {
    // MINOR: no onboarding was specified anywhere, for the game's largest
    // comprehension risk.
    expect(flat(design)).toMatch(/S0 — First round only/u);
    expect(flat(design)).toMatch(/shown before a round, never during one and never after a loss/u);
    expect(flat(design)).toMatch(/not a demo round/iu);
  });

  it('states the organism size in the same unit as the layout table', () => {
    // MINOR: §6.2 gave a px range against a pt layout table, and the two did not
    // even cover the same interval.
    const { layout } = paytable.presentation;
    expect(design).toContain(`${layout.bodyDiameterMin} to ${layout.bodyDiameterMax} pt`);
    expect(unquoted(flat(design))).not.toMatch(/40–70 px/u);
  });

  it('reconciles the one forward-looking number on the play surface', () => {
    // MINOR: the decision panel volunteers the next generation's yield, against
    // a rule that bans showing the way back.
    expect(flat(design)).toMatch(/The one forward-looking number, and why it is allowed/u);
    expect(flat(design)).toMatch(/never multiplied by the current population/iu);
  });

  it('keeps every document substantial and linked', () => {
    for (const [name, text] of Object.entries(documents))
      expect(text.length, name).toBeGreaterThan(4000);
    expect(readme).toContain('docs/DESIGN.md');
    expect(readme).toContain('docs/MATH.md');
    expect(readme).toContain('docs/ENGINE.md');
  });
});
