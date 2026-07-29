/**
 * The sheets: receipt, verify, the completed wild line, history, and help.
 *
 * Every number rendered here comes from `/api/config`, which serves the frozen
 * enumerated paytable — so the help screen and the model cannot disagree. The
 * rules the sheets are built around are `docs/DESIGN.md` §9.3: the profit rate
 * leads, a hit rate never appears alone, a FULL BLOOM frequency never appears
 * without the play pattern it belongs to, and the rounding qualifier is mandatory
 * wherever "every way of playing returns the same" is said.
 */
import { credits, multiple, percent, shortHex, signedCredits, truncate } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function row(key, value, valueClass) {
  const node = el('div', 'row');
  node.append(el('span', 'k', key));
  node.append(el('span', `v ${valueClass ?? ''}`.trim(), value));
  return node;
}

function panel(title) {
  const node = el('div', 'panel');
  if (title !== undefined) {
    const heading = el('h2', null, title);
    heading.style.marginTop = '0';
    node.append(heading);
  }
  return node;
}

function table(headers, rows) {
  const wrapper = el('div', 'scroll-x');
  const node = el('table', 'data');
  const head = el('thead');
  const headRow = el('tr');
  for (const header of headers) headRow.append(el('th', null, header));
  head.append(headRow);
  node.append(head);
  const body = el('tbody');
  for (const cells of rows) {
    const line = el('tr');
    cells.forEach((cell, index) => {
      const td = el('td', index === 0 ? null : 'num', String(cell));
      line.append(td);
    });
    body.append(line);
  }
  node.append(body);
  wrapper.append(node);
  return wrapper;
}

/** S8 — the receipt: every line, every movement, both commitments. */
export function receiptSheet(config, view) {
  const fragment = document.createDocumentFragment();
  const settlement = view.settlement;
  const proof = settlement.proof;

  const summary = panel('This round');
  summary.append(row('Terminal', proof.terminal));
  summary.append(row('Settled by', proof.settlementMode === 'PLAYER' ? 'You' : 'The 72-hour rule'));
  summary.append(row('Generations', String(proof.populations.length)));
  summary.append(row('Populations', proof.populations.join(' → ')));
  summary.append(row('Staked', credits(settlement.stakedUnits)));
  summary.append(row('Credited', credits(settlement.creditedUnits)));
  summary.append(row('Net', signedCredits(settlement.netUnits)));
  fragment.append(summary);

  const ledger = panel('Ledger');
  ledger.append(
    table(
      ['#', 'Movement', 'Line', 'Gen', 'Amount'],
      settlement.receipts.map((receipt) => [
        receipt.sequence,
        `${receipt.direction === 'DEBIT' ? '−' : '+'} ${receipt.kind}`,
        receipt.line,
        receipt.stage === 0 ? '—' : receipt.stage,
        credits(receipt.amountUnits),
      ]),
    ),
  );
  const harvests = settlement.receipts.filter((receipt) => receipt.kind === 'HARVEST');
  if (harvests.length > 0) {
    const detail = el('p', 'small muted');
    detail.textContent = `Each harvest credited floor(stake x yield x k) in minor units: ${harvests
      .map((receipt) => `g${receipt.stage} k=${receipt.unitsHarvested} → ${receipt.amountUnits}`)
      .join(', ')}. Every credit is rounded down to the nearest 0.000001.`;
    ledger.append(detail);
  }
  fragment.append(ledger);

  const bets = panel('Side bets');
  if (proof.sideBetResults.every((result) => result.resolved === 'NOT_SELECTED')) {
    bets.append(el('p', 'small muted', 'None placed on this ticket.'));
  } else {
    for (const result of proof.sideBetResults) {
      if (result.resolved === 'NOT_SELECTED') continue;
      const definition = config.sideBets.find((bet) => bet.id === result.id);
      const receipt = settlement.receipts.find(
        (entry) => entry.kind === 'SIDE_BET' && entry.line === result.id,
      );
      bets.append(
        row(
          definition?.label ?? result.id,
          `${result.resolved} · ${credits(receipt?.amountUnits ?? '0')}`,
        ),
      );
    }
  }
  fragment.append(bets);

  const fairness = panel('Fairness');
  fairness.append(row('Round', proof.roundId));
  fairness.append(row('Seed pre-commitment', shortHex(proof.seedCommitment)));
  fairness.append(row('Settlement body', shortHex(proof.bodyCommitment)));
  fairness.append(row('Revealed server seed', shortHex(proof.revealedSeed)));
  fairness.append(row('Your client seed', shortHex(proof.clientEntropy)));
  fairness.append(row('Adapter', `${config.identity.adapterId} @ ${config.identity.adapterVersion}`));
  fragment.append(fairness);

  return fragment;
}

/** S9 — the verify sheet: the eight checks of docs/ENGINE.md §4.6, re-derived. */
export function verifySheet(config, view, result) {
  const fragment = document.createDocumentFragment();
  const proof = view.settlement.proof;

  const intro = panel();
  intro.append(
    el(
      'p',
      'small',
      'The first commitment proves the server sealed its seed before any decision. The second proves this settlement is the settlement of this decision log and not another one.',
    ),
  );
  intro.append(row('Verdict', result.code, result.ok ? '' : 'muted'));
  intro.append(row('Checks passed', `${result.steps.filter((step) => step.ok).length} / 8`));
  fragment.append(intro);

  const steps = panel('Re-derivation');
  for (const step of result.steps) {
    const node = el('div', 'verify-step');
    node.dataset.ok = String(step.ok);
    node.append(el('span', 'mark', step.ok ? '✓' : '✕'));
    const body = el('div');
    body.append(el('div', null, `${step.step}. ${step.name}`));
    body.append(el('div', 'detail', step.detail));
    node.append(body);
    steps.append(node);
  }
  fragment.append(steps);

  const log = panel('Action log, with the chain you were handed');
  log.append(
    table(
      ['Event', 'Gen', 'Units', 'Chain'],
      proof.actionLog.map((action, index) => [
        action.kind,
        action.generation,
        action.units,
        shortHex(proof.liveChainValues[index + 1] ?? proof.actionChain, 6, 4),
      ]),
    ),
  );
  log.append(
    el(
      'p',
      'small muted',
      'Each value is a hash of everything you had seen up to that point, handed to you before the seed was revealed. Keeping them is what makes the log evidence against a third party.',
    ),
  );
  fragment.append(log);

  const grid = panel('The grid');
  grid.append(row('Draws per round', `${config.rules.gridSize} (18 × 15)`));
  grid.append(row('Draw modulus', config.rules.drawModulus));
  grid.append(
    row('Bands', config.rules.offspring.map((band) => `${band.id} ${band.band}`).join(' · ')),
  );
  grid.append(row('Sampler', config.identity.proof.samplerDomain));
  grid.append(row('Fingerprint', shortHex(config.identity.adapterFingerprint)));
  fragment.append(grid);

  const offline = panel('Check it yourself, offline');
  const command = el('div', 'mono');
  command.textContent = `node tools/simulate.mjs   # the reference derivation, both commitment phases and the verifier`;
  offline.append(command);
  offline.append(
    el(
      'p',
      'small muted',
      'The published verifier takes the action log as an untrusted input and re-seals the settlement body over what it replayed, so a log that was not the log fails.',
    ),
  );
  fragment.append(offline);

  return fragment;
}

/** S8a — the completed wild line, after the round, where it cannot sit beside a decision. */
export function wildSheet(config, view) {
  const fragment = document.createDocumentFragment();
  const wild = view.settlement.wild;
  const proof = view.settlement.proof;

  const intro = panel();
  intro.append(
    el(
      'p',
      'small',
      'Side bets resolve on the colony that never gets harvested. It is drawn in full here for the first time, from the revealed seed — including the generations after your own round stopped.',
    ),
  );
  fragment.append(intro);

  const chart = panel('Wild line');
  const bars = el('div', 'wildline');
  const peak = Math.max(wild.peak, 1);
  wild.populations.forEach((population, index) => {
    const bar = el('div', 'bar');
    if (index < proof.populations.length) bar.classList.add('player');
    bar.style.height = `${Math.max(2, (population / peak) * 100)}%`;
    bar.title = `generation ${index + 1}: ${population}`;
    bars.append(bar);
  });
  chart.append(bars);
  chart.append(row('Populations', wild.populations.join(' → ')));
  chart.append(row('Peak', String(wild.peak)));
  chart.append(row('Terminal', wild.terminal));
  chart.append(
    row('Your colony', proof.populations.join(' → ') || '—'),
  );
  fragment.append(chart);

  const results = panel('Resolution');
  for (const result of proof.sideBetResults) {
    if (result.resolved === 'NOT_SELECTED') continue;
    const definition = config.sideBets.find((bet) => bet.id === result.id);
    results.append(row(definition?.label ?? result.id, result.resolved));
    results.append(el('p', 'small muted', definition?.description ?? ''));
  }
  fragment.append(results);
  return fragment;
}

/** S10 — history and the session summary. Never a positive-only "wins" view. */
export function historySheet(session) {
  const fragment = document.createDocumentFragment();
  const summary = panel('This session');
  summary.append(row('Opening balance', credits(session.openingUnits)));
  summary.append(row('Balance', credits(session.balanceUnits)));
  summary.append(row('Total staked', credits(session.stakedUnits)));
  summary.append(row('Total credited', credits(session.creditedUnits)));
  summary.append(row('Net result', signedCredits(session.netUnits)));
  fragment.append(summary);

  const rounds = panel(`Last ${session.history.length} round(s)`);
  if (session.history.length === 0) rounds.append(el('p', 'small muted', 'No rounds yet.'));
  else
    rounds.append(
      table(
        ['Round', 'Terminal', 'Gens', 'Staked', 'Net'],
        session.history.map((entry) => [
          entry.roundId.slice(0, 12),
          entry.terminal,
          entry.generations,
          credits(entry.stakedUnits),
          signedCredits(entry.netUnits),
        ]),
      ),
    );
  fragment.append(rounds);
  return fragment;
}

/**
 * Help and paytable.
 *
 * This is the screen §9.2 designates as the only home for the break-even ladder
 * and the FULL BLOOM frequencies: identical for every player, identical in every
 * round state, pulled and never pushed, and never surfaced at a decision.
 */
export function helpSheet(config) {
  const fragment = document.createDocumentFragment();
  const published = config.published;

  const honest = panel('The short version');
  honest.append(
    el(
      'p',
      'small',
      'Every way of playing SWARM returns the same 95% on average, before rounding. Every credit is rounded down to the nearest 0.000001, so harvesting often costs a fraction of a penny more than banking once — at most 0.000018 a round. Your choices change how often you win and how much.',
    ),
  );
  honest.append(
    el(
      'p',
      'small',
      'About half of all rounds are worth less than your stake after the first generation. Continuing is not a way back: every choice you can make has the same expected return, before rounding. Bank whenever you want.',
    ),
  );
  honest.append(row('Theoretical RTP', `${published.totals.rtp} = 95.0000%`));
  honest.append(row('Max win, COLONY line', `${published.roundMaximum.decimal}x (cap ${config.money.colonyMaxWinMultiple}x)`));
  honest.append(row('Biggest single settlement', `${published.structuralMaximum.decimal}x`));
  honest.append(row('Below the stake after generation 1', percent(published.underwater.afterGenerationOneDecimal)));
  fragment.append(honest);

  const odds = panel('How a generation resolves');
  odds.append(
    table(
      ['Outcome', 'Children', 'Draws', 'Chance'],
      config.rules.offspring.map((band) => [band.id, band.children, band.band, `${band.percent}%`]),
    ),
  );
  fragment.append(odds);

  const policies = panel('How often you finish ahead, by play pattern');
  policies.append(
    el(
      'p',
      'small muted',
      'Profit rate is P(return > stake). The hit rate beside it is P(return > 0) — a returned fraction of a stake is a loss.',
    ),
  );
  policies.append(
    table(
      ['Play pattern', 'RTP', 'Profit', 'Hit', 'SD', 'FULL BLOOM'],
      published.policies.map((policy) => [
        policy.label,
        policy.rtp,
        percent(policy.profitRate),
        percent(policy.hitRate),
        policy.standardDeviation,
        policy.bloomOneIn === 'never' ? 'never' : `1 in ${policy.bloomOneIn}`,
      ]),
    ),
  );
  policies.append(
    el(
      'p',
      'small muted',
      'FULL BLOOM is 16 organisms or more. The frequency belongs to a play pattern: harvesting lowers it, and halving the colony every generation — the one-tap default — makes it exactly zero.',
    ),
  );
  fragment.append(policies);

  const settlementClasses = panel('How rounds end');
  settlementClasses.append(
    table(
      ['Play pattern', 'Nothing', 'Below stake', 'Above stake'],
      published.presentation.settlement.map((entry) => [
        entry.label,
        percent(entry.nothing),
        percent(entry.belowStake),
        percent(entry.profit),
      ]),
    ),
  );
  fragment.append(settlementClasses);

  const ladder = panel('The yield ladder');
  ladder.append(
    table(
      ['Gen', 'Per organism', 'Colony of 3', 'Organisms to beat the stake'],
      config.ladder.map((entry, index) => [
        entry.generation,
        entry.decimal,
        entry.colonyOfThree,
        published.breakEven[index]?.aboveStake ?? '—',
      ]),
    ),
  );
  fragment.append(ladder);

  const bets = panel('Side bets');
  for (const bet of config.sideBets) {
    bets.append(row(bet.label, `${multiple(bet.multiplier)} · 1 in ${bet.oneIn}`));
    bets.append(el('p', 'small muted', bet.description));
    if (bet.id === 'DARK_VENT')
      bets.append(
        el(
          'p',
          'small muted',
          'A separate bet with its own stake. It does not reduce the cost of your colony bet — it adds a second bet at the same 95%. Placing both means staking more this round, and it changes how often you finish a round ahead.',
        ),
      );
  }
  bets.append(
    table(
      ['Ticket', 'Play pattern', 'Ticket profit rate', 'COLONY alone'],
      published.ticketPairings.map((pairing) => [
        `COLONY + ${pairing.sideBet}`,
        pairing.policy,
        percent(pairing.ticketProfitRate),
        percent(pairing.colonyOnlyProfitRate),
      ]),
    ),
  );
  fragment.append(bets);

  const fairness = panel('Fairness');
  fairness.append(row('Adapter', `${config.identity.adapterId} @ ${config.identity.adapterVersion}`));
  fairness.append(row('Module', config.identity.moduleApi));
  fairness.append(row('Engine', `${config.identity.engine.name} ${config.identity.engine.version}`));
  fairness.append(row('Fingerprint', shortHex(config.identity.adapterFingerprint)));
  fairness.append(row('Paytable', `${config.identity.paytableSchema} · ${shortHex(config.identity.paytableDigest)}`));
  fairness.append(
    el(
      'p',
      'small muted',
      `A round left with no command for ${config.rules.abandonedRoundTimeoutHours} hours is closed by a forced bank at its exact current value, which is EV-neutral because every action ties. Nothing else in the game is timed.`,
    ),
  );
  fragment.append(fairness);

  const boundary = panel('What this is not');
  boundary.append(
    el(
      'p',
      'small muted',
      'Free-play prototype. No real money, no RNG certification, no laboratory approval, no jurisdictional analysis. Commit-reveal shows a seed was fixed before the round; it does not show how that seed was chosen.',
    ),
  );
  fragment.append(boundary);

  return fragment;
}
