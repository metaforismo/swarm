#!/usr/bin/env node
/**
 * SWARM — exhaustive outcome enumeration.
 *
 * This script is the proof behind every number in docs/MATH.md. It walks the
 * entire truncated Galton-Watson state space with exact BigInt rational
 * arithmetic and prints, as exact fractions:
 *
 *   - the offspring model and the value ladder;
 *   - the full terminal outcome space, its total probability mass (exactly 1)
 *     and its exact RTP (exactly 19/20);
 *   - the exact payout tail and the exact FULL BLOOM frequency;
 *   - the exact RTP, variance and hit rate of eight different decision
 *     policies, all of which return exactly 19/20;
 *   - a machine-checked proof that every legal action at every reachable state
 *     has identical exact value, i.e. that no strategy can move the RTP;
 *   - every side bet's exact probability, multiplier and RTP.
 *
 * There is no sampling in this file. `tools/simulate.mjs` runs a seeded Monte
 * Carlo cross-check, which is a sanity check on the specification, never the
 * source of a published number.
 *
 * Usage:
 *   node tools/enumerate.mjs                     full report
 *   node tools/enumerate.mjs --terminals         also print every terminal state
 *   node tools/enumerate.mjs --json spec/paytable.v3.json   write the frozen fixture
 *   node tools/enumerate.mjs --check spec/paytable.v3.json  verify the frozen fixture
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson, digest } from './lib/canonical.mjs';
import { buildPaytable } from './lib/report.mjs';
import {
  COLONY_MAX_WIN_MULTIPLE,
  UNITS_PER_CREDIT,
  structuralMaxMultiplier,
} from './lib/config.mjs';
import { payableUnits } from './lib/model.mjs';
import { toDecimal, toFraction } from './lib/rational.mjs';

function parseArgs(argv) {
  const options = { terminals: false, json: null, check: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--terminals') options.terminals = true;
    else if (arg === '--json') options.json = argv[(index += 1)];
    else if (arg === '--check') options.check = argv[(index += 1)];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
    if ((options.json === undefined || options.check === undefined) && !options.help)
      throw new Error('Missing path after --json/--check');
  }
  return options;
}

const HEAD = (title) => `\n${title}\n${'-'.repeat(title.length)}`;
const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

function printReport(paytable, options) {
  const { config } = paytable;
  console.log('SWARM — exact outcome enumeration');
  console.log(`adapter ${paytable.adapterId} @ ${paytable.adapterVersion} (${paytable.schema})`);

  console.log(HEAD('1. Offspring model (one draw per organism per generation)'));
  console.log(`draw modulus ${config.drawModulus}   grid ${config.drawGridSize} draws per round`);
  for (const outcome of config.offspring)
    console.log(
      `  ${padEnd(outcome.id, 6)} children=${outcome.children}  draws ${padEnd(outcome.drawBand, 6)}  p=${padEnd(outcome.probability, 6)} = ${pad(outcome.percent, 6)}%`,
    );
  console.log(`  mean offspring mu = ${config.offspringMean}`);
  console.log(
    `  seeds=${config.seedCount}  generations<=${config.maxGenerations}  FULL BLOOM at >=${config.bloomThreshold}  max population ${config.maxPopulation}`,
  );

  console.log(HEAD('2. Value ladder  c(t) = ladderBase * (1/mu)^(t-1)'));
  console.log(
    `ladderBase=${config.ladderBase}  step=${config.ladderStep}  target RTP=${config.targetRtp} (${config.targetRtpPercent}%)`,
  );
  console.log('  gen  organism value        decimal      colony of 3   bloom floor');
  for (const row of paytable.ladder)
    console.log(
      `  ${pad(row.generation, 3)}  ${padEnd(row.organismValue, 20)} ${pad(row.decimal, 10)}   ${pad(row.colonyOfThree, 11)}   ${pad(row.bloomFloor, 11)}`,
    );

  console.log(HEAD('3. Generation 1 (mandatory, no decision): exact distribution'));
  console.log('  pop  probability   percent     colony multiplier');
  for (const row of paytable.generationOne)
    console.log(
      `  ${pad(row.population, 3)}  ${padEnd(row.probability, 12)} ${pad(row.percent, 8)}%   ${padEnd(row.multiplier, 22)} = ${row.multiplierDecimal}`,
    );

  console.log(HEAD('4. Colony survival curve (RUN policy)'));
  for (const row of paytable.survival)
    console.log(`  after gen ${pad(row.generation, 2)}: alive ${row.decimal}`);

  console.log(HEAD('5. Terminal outcome space'));
  console.log(`  terminal states enumerated : ${paytable.totals.terminalCount}`);
  console.log(`  total probability mass     : ${paytable.totals.probabilityMass}`);
  console.log(`  exact RTP (RUN)            : ${paytable.totals.rtp} = ${paytable.totals.rtpPercent}%`);
  console.log(`  expected generations       : ${paytable.totals.expectedGenerations}`);
  console.log(`  EXTINCT : ${paytable.terminalCategories.EXTINCT.decimal}`);
  console.log(
    `  BLOOM   : ${paytable.terminalCategories.BLOOM.decimal}  (1 in ${paytable.terminalCategories.BLOOM.oneIn})`,
  );
  console.log(`  FINAL   : ${paytable.terminalCategories.FINAL.decimal}`);

  console.log(HEAD('6. Payout tail under the RUN policy'));
  console.log('  at least   probability          one in');
  for (const row of paytable.tail)
    console.log(`  ${pad(`${row.threshold}x`, 8)}   ${padEnd(row.scientific, 18)} ${row.oneIn}`);

  console.log(HEAD('7. Peak-population frequency (wild line)'));
  console.log('  reaches   probability          one in');
  for (const row of paytable.reach)
    console.log(`  ${pad(row.threshold, 7)}   ${padEnd(row.scientific, 18)} ${row.oneIn}`);

  console.log(HEAD('8. Decision policies — exact RTP, variance, profit rate and hit rate'));
  console.log('  policy           exact RTP   sd         P(>stake)     P(>0)         description');
  for (const row of paytable.policies)
    console.log(
      `  ${padEnd(row.id, 15)} ${padEnd(row.rtp, 10)} ${pad(row.standardDeviation, 9)}  ${pad(row.profitRate, 12)}  ${pad(row.hitRate, 12)}  ${row.label}`,
    );
  console.log(
    `  proven SD interval over every adapted policy: ${paytable.varianceBounds.minimum.standardDeviation} .. ${paytable.varianceBounds.maximum.standardDeviation}`,
  );
  console.log(
    `  the maximum is attained by harvesting one organism at population ${paytable.varianceBounds.maximum.harvests[0].population} (${paytable.varianceBounds.maximum.harvestStates} states)`,
  );

  console.log(HEAD('9. Strategy invariance proof (backward induction, exact)'));
  console.log(`  decision states checked : ${paytable.proof.statesChecked}`);
  console.log(`  actions checked         : ${paytable.proof.actionsChecked}`);
  console.log(`  mismatches              : ${paytable.proof.failures}`);
  console.log(`  optimal-play RTP        : ${paytable.proof.optimalRtp}`);
  console.log(`  verdict                 : ${paytable.proof.ok ? 'every action ties exactly' : 'FAILED'}`);

  console.log(HEAD('10. Side bets (priced at exactly 19/20)'));
  for (const bet of paytable.sideBets) {
    console.log(`  ${bet.label} — ${bet.description}`);
    console.log(
      `    p = ${bet.probability} = ${bet.probabilityDecimal} (1 in ${bet.oneIn})   pays ${bet.multiplier} = ${bet.multiplierDecimal}x   RTP ${bet.rtp}`,
    );
  }

  console.log(HEAD('11. Caps, per bet line, each on its own stake'));
  const structural = structuralMaxMultiplier();
  console.log(`  largest single settlement : ${toFraction(structural)} = ${toDecimal(structural, 6)}x`);
  console.log(
    `  reached at                : generation ${paytable.structuralMaximum.generation}, population ${paytable.structuralMaximum.population}, p = ${paytable.structuralMaximum.scientific}`,
  );
  console.log('  line          basis                largest owed   cap     headroom');
  for (const line of paytable.risk.lines)
    console.log(
      `  ${padEnd(line.line, 12)}  ${padEnd(line.basis, 18)}  ${pad(`${line.maximumCreditDecimal}x`, 12)}  ${pad(`${line.capMultiple}x`, 6)}  ${pad(`${line.headroom}x`, 10)}`,
    );
  console.log(
    `  worst ticket at the declared stake bounds : ${paytable.risk.ticket.worstCaseExposureCredits} credits, admission limit ${paytable.risk.ticket.admissionLimitCredits} credits (binds: ${paytable.risk.ticket.binds})`,
  );
  const stake = UNITS_PER_CREDIT;
  const worst = payableUnits(stake, structural, 0n, COLONY_MAX_WIN_MULTIPLE);
  console.log(
    `  1.000000 credit staked at the maximum credits ${worst.credited} units (capped=${worst.capped})`,
  );
  console.log(
    `  floor loss <= ${paytable.roundingBound.maximumLossUnits} units per round = ${paytable.roundingBound.relativeAtMinimumStake} of the minimum stake (${paytable.roundingBound.relativeAtMinimumStakePercentagePoints} percentage points of RTP)`,
  );

  console.log(HEAD('12. Outcome-feedback honesty (evidence for docs/DESIGN.md §6.5)'));
  console.log('  pop  P(value falls)  P(falls & split)  P(falls & 2 splits)  P(split | falls)');
  for (const row of paytable.feedback)
    console.log(
      `  ${pad(row.population, 3)}  ${pad(row.falls, 13)}  ${pad(row.fallsWithSplit, 16)}  ${pad(row.fallsWithTwoSplits, 19)}  ${pad(row.splitGivenFalls, 16)}`,
    );
  console.log(
    `  rounds left below the stake by the mandatory generation 1 : ${paytable.underwater.afterGenerationOne} = ${paytable.underwater.afterGenerationOneDecimal}`,
  );
  console.log(
    `    of which extinct ${paytable.underwater.extinct}, alive but under the stake ${paytable.underwater.aliveBelowStake}`,
  );

  console.log(HEAD('13. FULL BLOOM payout profile (celebration must scale with this)'));
  console.log(
    `  smallest ${paytable.bloom.smallest}x (generation ${paytable.bloom.smallestGeneration}, ${paytable.bloom.smallestPopulation} organisms)   median ${paytable.bloom.median}x   largest ${paytable.bloom.largest}x`,
  );
  console.log(
    `  under 20x: ${paytable.bloom.shareBelow20x}   under 50x: ${paytable.bloom.shareBelow50x}   under 100x: ${paytable.bloom.shareBelow100x}`,
  );
  console.log(
    `  paying less than the smallest generation-18 settlement (${paytable.bloom.smallestFinal}x): ${paytable.bloom.shareBelowSmallestFinal}`,
  );
  console.log(
    `  near-miss band ${paytable.nearMiss.band} organisms: ${paytable.nearMiss.decimal} (1 in ${paytable.nearMiss.oneIn})`,
  );

  console.log(HEAD('14. Verdict feedback, keyed to money (evidence for docs/DESIGN.md §6.5)'));
  console.log(
    `  D = signed change in colony value, in stake multiples; ${paytable.presentation.verdict.beatsPerRound} verdict beats per RUN round`,
  );
  for (const band of paytable.presentation.verdict.bands)
    console.log(`  ${padEnd(band.band, 11)} share ${band.share}`);
  console.log('  chord ladder (one semitone per 3/2 of gain), every note proved reachable:');
  console.log('   note  D at least     share of beats  one in     per round   reachable states  from gen');
  for (const row of paytable.presentation.chord.ladder)
    console.log(
      `    +${row.step}   ${pad(`${row.thresholdDecimal}x`, 13)}  ${pad(row.share, 14)}  ${pad(row.oneInBeats, 9)}  ${pad(row.perRound, 10)}  ${pad(row.reachableStates, 16)}  ${pad(row.earliestGeneration, 8)}`,
    );
  console.log('  largest gain a verdict beat can carry, and where the large-gain band opens:');
  console.log('   pop  best m   largest D      first generation with D >= 1x');
  for (const row of paytable.presentation.reach)
    console.log(
      `   ${pad(row.population, 3)}  ${pad(row.bestOffspring, 5)}   ${pad(`${row.bestDelta}x`, 13)}  ${pad(row.firstLargeGainGeneration, 6)}`,
    );

  console.log(HEAD('15. How a round settles, as the player experiences it (docs/DESIGN.md §7.1)'));
  console.log(
    `  exactly one stake is unreachable as a round total (factor ${paytable.stakeBoundary.factor}, ${paytable.stakeBoundary.creditsChecked} credits checked), so the loss/win boundary is unambiguous`,
  );
  console.log('  policy           nothing        below the stake  above the stake');
  for (const row of paytable.presentation.settlement)
    console.log(
      `  ${padEnd(row.id, 15)} ${pad(row.nothing, 13)}  ${pad(row.belowStake, 15)}  ${pad(row.profit, 15)}`,
    );

  console.log(HEAD('16. The rejected alternative: one shared ticket ceiling (docs/MATH.md §12.1)'));
  const shared = paytable.risk.sharedCeilingCounterfactual;
  console.log(`  combined maximum of the four lines on equal stakes : ${shared.combinedMaximumDecimal}x`);
  console.log(`  short-pay against a single ${paytable.roundMaximum.declaredMaxWinMultiple}x ceiling            : ${shared.shortfallDecimal}x`);
  console.log(`  COLONY credit needed before it binds at all        : ${shared.colonyThresholdDecimal}x`);
  console.log(`  largest total RUN can produce                     : ${shared.runMaximumDecimal}x (binds: ${shared.runCanBind})`);
  console.log(
    `  binding requires a peak of >= ${shared.minimumPeakPopulation} organisms (max below that peak ${shared.attainableBelowPeakDecimal}x), so P(bind) <= ${shared.bindingProbabilityBound} = 1 in ${shared.bindingProbabilityBoundOneIn}`,
  );

  console.log(HEAD('17. Colony layout contract (docs/DESIGN.md §6.4)'));
  console.log(
    `  body radius clamps to its floor from population ${paytable.presentation.layout.firstClampedPopulation} upward`,
  );
  console.log('   pop  r(n)      unclamped  R(n)       innermost body');
  for (const row of paytable.presentation.layout.rows)
    console.log(
      `   ${pad(row.population, 3)}  ${pad(row.bodyRadius, 8)}  ${pad(row.bodyRadiusRaw, 9)}  ${pad(row.layoutRadius, 9)}  ${pad(row.innermostRadius, 14)}${row.clamped ? '  (clamped)' : ''}`,
    );

  if (options.terminals) {
    console.log(HEAD('18. Every terminal state'));
    console.log('  gen  pop  reason   multiplier                probability');
    for (const row of paytable.terminals)
      console.log(
        `  ${pad(row.generation, 3)}  ${pad(row.population, 3)}  ${padEnd(row.reason, 8)} ${padEnd(row.multiplier, 24)} ${row.probability}`,
      );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node tools/enumerate.mjs [--terminals] [--json <path>] [--check <path>]');
    return 0;
  }

  const started = process.hrtime.bigint();
  const paytable = buildPaytable();
  const text = canonicalJson(paytable);
  const fingerprint = digest(text);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  printReport(paytable, options);

  console.log(HEAD('Fixture'));
  console.log(`  canonical bytes : ${Buffer.byteLength(text, 'utf8')}`);
  console.log(`  sha256          : ${fingerprint}`);
  console.log(`  enumerated in   : ${elapsedMs.toFixed(1)} ms`);

  if (options.json) {
    writeFileSync(options.json, text, 'utf8');
    console.log(`  written         : ${options.json}`);
  }

  if (options.check) {
    const existing = readFileSync(options.check, 'utf8');
    if (existing !== text) {
      console.error(`\nFIXTURE MISMATCH: ${options.check} does not equal the freshly enumerated paytable.`);
      console.error(`  frozen sha256 : ${digest(existing)}`);
      console.error(`  actual sha256 : ${fingerprint}`);
      return 1;
    }
    console.log(`  verified        : ${options.check} matches byte for byte`);
  }

  if (!paytable.proof.ok) {
    console.error('\nSTRATEGY PROOF FAILED');
    return 1;
  }
  return 0;
}

process.exitCode = main();
