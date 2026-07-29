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
import { credits, duration, elapsed, multiple, percent, shortHex, signedCredits, truncate } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The help-resource panel of `docs/DESIGN.md` §9.9.
 *
 * Independent support organisations, served by `/api/config` so the client
 * cannot drift from what the operator publishes, and real links rather than
 * placeholder text: a help resource that does not resolve is not a help
 * resource, whatever the fidelity of everything around it.
 */
function helpResourcesPanel(config) {
  const node = panel('If gambling stops being fun');
  node.append(
    el(
      'p',
      'small muted',
      'SWARM is a free-play prototype and none of these credits are money. These organisations are independent of this game and of Axiom Games, and they help with real gambling wherever you play it.',
    ),
  );
  for (const resource of config.protection?.helpResources ?? []) {
    const link = el('a', 'resource');
    link.href = resource.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.append(el('span', null, resource.name));
    link.append(el('span', 'url', resource.url));
    link.append(el('span', 'detail', resource.detail));
    node.append(link);
  }
  return node;
}

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
export function verifySheet(config, view, result, witness = []) {
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

  const log = panel('Action log, with the chain it folds into');
  // The chain folds one RESOLVE per generation and one event per decision, in
  // order, so the value that seals the action at generation g — the g-th
  // resolution and the i decisions before it — is at index g + i + 1.
  log.append(
    table(
      ['Event', 'Gen', 'Units', 'Chain after'],
      proof.actionLog.map((action, index) => [
        action.kind,
        action.generation,
        action.units,
        shortHex(proof.liveChainValues[action.generation + index + 1] ?? proof.actionChain, 6, 4),
      ]),
    ),
  );
  fragment.append(log);

  const held = panel('What you were handed, before the seed existed');
  if (witness.length === 0) {
    held.append(
      el(
        'p',
        'small muted',
        'This device did not retain the chain values for this round — it was reloaded, or the round was restored after the fact. The settlement below still re-derives, but only against the list the settlement itself published: a retained witness is what makes the log evidence against a third party (docs/ENGINE.md §4.3).',
      ),
    );
  } else {
    const published = new Set(proof.liveChainValues);
    const matched = witness.filter((entry) => published.has(entry.actionChain));
    held.append(row('Values retained', String(witness.length)));
    held.append(
      row(
        'Present in the settled chain',
        `${matched.length} / ${witness.length}`,
        matched.length === witness.length ? '' : 'muted',
      ),
    );
    held.append(
      table(
        ['Command', 'Gen', 'Chain'],
        witness.map((entry) => [
          entry.revision,
          entry.stage,
          shortHex(entry.actionChain, 6, 4),
        ]),
      ),
    );
    held.append(
      el(
        'p',
        'small muted',
        'Each of these was handed to this device during the round, while the server seed was still sealed. An operator that rewrote the log afterwards could not produce a chain these are a prefix of.',
      ),
    );
  }
  fragment.append(held);

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

  // The screen where a player evaluates fairness is the screen that has to say
  // who wrote the lifecycle they are verifying.
  fragment.append(provenancePanel(config));

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
    // The lit bars are the generations the player's own round covered — a window
    // marker on the *wild* line, not their colony drawn beside it.
    if (index < proof.populations.length) bar.classList.add('player');
    bar.style.height = `${Math.max(2, (population / peak) * 100)}%`;
    bar.title = `generation ${index + 1}: ${population}`;
    bars.append(bar);
  });
  chart.append(bars);
  chart.append(row('Populations', wild.populations.join(' → ')));
  chart.append(row('Peak', String(wild.peak)));
  chart.append(row('Terminal', wild.terminal));
  /*
   * `docs/DESIGN.md` §9.8 permits the completed counterfactual here, and its
   * closing sentence says what it may never become: "an alternative colony they
   * could have had". A `YOUR COLONY 5 → 2 → 3 → 2 → 0` row printed directly under
   * `5 → 4 → 4 → 2 → 0` is the game itself drawing that comparison, in the one
   * place it had promised not to. It is cut. What replaces it is the fact the bet
   * actually needed: how much of this line the player's round covered.
   */
  chart.append(
    row(
      'Your round covered',
      proof.populations.length === 0
        ? '—'
        : `generation 1 to ${proof.populations.length} of ${wild.populations.length}`,
    ),
  );
  chart.append(
    el(
      'p',
      'small muted',
      'The lit bars are the generations your round ran for. This is the line your side bets resolve on, not a colony you could have had: it is never harvested, so it is never the colony you were holding.',
    ),
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

/**
 * S10 — history and the session summary. Never a positive-only "wins" view.
 *
 * This is what the top-bar `MENU` opens, so `docs/DESIGN.md` §9.9's first
 * requirement lands here: **session timer and net result in the top-bar menu**.
 * The timer ticks — `onTick` is handed the element so the caller can keep it
 * live — because a session clock that is only correct at the moment the sheet
 * opened is a screenshot, not a timer.
 */
export function historySheet(session, handlers = {}) {
  const fragment = document.createDocumentFragment();
  const summary = panel('This session');
  const clock = el('span', 'v', elapsed(session.elapsedMs ?? 0));
  const clockRow = el('div', 'row');
  clockRow.append(el('span', 'k', 'Session time'));
  clockRow.append(clock);
  summary.append(clockRow);
  handlers.onTick?.(clock, session);
  summary.append(row('Opening balance', credits(session.openingUnits)));
  summary.append(row('Balance', credits(session.balanceUnits)));
  summary.append(row('Total staked', credits(session.stakedUnits)));
  summary.append(row('Total credited', credits(session.creditedUnits)));
  summary.append(row('Net result', signedCredits(session.netUnits)));
  fragment.append(summary);

  // §9.9: limits reachable in two taps. This sheet is the first (MENU); the
  // control below is the second.
  if (handlers.onSaferPlay !== undefined) {
    const safer = el('button', 'cta ghost', 'LIMITS & SAFER PLAY');
    safer.type = 'button';
    safer.addEventListener('click', () => handlers.onSaferPlay());
    fragment.append(safer);
  }

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

/** Presets each limit steps through. `null` is the first stop and means "off". */
const LIMIT_PRESETS = {
  budgetUnits: [null, 25n, 50n, 100n, 250n, 500n, 1000n].map((value) =>
    value === null ? null : value * 1000000n,
  ),
  lossUnits: [null, 10n, 25n, 50n, 100n, 250n, 500n].map((value) =>
    value === null ? null : value * 1000000n,
  ),
  timeMinutes: [null, 15, 30, 60, 120, 180, 240],
};

/**
 * Safer play — `docs/DESIGN.md` §9.9's limits, reality check and help resources.
 *
 * Two taps from the top bar (`MENU` → `LIMITS & SAFER PLAY`) and one from the
 * free-play marker at the bottom of every screen.
 *
 * The asymmetry is the point and it is stated on the screen rather than
 * discovered: setting or lowering a limit binds on the next stake, while raising
 * or removing one waits out a cool-off. A limit that can be lifted at the moment
 * it starts to bind is a limit that protects nobody.
 */
export function saferPlaySheet(config, session, handlers = {}) {
  const fragment = document.createDocumentFragment();
  const limits = session.limits ?? { pending: [] };
  const protection = config.protection ?? {};

  const state = panel('This session');
  const clock = el('span', 'v', elapsed(session.elapsedMs ?? 0));
  const clockRow = el('div', 'row');
  clockRow.append(el('span', 'k', 'Session time'));
  clockRow.append(clock);
  state.append(clockRow);
  handlers.onTick?.(clock, session);
  state.append(row('Total staked', credits(session.stakedUnits)));
  state.append(row('Net result', signedCredits(session.netUnits)));
  fragment.append(state);

  const controls = panel('Your limits');
  controls.append(
    el(
      'p',
      'small muted',
      `Off by default. Setting or lowering a limit applies to your next stake; raising or removing one takes effect ${protection.limitCoolOffHours ?? 24} hours later. A limit never interrupts a round you have already staked — you can always finish it and bank it.`,
    ),
  );
  for (const definition of protection.limits ?? []) {
    const presets = LIMIT_PRESETS[definition.field] ?? [null];
    const current = limits[definition.field] ?? null;
    const normalized =
      current === null ? null : definition.kind === 'money' ? BigInt(current) : Number(current);
    const format = (value) =>
      value === null ? 'off' : definition.kind === 'money' ? credits(value) : duration(value);

    const block = el('div');
    block.style.padding = '8px 0';
    const head = el('div', 'row');
    head.append(el('span', 'k', definition.label));
    block.append(head);
    block.append(el('p', 'small muted', definition.description));

    const stepper = el('div', 'stepper-control');
    const down = el('button', null, '−');
    down.type = 'button';
    down.setAttribute('aria-label', `Lower the ${definition.label.toLowerCase()}`);
    const value = el('div', 'value', format(normalized));
    value.style.fontSize = '20px';
    const up = el('button', null, '+');
    up.type = 'button';
    up.setAttribute('aria-label', `Raise the ${definition.label.toLowerCase()}`);
    const indexOf = () => {
      const found = presets.findIndex(
        (preset) => (preset === null) === (normalized === null) && String(preset) === String(normalized),
      );
      return found === -1 ? 0 : found;
    };
    const step = (direction) => {
      const next = Math.min(presets.length - 1, Math.max(0, indexOf() + direction));
      const chosen = presets[next];
      handlers.onLimit?.(
        definition.field,
        chosen === null ? null : definition.kind === 'money' ? chosen.toString() : chosen,
      );
    };
    down.addEventListener('click', () => step(-1));
    up.addEventListener('click', () => step(1));
    stepper.append(down, value, up);
    block.append(stepper);

    const pending = (limits.pending ?? []).find((entry) => entry.field === definition.field);
    if (pending !== undefined) {
      const target =
        pending.value === null
          ? 'off'
          : definition.kind === 'money'
            ? credits(pending.value)
            : duration(Number(pending.value));
      block.append(
        el(
          'p',
          'small muted',
          `Scheduled: ${target}, from ${new Date(pending.effectiveAt).toLocaleString()}. Until then this limit stays where it is. Lowering it again cancels the change.`,
        ),
      );
    }
    controls.append(block);
  }
  fragment.append(controls);

  const check = panel('Reality check');
  check.append(row('Every', duration(protection.realityCheckMinutes ?? 30)));
  check.append(row('Since the last one', elapsed(session.realityCheck?.sinceMs ?? 0)));
  check.append(
    el(
      'p',
      'small muted',
      'A summary of your session appears between rounds at that interval. It cannot be turned off, and it never appears while a decision is open.',
    ),
  );
  fragment.append(check);

  fragment.append(helpResourcesPanel(config));

  const boundary = panel('What these credits are');
  boundary.append(
    el(
      'p',
      'small muted',
      `${protection.freePlayNotice ?? 'FREE-PLAY DEMO CREDITS · NO CASH VALUE'}. The balance is an in-memory number that resets when the server restarts. Nothing here can be deposited, withdrawn or exchanged, and there is no real-money mode behind it.`,
    ),
  );
  fragment.append(boundary);

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
      ['Gen', 'Per organism', 'Colony of 3', 'Organisms worth more than the stake'],
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

  fragment.append(provenancePanel(config));

  const boundary = panel('What this is not');
  boundary.append(
    el(
      'p',
      'small muted',
      'Free-play prototype. No real money, no RNG certification, no laboratory approval, no jurisdictional analysis. Commit-reveal shows a seed was fixed before the round; it does not show how that seed was chosen.',
    ),
  );
  fragment.append(boundary);

  fragment.append(helpResourcesPanel(config));

  return fragment;
}

/**
 * Who built what — on the screen where a player evaluates fairness, not only in
 * the repository's prose.
 *
 * `reveal-engine/staged-survival-v1` is **SWARM's** module contract, specified in
 * `docs/ENGINE.md` and implemented in this repository. It is not the identity of
 * the `staged-survival` module Reveal Engine 0.4 ships, and printing it in a row
 * labelled `MODULE` directly above the engine's name and version claimed a
 * conformance that does not exist. Both identities are now named with their
 * owners, and the split is stated in the same panel.
 */
function provenancePanel(config) {
  const engine = config.identity.engine;
  const contract = config.identity.adapterContract;
  const node = panel('Who implements what');
  node.append(row('Game', `${config.identity.adapterId} @ ${config.identity.adapterVersion}`));
  node.append(row('Its module contract', contract.id));
  node.append(row('Written by', contract.owner));
  node.append(row('Implemented by', contract.implementedBy));
  node.append(row('Engine package', `${engine.name} ${engine.version}`));
  node.append(row('Engine API', engine.apiVersion));
  node.append(
    row('Engine module API', `${engine.moduleApiVersion} · ${engine.shippedModule.id} ${engine.shippedModule.version}`),
  );
  node.append(el('p', 'small muted', `From the engine: ${engine.provides}`));
  node.append(el('p', 'small muted', `Not from the engine: ${engine.doesNotProvide}`));
  node.append(el('p', 'small muted', contract.note));
  return node;
}
