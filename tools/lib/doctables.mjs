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
 * `spec/paytable.v2.json`.
 */

import { canonicalJson, digest } from './canonical.mjs';
import { buildPaytable } from './report.mjs';

/** Where the frozen fixture lives, relative to the repository root. */
export const FIXTURE_PATH = 'spec/paytable.v3.json';

/** Values longer than this are published as digest + decimal instead of inline. */
export const INLINE_FRACTION_LIMIT = 44;

/**
 * The volatility ladder in docs/MATH.md §10. Only the `style` and `feel` strings
 * are editorial; every number in the rendered row comes from the enumeration.
 */
export const VOLATILITY_ROWS = Object.freeze([
  { id: 'BANK_FIRST', style: 'Low', feel: 'Grinding, near-flat, one decision' },
  { id: 'HALF_EVERY', style: 'Medium', feel: 'Frequent small credits, long tail kept alive' },
  { id: 'HALF_AT_2X', style: 'Medium-high', feel: 'Locks a profit, rides the rest' },
  { id: 'STOP_AT_10X', style: 'High', feel: 'Rare, chunky wins' },
  { id: 'RUN', style: 'Extreme', feel: 'Nothing, or 17.57x and up' },
]);

/** Thousands separators for an integer string, so prose and tables agree. */
function grouped(digits) {
  if (typeof digits !== 'string' || !/^\d+$/u.test(digits))
    throw new Error(`Expected an integer string, got ${digits}`);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Renders a `0.xxxxxxxxxx` probability as a two-decimal percentage, truncated. */
function percent(decimal) {
  if (typeof decimal !== 'string' || !/^\d+\.\d+$/u.test(decimal))
    throw new Error(`Expected a decimal probability string, got ${decimal}`);
  const [whole, fraction] = decimal.split('.');
  const digits = `${whole}${fraction}`;
  const shifted = `${digits.slice(0, whole.length + 2)}.${digits.slice(whole.length + 2)}`;
  const [head, tail] = shifted.split('.');
  return `${String(Number.parseInt(head, 10))}.${(tail ?? '').padEnd(2, '0').slice(0, 2)}`;
}

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

  blocks.identity = table(
    ['Identity', 'Value'],
    [
      ['Adapter', `\`${paytable.adapterId}\` @ \`${paytable.adapterVersion}\``],
      ['Paytable schema', `\`${paytable.schema}\``],
      ['Frozen fixture', `\`${FIXTURE_PATH}\``],
      ['Fixture sha256', `\`${digest(canonicalJson(paytable))}\``],
    ],
  );

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
    [
      'Policy',
      'Exact RTP',
      'Standard deviation',
      'Profit rate `P(>stake)`',
      'Hit rate `P(>0)`',
      'Description',
    ],
    paytable.policies.map((row) => [
      `\`${row.id}\``,
      `\`${row.rtp}\``,
      row.standardDeviation,
      row.profitRate,
      row.hitRate,
      row.label,
    ]),
  );

  blocks.volatility = table(
    ['Style', 'Policy', 'SD', 'Profit rate', 'Hit rate', 'Feel'],
    VOLATILITY_ROWS.map(({ id, style, feel }) => {
      const row = paytable.policies.find((entry) => entry.id === id);
      if (!row) throw new Error(`Unknown policy in the volatility table: ${id}`);
      return [
        style,
        `\`${row.id}\``,
        row.standardDeviation.slice(0, 4),
        `${percent(row.profitRate)}%`,
        `${percent(row.hitRate)}%`,
        feel,
      ];
    }),
  );

  blocks['volatility-bounds'] = table(
    ['Bound over every adapted policy', 'Standard deviation', 'Attained by'],
    [
      [
        'Minimum',
        paytable.varianceBounds.minimum.standardDeviation,
        'Banking the whole colony at the first decision (`BANK_FIRST`)',
      ],
      [
        'Maximum',
        paytable.varianceBounds.maximum.standardDeviation,
        `Harvesting exactly one organism at population ${
          paytable.varianceBounds.maximum.harvests[0].population
        } to stay under FULL BLOOM (${paytable.varianceBounds.maximum.harvestStates} states)`,
      ],
    ],
  );

  blocks.risk = table(
    ['Bet line', 'Cap basis', 'Largest credit the line can owe', 'Declared cap', 'Headroom'],
    paytable.risk.lines.map((row) => [
      `\`${row.line}\``,
      row.basis,
      `${row.maximumCreditDecimal}x`,
      `${row.capMultiple}x`,
      `${row.headroom}x`,
    ]),
  );

  blocks.bloom = table(
    ['FULL BLOOM payout', 'Value'],
    [
      [
        'Smallest possible',
        `${paytable.bloom.smallest}x (generation ${paytable.bloom.smallestGeneration}, ${paytable.bloom.smallestPopulation} organisms)`,
      ],
      ['Median', `${paytable.bloom.median}x`],
      ['Largest possible', `${paytable.bloom.largest}x`],
      ['Share paying under 20x', `${percent(paytable.bloom.shareBelow20x)}%`],
      ['Share paying under 50x', `${percent(paytable.bloom.shareBelow50x)}%`],
      ['Share paying under 100x', `${percent(paytable.bloom.shareBelow100x)}%`],
      [
        `Share paying less than the smallest generation-18 settlement (${paytable.bloom.smallestFinal}x)`,
        `${percent(paytable.bloom.shareBelowSmallestFinal)}%`,
      ],
      ['Frequency', `1 in ${paytable.bloom.oneIn}`],
    ],
  );

  blocks.feedback = table(
    [
      'Population `n`',
      'P(value falls)',
      'P(falls **and** at least one split)',
      'P(falls **and** two or more splits)',
      'P(at least one split \\| value falls)',
    ],
    paytable.feedback.map((row) => [
      String(row.population),
      `${percent(row.falls)}%`,
      `${percent(row.fallsWithSplit)}%`,
      `${percent(row.fallsWithTwoSplits)}%`,
      `${percent(row.splitGivenFalls)}%`,
    ]),
  );

  blocks['break-even'] = table(
    ['Generation', 'Organism value', 'Organisms needed to be worth more than the stake', 'A colony of 3 is worth'],
    paytable.breakEven.map((row) => [
      String(row.generation),
      row.organismValue,
      String(row.aboveStake),
      `${row.colonyOfThree}x`,
    ]),
  );

  blocks.sidebets = table(
    [
      'Bet',
      'Resolves on',
      'Probability',
      'One in',
      'Multiplier (exact)',
      'Multiplier',
      'Own cap',
      'RTP',
    ],
    paytable.sideBets.map((row) => [
      `**${row.label}**`,
      row.description,
      fractionCell(row.probability),
      row.oneIn,
      fractionCell(row.multiplier),
      `${row.multiplierDecimal}x`,
      `${row.capMultiple}x`,
      `\`${row.rtp}\``,
    ]),
  );

  /** docs/DESIGN.md §6.5 — the verdict bands, keyed to money and not to the ratio. */
  const BAND_LABELS = {
    HEAVY_LOSS: '`D <= -1.00x` — the generation took at least a stake off the table',
    LOSS: '`-1.00x < D < 0`',
    FLAT: '`D = 0` — reachable only when `5m = 4n`',
    GAIN: '`0 < D < +1.00x`',
    LARGE_GAIN: '`D >= +1.00x` — MEDUSA, and the chord',
  };
  blocks['verdict-bands'] = table(
    ['Verdict band', 'Share of verdict beats'],
    paytable.presentation.verdict.bands.map((row) => [
      BAND_LABELS[row.band] ?? row.band,
      `${percent(row.share)}%`,
    ]),
  );

  blocks['chord-ladder'] = table(
    ['Note', '`D` at least', 'Share of verdict beats', 'One in', 'Per round', 'Reachable from'],
    paytable.presentation.chord.ladder.map((row) => [
      `+${row.step}`,
      `\`${row.threshold}\` = ${row.thresholdDecimal}x`,
      `${percent(row.share)}%`,
      row.oneInBeats,
      row.perRound,
      `generation ${row.earliestGeneration}, ${row.reachableStates} states`,
    ]),
  );

  blocks['verdict-reach'] = table(
    ['Population `n`', 'Largest non-terminal offspring `m`', 'Largest `D` a verdict beat can carry', 'First generation that can reach `D >= 1.00x`'],
    paytable.presentation.reach.map((row) => [
      String(row.population),
      String(row.bestOffspring),
      `${row.bestDelta}x`,
      String(row.firstLargeGainGeneration),
    ]),
  );

  blocks['settlement-classes'] = table(
    ['Policy', 'Returns nothing', 'Returns **less than the stake**', 'Returns more than the stake'],
    paytable.presentation.settlement.map((row) => [
      `\`${row.id}\``,
      `${percent(row.nothing)}%`,
      `${percent(row.belowStake)}%`,
      `${percent(row.profit)}%`,
    ]),
  );

  blocks['shared-cap'] = table(
    ['Quantity, under one shared ticket ceiling of 906x on equal stakes', 'Exact value'],
    [
      [
        'Combined maximum the four lines can owe',
        `${paytable.risk.sharedCeilingCounterfactual.combinedMaximumDecimal}x`,
      ],
      [
        'Short-pay if a single 906x ceiling were applied to that sum',
        `${paytable.risk.sharedCeilingCounterfactual.shortfallDecimal}x`,
      ],
      [
        'COLONY credit needed before the shared ceiling binds at all',
        `${paytable.risk.sharedCeilingCounterfactual.colonyThresholdDecimal}x`,
      ],
      [
        'Largest total `RUN` can produce (so `RUN` can never bind it)',
        `${paytable.risk.sharedCeilingCounterfactual.runMaximumDecimal}x`,
      ],
      [
        'Largest total attainable without ever holding this many organisms',
        `${paytable.risk.sharedCeilingCounterfactual.attainableBelowPeakDecimal}x below a peak of ${paytable.risk.sharedCeilingCounterfactual.minimumPeakPopulation}`,
      ],
      [
        'Upper bound on P(bind), over every adapted policy',
        `${paytable.risk.sharedCeilingCounterfactual.bindingProbabilityBound} (1 in ${paytable.risk.sharedCeilingCounterfactual.bindingProbabilityBoundOneIn})`,
      ],
    ],
  );

  blocks.layout = table(
    ['Population `n`', 'Body radius `r(n)`', 'Unclamped', 'Layout radius `R(n)`', 'Innermost body at'],
    paytable.presentation.layout.rows.map((row) => [
      String(row.population),
      `${row.bodyRadius} pt${row.clamped ? ' (clamped)' : ''}`,
      `${row.bodyRadiusRaw} pt`,
      `${row.layoutRadius} pt`,
      `${row.innermostRadius} pt`,
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
        'Largest total the COLONY line can credit',
        `\`${paytable.roundMaximum.multiplier}\` = ${paytable.roundMaximum.decimal}x`,
      ],
      [
        'Declared COLONY cap, on the colony stake',
        `${paytable.roundMaximum.declaredMaxWinMultiple}x (proven never to bind)`,
      ],
      [
        'Worst-case ticket liability at the stake bounds',
        `${grouped(paytable.risk.ticket.worstCaseExposureCredits)} credits, admitted below ${grouped(paytable.risk.ticket.admissionLimitCredits)}`,
      ],
      ['FULL BLOOM frequency', `1 in ${paytable.terminalCategories.BLOOM.oneIn}`],
      [
        'FULL BLOOM payout range',
        `${paytable.bloom.smallest}x to ${paytable.bloom.largest}x, median ${paytable.bloom.median}x`,
      ],
      [
        'Standard deviation, proven interval over every policy',
        `${paytable.varianceBounds.minimum.standardDeviation} to ${paytable.varianceBounds.maximum.standardDeviation}`,
      ],
      [
        'Rounds left below the stake by the mandatory generation 1',
        `\`${paytable.underwater.afterGenerationOne}\` = ${percent(paytable.underwater.afterGenerationOneDecimal)}%`,
      ],
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
