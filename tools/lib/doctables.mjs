/**
 * Renders the generated blocks that appear inside docs/MATH.md.
 *
 * docs/MATH.md is hand-written prose wrapped around machine-generated tables.
 * Every table lives between `<!-- generated:<name> -->` and
 * `<!-- /generated:<name> -->` markers and is compared, byte for byte, against
 * the output of this module by `tests/docs-match-enumeration.test.mjs`. If a
 * number in the documentation ever disagrees with the enumeration, the test
 * suite fails; the documentation cannot rot.
 *
 * Long exact values (the SWARM side bet probability is a 200-digit fraction)
 * are published as a SHA-256 digest of the canonical `numerator/denominator`
 * string plus a truncated decimal. The full exact value is in
 * `spec/paytable.v1.json`.
 */

import { digest } from './canonical.mjs';
import { buildPaytable } from './report.mjs';

/** Values longer than this are published as digest + decimal instead of inline. */
export const INLINE_FRACTION_LIMIT = 44;

export function fractionCell(fraction) {
  if (typeof fraction !== 'string') throw new Error('fraction must be a string');
  if (fraction.length <= INLINE_FRACTION_LIMIT) return `\`${fraction}\``;
  return `sha256 \`${digest(fraction).slice(0, 16)}\``;
}

function table(header, rows) {
  const separator = header.map(() => '---');
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function renderBlocks(paytable = buildPaytable()) {
  const blocks = {};

  blocks.offspring = table(
    ['Outcome', 'Children', 'Draw band', 'Probability', 'Percent'],
    paytable.config.offspring.map((outcome) => [
      `**${outcome.id}**`,
      String(outcome.children),
      `\`${outcome.drawBand}\``,
      `\`${outcome.probability}\``,
      `${outcome.percent}%`,
    ]),
  );

  blocks.ladder = table(
    ['Generation', 'Organism value `c(t)` (exact)', 'Decimal', 'Colony of 3', 'Colony of 16'],
    paytable.ladder.map((row) => [
      String(row.generation),
      `\`${row.organismValue}\``,
      row.decimal,
      row.colonyOfThree,
      row.bloomFloor,
    ]),
  );

  blocks['generation-one'] = table(
    ['Population', 'Probability (exact)', 'Percent', 'Colony multiplier (exact)', 'Decimal'],
    paytable.generationOne.map((row) => [
      String(row.population),
      `\`${row.probability}\``,
      `${row.percent}%`,
      `\`${row.multiplier}\``,
      row.multiplierDecimal,
    ]),
  );

  blocks.survival = table(
    ['After generation', 'P(colony alive)'],
    paytable.survival.map((row) => [String(row.generation), row.decimal]),
  );

  blocks.categories = table(
    ['Terminal', 'Probability', 'Meaning'],
    [
      ['EXTINCT', paytable.terminalCategories.EXTINCT.decimal, 'Every organism died; unharvested value is zero'],
      [
        'BLOOM',
        `${paytable.terminalCategories.BLOOM.decimal} (1 in ${paytable.terminalCategories.BLOOM.oneIn})`,
        'Population reached the FULL BLOOM threshold and force-settled',
      ],
      ['FINAL', paytable.terminalCategories.FINAL.decimal, 'Colony survived to the last generation and force-settled'],
    ],
  );

  blocks.tail = table(
    ['Payout at least', 'Probability', 'One in'],
    paytable.tail.map((row) => [`${row.threshold}x`, row.scientific, row.oneIn]),
  );

  blocks.reach = table(
    ['Peak population at least', 'Probability', 'One in'],
    paytable.reach.map((row) => [String(row.threshold), row.scientific, row.oneIn]),
  );

  blocks.policies = table(
    ['Policy', 'Exact RTP', 'Standard deviation', 'Hit rate', 'Description'],
    paytable.policies.map((row) => [
      `\`${row.id}\``,
      `\`${row.rtp}\``,
      row.standardDeviation,
      row.hitRate,
      row.label,
    ]),
  );

  blocks.sidebets = table(
    ['Bet', 'Resolves on', 'Probability', 'One in', 'Multiplier (exact)', 'Multiplier', 'RTP'],
    paytable.sideBets.map((row) => [
      `**${row.label}**`,
      row.description,
      fractionCell(row.probability),
      row.oneIn,
      fractionCell(row.multiplier),
      `${row.multiplierDecimal}x`,
      `\`${row.rtp}\``,
    ]),
  );

  blocks.headline = table(
    ['Quantity', 'Exact value'],
    [
      ['Target RTP, every bet type', `\`${paytable.totals.rtp}\` = ${paytable.config.targetRtpPercent}%`],
      ['Total probability mass', `\`${paytable.totals.probabilityMass}\``],
      ['Terminal states enumerated', String(paytable.totals.terminalCount)],
      ['Decision states proven', String(paytable.proof.statesChecked)],
      ['Actions proven to tie', String(paytable.proof.actionsChecked)],
      [
        'Largest single settlement',
        `\`${paytable.structuralMaximum.multiplier}\` = ${paytable.structuralMaximum.decimal}x`,
      ],
      ['Probability of that settlement', paytable.structuralMaximum.scientific],
      [
        'Largest total one round can credit',
        `\`${paytable.roundMaximum.multiplier}\` = ${paytable.roundMaximum.decimal}x`,
      ],
      ['Declared max-win multiple', `${paytable.roundMaximum.declaredMaxWinMultiple}x (never binds)`],
      ['FULL BLOOM frequency', `1 in ${paytable.terminalCategories.BLOOM.oneIn}`],
      ['Expected generations per RUN round', paytable.totals.expectedGenerations],
      ['Draw grid per round', `${paytable.config.drawGridSize} draws`],
    ],
  );

  return blocks;
}

const BLOCK_PATTERN = (name) =>
  new RegExp(`<!-- generated:${name} -->\\n([\\s\\S]*?)\\n<!-- /generated:${name} -->`, 'u');

/** Extracts a generated block from markdown text. Throws if the markers are missing. */
export function extractBlock(markdown, name) {
  const match = BLOCK_PATTERN(name).exec(markdown);
  if (!match) throw new Error(`Missing generated block: ${name}`);
  return match[1];
}
