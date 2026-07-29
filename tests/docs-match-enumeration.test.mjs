import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractBlock, renderBlocks } from '../tools/lib/doctables.mjs';
import { buildPaytable } from '../tools/lib/report.mjs';
import { maximumRoundPayout, reachProbability, sideBets } from '../tools/lib/model.mjs';
import { structuralMaxMultiplier, organismValue, MAX_WIN_MULTIPLE } from '../tools/lib/config.mjs';
import { toDecimal, toOneIn } from '../tools/lib/rational.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

const math = read('docs/MATH.md');
const design = read('docs/DESIGN.md');
const engine = read('docs/ENGINE.md');
const readme = read('README.md');
const paytable = buildPaytable();
const blocks = renderBlocks(paytable);

describe('docs/MATH.md generated tables', () => {
  it('publishes every block the generator produces', () => {
    expect(Object.keys(blocks).length).toBeGreaterThanOrEqual(10);
  });

  for (const name of Object.keys(renderBlocks(paytable))) {
    it(`block "${name}" matches the enumeration byte for byte`, () => {
      expect(extractBlock(math, name)).toBe(blocks[name]);
    });
  }

  it('fails loudly when a block is missing', () => {
    expect(() => extractBlock('# nothing here', 'ladder')).toThrow(/Missing generated block/u);
  });
});

describe('prose numbers agree with the model', () => {
  it('README states the derived headline numbers', () => {
    expect(readme).toContain(`${toDecimal(maximumRoundPayout().multiplier, 2)}x`);
    expect(readme).toContain(`${toDecimal(structuralMaxMultiplier(), 2)}x`);
    expect(readme).toContain(`\`${MAX_WIN_MULTIPLE}x\``);
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

  it('DESIGN states the derived numbers it quotes', () => {
    expect(design).toContain(`${toDecimal(maximumRoundPayout().multiplier, 2)}x`);
    expect(design).toContain(`${MAX_WIN_MULTIPLE}x`);
    expect(design).toContain(paytable.totals.expectedGenerations.slice(0, 4));
    // Side-bet frequencies quoted in the bet-type table, trailing zeros trimmed.
    for (const bet of paytable.sideBets)
      expect(design, bet.id).toContain(`1 in ${bet.oneIn.replace(/\.?0+$/u, '')}`);
    // Generation-1 wipe rate, quoted as a percentage.
    expect(design).toContain('6.4%');
    // FULL BLOOM payout floors quoted from the ladder.
    expect(design).toContain(paytable.ladder[9].bloomFloor.slice(0, 5));
    expect(design).toContain(paytable.ladder[17].bloomFloor.slice(0, 6));
  });

  it('MATH states the derived structural numbers', () => {
    expect(math).toContain(String(paytable.totals.terminalCount));
    expect(math).toContain(String(paytable.proof.statesChecked));
    expect(math).toContain(String(paytable.proof.actionsChecked));
    expect(math).toContain(paytable.roundMaximum.multiplier);
    expect(math).toContain(paytable.structuralMaximum.multiplier);
  });

  it('ENGINE states the adapter constants it specifies', () => {
    expect(engine).toContain(`maxWinMultiple: ${MAX_WIN_MULTIPLE}n`);
    expect(engine).toContain('drawModulus: 20n');
    expect(engine).toContain('stages: 18');
    expect(engine).toContain('settleAtOrAbove: 16');
    expect(engine).toContain('maxUnits: 30');
    expect(engine).toContain('seedUnits: 3');
    expect(engine).toContain(`${paytable.config.drawGridSize}`);
  });
});

describe('documentation discipline', () => {
  const documents = { readme, math, design, engine };
  // A document may *cite* a banned phrase inside quotes or code spans (the
  // responsible-design section has to list the copy the game may not use);
  // it may not assert one in its own voice.
  const unquoted = (text) => text.replace(/"[^"]*"/gu, '""').replace(/`[^`]*`/gu, '``');

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

  it('keeps every document substantial and linked', () => {
    for (const [name, text] of Object.entries(documents))
      expect(text.length, name).toBeGreaterThan(4000);
    expect(readme).toContain('docs/DESIGN.md');
    expect(readme).toContain('docs/MATH.md');
    expect(readme).toContain('docs/ENGINE.md');
  });
});
