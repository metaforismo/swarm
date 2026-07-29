import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractBlock, renderBlocks } from '../tools/lib/doctables.mjs';
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
const documents = { readme, math, design, engine };
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
    expect(published.size).toBeGreaterThanOrEqual(15);
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

  it('keeps every document substantial and linked', () => {
    for (const [name, text] of Object.entries(documents))
      expect(text.length, name).toBeGreaterThan(4000);
    expect(readme).toContain('docs/DESIGN.md');
    expect(readme).toContain('docs/MATH.md');
    expect(readme).toContain('docs/ENGINE.md');
  });
});
