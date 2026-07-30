/**
 * SWARM — the client.
 *
 * Portrait, one-handed, untimed. The screen flow is `docs/DESIGN.md` §5 and the
 * rules it may not break are §9: the action bar's hierarchy never changes with
 * the sign of the position, `BANK` is always the primary action, nothing on the
 * play surface says how far the stake is, no decision has a deadline, and a
 * return below the stake is never presented as a win.
 *
 * The server is authoritative for everything that matters. This file animates a
 * frame it was given, and computes exactly two things itself: the credit a
 * harvest would pay (integer minor units, floored — the same arithmetic the
 * server applies, so the preview can never be above what is paid) and the screen
 * exposure, which is a pure function of the colony value the server sent.
 */
import { ApiError, api, commandKey, generateClientSeed, isClientSeed } from './api.js';
import { credits, elapsed, multiple, percent, shortHex, signedCredits, truncate } from './format.js';
import { Sound } from './sound.js';
import { shareSheet } from './sharecard.js';
import {
  helpSheet,
  historySheet,
  receiptSheet,
  saferPlaySheet,
  verifySheet,
  wildSheet,
} from './sheets.js';
import { ENVIRONMENT_THRESHOLD, Stage } from './stage.js';

const UNIT = 1000000n;
const STAKE_STEPS = [
  100000n, 200000n, 500000n, 1000000n, 2000000n, 5000000n, 10000000n, 25000000n, 50000000n,
  100000000n, 250000000n, 500000000n, 1000000000n,
];
const ENTRY_VALUE = 0.95; // 19/20: what the colony is worth the instant it is bought.
const STORAGE_ROUND = 'swarm.roundId';
const STORAGE_EXPLAINER = 'swarm.explainer-seen';
const STORAGE_GHOST_TAUGHT = 'swarm.ghost-taught';
const STORAGE_WITNESS = 'swarm.witness';

const $ = (id) => document.getElementById(id);
const dom = {
  frame: $('frame'),
  stage: $('stage'),
  balanceButton: $('balance'),
  balance: $('balance-value'),
  sessionNet: $('session-net'),
  sound: $('sound'),
  menu: $('menu'),
  legend: $('legend'),
  strip: $('strip'),
  stripFlash: $('strip-flash'),
  yield: $('yield'),
  colonyValue: $('colony-value'),
  delta: $('delta'),
  position: $('position'),
  fill: $('stakeline-fill'),
  tick: $('stakeline-tick'),
  chips: $('chips'),
  actionbar: $('actionbar'),
  bank: $('bank'),
  bankSub: $('bank-sub'),
  harvest: $('harvest'),
  harvestSub: $('harvest-sub'),
  next: $('next'),
  nextSub: $('next-sub'),
  dots: $('dots'),
  ladderChip: $('ladder-chip'),
  s0: $('s0'),
  s0done: $('s0-done'),
  s1: $('s1'),
  stakeValue: $('stake-value'),
  stakeRange: $('stake-range'),
  sidebets: $('sidebets'),
  sidebetRows: $('sidebet-rows'),
  sidebetsToggle: $('sidebets-toggle'),
  totalAtRisk: $('total-at-risk'),
  profitRates: $('profit-rates'),
  fairness: $('fairness'),
  fairnessToggle: $('fairness-toggle'),
  serverCommitment: $('server-commitment'),
  clientSeed: $('client-seed'),
  seed: $('seed'),
  stepper: $('stepper'),
  kValue: $('k-value'),
  kRange: $('k-range'),
  kCredit: $('k-credit'),
  kLeft: $('k-left'),
  settlement: $('settlement'),
  payoutCard: $('payout-card'),
  settlementTerminal: $('settlement-terminal'),
  settlementHeadline: $('settlement-headline'),
  settlementMultiple: $('settlement-multiple'),
  settlementNet: $('settlement-net'),
  trace: $('settlement-trace'),
  settlementCopy: $('settlement-copy'),
  newRound: $('new-round'),
  openWild: $('open-wild'),
  shareOpen: $('share-open'),
  shareLink: $('share-link'),
  sheet: $('sheet'),
  sheetTitle: $('sheet-title'),
  sheetBody: $('sheet-body'),
  toast: $('toast'),
  freeplay: $('freeplay'),
  freeplayText: $('freeplay-text'),
  limitLock: $('limit-lock'),
  limitLockCopy: $('limit-lock-copy'),
  reality: $('reality'),
  realityElapsed: $('reality-elapsed'),
  realityStaked: $('reality-staked'),
  realityCredited: $('reality-credited'),
  realityNet: $('reality-net'),
  realityInterval: $('reality-interval'),
};

const state = {
  config: null,
  session: null,
  roundId: null,
  seedCommitment: null,
  clientSeed: null,
  view: null,
  frame: null,
  /** Every action-chain value this client was handed, in order, before the reveal. */
  witness: [],
  stakeUnits: 1000000n,
  sideBets: new Map(),
  previousValue: null,
  seededAt: 0,
  busy: false,
  /**
   * The input guard behind §9.7's dead period. The action bar is also inert in
   * CSS, but a rule that only lives in `pointer-events` is a rule a stray
   * synthetic tap walks straight through, and this one is a money control.
   */
  acceptsInput: false,
  k: 1,
  /**
   * §9.9's reality check. The server owns the clock — a check a reload resets is
   * not a check — and this only remembers whether one is owed, so it can be shown
   * at a safe moment rather than on top of a live decision.
   */
  realityDue: false,
  /** The screen the reality check hands control back to. */
  afterReality: 's1',
  /** Offset between this device's clock and the server's, for the session timer. */
  clockSkewMs: 0,
  /** Interval handle for whichever session clock is currently on screen. */
  ticker: null,
  /**
   * The colony value currently *on screen*, so the verdict count can roll from it
   * (§6.4). The number it lands on is always the server's exact decimal,
   * truncated — the roll is presentation and never arithmetic.
   */
  displayedValue: null,
  /** Credited-this-round minor units, which is what the vessel holds. */
  bankedUnits: 0n,
  /** Whether the environment reveal has already fired this round (§7.2). */
  revealed: false,
  /** Suppresses the balance chip while the ceremony is counting up into it. */
  holdBalance: false,
  /**
   * Everything the ceremony has in flight — pending timers and running counts.
   * A player who taps `NEW ROUND` mid-ceremony must not have the last round's
   * count-up still writing into the balance chip a second later.
   */
  ceremony: { timers: [], cancels: [] },
  /** The settled view the share card is composed from, or `null`. */
  shareable: null,
  /** This round's own frame, frozen while the colony was still standing. */
  frozenFrame: null,
};

const stage = new Stage(dom.stage);
const sound = new Sound();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ------------------------------------------------------------------ helpers

function toast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 3200);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `cubic-bezier(0.22, 1, 0.36, 1)` — §6.4's verdict-count easing. */
const outQuint = (t) => 1 - Math.pow(1 - t, 5);

/**
 * §6.4's verdict count: tabular digits roll to the new value over 380 ms, and
 * they **never round up** — every intermediate frame truncates, so the number on
 * screen is never above the value it is counting to. `finalText` is the server's
 * own exact decimal, truncated, and it is what the roll lands on: no money value
 * on this screen is ever the output of a float.
 *
 * Under `prefers-reduced-motion` this is an instant set (§6.4).
 */
function rollMultiple(node, from, to, finalText, ms = 380) {
  if (node.dataset.roll !== undefined) cancelAnimationFrame(Number(node.dataset.roll));
  if (from === null || from === undefined || reducedMotion.matches || ms <= 0) {
    node.textContent = finalText;
    delete node.dataset.roll;
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    // Clamped at *both* ends. A frame's `requestAnimationFrame` timestamp can
    // predate the `performance.now()` the roll was armed with, and `outQuint` of a
    // negative time is less than zero — which on a count-up puts a number on
    // screen below the one it started from.
    const t = Math.min(1, Math.max(0, (now - start) / ms));
    if (t >= 1) {
      node.textContent = finalText;
      delete node.dataset.roll;
      return;
    }
    const value = from + (to - from) * outQuint(t);
    node.textContent = `${truncate(Math.max(0, value).toFixed(6), 2)}x`;
    node.dataset.roll = String(requestAnimationFrame(tick));
  };
  node.dataset.roll = String(requestAnimationFrame(tick));
}

/**
 * A money figure counting up, in minor units.
 *
 * Every intermediate frame **floors** the eased value, so the number on screen is
 * never above the amount it is counting to, and the roll lands on the exact
 * integer the server sent rather than on the last frame of a float. Under
 * `prefers-reduced-motion` it is an instant set (§6.4).
 *
 * Returns a cancel function, because a player who taps `NEW ROUND` must not have
 * the previous round's count still writing into the chip.
 */
function rollUnits(node, fromUnits, toUnits, ms, onDone) {
  const from = BigInt(fromUnits);
  const to = BigInt(toUnits);
  let handle = null;
  const land = () => {
    node.textContent = credits(to);
    onDone?.();
  };
  if (reducedMotion.matches || ms <= 0 || from === to) {
    land();
    return () => {};
  }
  const start = performance.now();
  const tick = (now) => {
    // Clamped at both ends: a frame whose timestamp predates `start` would give
    // `outQuint` a negative input, and a payout that counts up from below zero is
    // a wrong number on screen at the loudest moment in the round.
    const t = Math.min(1, Math.max(0, (now - start) / ms));
    if (t >= 1) {
      land();
      return;
    }
    /*
     * The *easing* is a float; the money is not.
     *
     * The eased position is quantised to a millionth and the interpolation runs
     * in `BigInt`, so no intermediate frame is the output of floating-point
     * arithmetic on a money value. Doing it the other way — `Number(from) + ...`
     * and flooring the result — is exact only while the balance stays under
     * `Number.MAX_SAFE_INTEGER`, and "the balance is small enough" is not the
     * kind of thing a money display should be relying on.
     */
    const eased = BigInt(Math.round(outQuint(t) * 1000000));
    node.textContent = credits(from + ((to - from) * eased) / 1000000n);
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    if (handle !== null) cancelAnimationFrame(handle);
  };
}

/**
 * The balance chip counting up in AMBER (§7.1).
 *
 * Only ever called for a round that returned more than it cost. A number flowing
 * into an amber chip reads as a win in peripheral vision, so `T-nil` and
 * `T0-loss` get an instant set instead — that is one of §7.1's binding rules, not
 * a stylistic choice.
 *
 * The hold is released on every path out of here, including the ones that never
 * animate: a suppressed balance chip that nothing un-suppresses is a chip frozen
 * for the rest of the session.
 */
function rollCredits(node, fromUnits, toUnits, ms) {
  return rollUnits(node, fromUnits, toUnits, ms, () => {
    state.holdBalance = false;
  });
}

/**
 * The payout figure, sized to fit the card at any stake the game allows.
 *
 * The two loud tiers set the headline at 66 and 72 px, which is right for the
 * `11.52` a one-credit stake produces and wrong for the `527355.94` a
 * thousand-credit stake at the maximum multiple produces — nine tabular glyphs
 * at 72 px are about 400 px wide inside a card with 316 px of room, so the
 * biggest win in the game would be the one that overflowed. The figure is
 * measured from its *final* text, before the count-up starts, so it does not
 * resize while it counts.
 */
function fitHeadline(text, tier) {
  const base = tier === 'T3' ? 72 : tier === 'T2' ? 66 : 56;
  const room = 316;
  // The advance of the tabular monospace set, as a fraction of the font size.
  const advance = 0.62;
  return Math.max(30, Math.min(base, room / Math.max(1, text.length * advance)));
}

/**
 * The round's credited multiple of what the ticket cost — `X` in §7.1, the
 * figure the whole tier table is defined on.
 *
 * Truncated toward zero with integer arithmetic, like every other number in the
 * client: no money value on this screen is ever the output of a float, and a
 * displayed multiple is never above the one that was actually paid (§9.3).
 */
function stakeMultiple(creditedUnits, stakedUnits) {
  if (stakedUnits <= 0n) return '—';
  const scaled = (creditedUnits * 100n) / stakedUnits;
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
}

/**
 * Instant feedback on every tap.
 *
 * A control has to move on the frame the finger lands, not when the network
 * answers, and `:active` alone does not fire reliably on touch. This is the same
 * treatment for every control in the game, so it can never become emphasis: it
 * does not vary with what the control does or with the sign of the position
 * (§9.2).
 */
function wirePressFeedback() {
  const pressable = 'button';
  document.addEventListener(
    'pointerdown',
    (event) => {
      // The first gesture is what an AudioContext is allowed to be born on (§8).
      sound.unlock();
      const target = event.target.closest?.(pressable);
      if (target === null || target === undefined) return;
      if (target.disabled === true) return;
      target.classList.add('pressed');
      sound.tap();
    },
    { passive: true },
  );
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    document.addEventListener(
      event,
      (nativeEvent) => {
        const target = nativeEvent.target.closest?.(pressable);
        target?.classList.remove('pressed');
      },
      { passive: true },
    );
  }
  // A keyboard path has to feel the same, and §9.6 requires one everywhere.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') sound.unlock();
  });
}

function renderSoundToggle() {
  dom.sound.setAttribute('aria-pressed', String(sound.muted));
  dom.sound.setAttribute('aria-label', sound.muted ? 'Sound off' : 'Sound on');
}

function valueOf(frame) {
  return frame?.colonyValue === null || frame?.colonyValue === undefined
    ? 0
    : Number(frame.colonyValue.decimal);
}

/** `floor(stake * c(t) * k)` in minor units — the server's arithmetic, exactly. */
function creditForK(k) {
  if (state.frame?.unitValue == null) return 0n;
  const [numerator, denominator] = state.frame.unitValue.fraction.split('/').map(BigInt);
  return (state.stakeUnits * numerator * BigInt(k)) / denominator;
}

function totalAtRiskUnits() {
  let total = state.stakeUnits;
  for (const units of state.sideBets.values()) total += units;
  return total;
}

async function guard(action) {
  if (state.busy) return null;
  state.busy = true;
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError) {
      // A limit the player set is not a defect and is not shown as an error code:
      // the session is refreshed and S1 renders the locked state (§9.9).
      if (error.code === 'LIMIT_REACHED') {
        toast(error.message);
        renderSession(await api.session().catch(() => null));
        return null;
      }
      toast(`${error.code}: ${error.message}`);
      if (error.code === 'STALE_FRAME' || error.code === 'ROUND_SETTLED') await resyncRound();
    } else {
      toast('The round service is unreachable.');
    }
    return null;
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------------ session

function renderSession(session) {
  if (session === undefined || session === null) return;
  state.session = session;
  if (!state.holdBalance) dom.balance.textContent = credits(session.balanceUnits);
  const net = BigInt(session.netUnits);
  dom.sessionNet.textContent = signedCredits(net);
  dom.sessionNet.dataset.sign = net > 0n ? 'up' : 'flat';
  if (typeof session.now === 'number') state.clockSkewMs = session.now - Date.now();
  if (session.realityCheck?.due === true) state.realityDue = true;
  renderLimitLock();
}

/** Elapsed session time on the server's clock, not this device's. */
function sessionElapsedMs() {
  const session = state.session;
  if (session === null || session === undefined) return 0;
  return Math.max(0, Date.now() + state.clockSkewMs - session.startedAt);
}

/**
 * A limit the player set, when it binds, is a **state**: S1 says which limit and
 * offers the sheet, and `SEED COLONY` stops being a control rather than becoming
 * a control that fails (`docs/DESIGN.md` §9.9).
 */
function renderLimitLock() {
  const reached = state.session?.limitReached ?? null;
  dom.limitLock.hidden = reached === null;
  dom.seed.disabled = reached !== null;
  if (reached !== null) dom.limitLockCopy.textContent = reached.message;
}

/** Keeps a session clock in a sheet ticking for as long as that sheet is open. */
function tickClock(node) {
  stopTicking();
  state.ticker = setInterval(() => {
    if (!node.isConnected) {
      stopTicking();
      return;
    }
    node.textContent = elapsed(sessionElapsedMs());
  }, 1000);
}

function stopTicking() {
  if (state.ticker !== null) clearInterval(state.ticker);
  state.ticker = null;
}

// ------------------------------------------------------------------ S1

function renderStakePanel() {
  const config = state.config;
  dom.stakeValue.textContent = credits(state.stakeUnits);
  dom.stakeRange.textContent = `${credits(config.money.minStakeUnits)} – ${credits(config.money.maxStakeUnits)}`;
  dom.totalAtRisk.textContent = credits(totalAtRiskUnits());
  renderProfitRates();
  dom.seed.textContent = `SEED COLONY · ${credits(totalAtRiskUnits())}`;
}

/**
 * `docs/DESIGN.md` §9.3: the profit rate is the figure, it names the play pattern
 * it belongs to, and a combined ticket figure may be shown **only** when every
 * selected line carries the same stake — because no other ratio has been
 * enumerated. Otherwise the per-line rates are shown instead.
 */
function renderProfitRates() {
  const published = state.config.published;
  const bankFirst = published.policies.find((policy) => policy.id === 'BANK_FIRST');
  const run = published.policies.find((policy) => policy.id === 'RUN');
  const lines = [];
  lines.push(
    `COLONY finishes ahead ${percent(bankFirst.profitRate)} of rounds if you bank at generation 1, ${percent(run.profitRate)} if you never harvest.`,
  );
  const selected = [...state.sideBets.entries()];
  const equalStakes = selected.every(([, units]) => units === state.stakeUnits);
  if (selected.length === 1 && equalStakes) {
    const [id] = selected[0];
    for (const policy of ['BANK_FIRST', 'RUN']) {
      const pairing = published.ticketPairings.find(
        (entry) => entry.sideBet === id && entry.policy === policy,
      );
      if (pairing === undefined) continue;
      lines.push(
        `This ticket (${policy}) finishes ahead ${percent(pairing.ticketProfitRate)} of rounds, against ${percent(pairing.colonyOnlyProfitRate)} for the colony bet alone.`,
      );
    }
  } else if (selected.length > 0) {
    for (const [id, units] of selected) {
      const bet = state.config.sideBets.find((entry) => entry.id === id);
      lines.push(`${bet.label} wins 1 in ${bet.oneIn} rounds and pays ${multiple(bet.multiplier)} on its own ${credits(units)} stake.`);
    }
    lines.push(
      'A single combined figure is only published for equal stakes on every line, so the per-line rates are shown instead.',
    );
  }
  dom.profitRates.replaceChildren();
  for (const line of lines) {
    const node = document.createElement('p');
    node.className = 'small muted';
    node.textContent = line;
    dom.profitRates.append(node);
  }
}

function renderSideBetRows() {
  dom.sidebetRows.replaceChildren();
  for (const bet of state.config.sideBets) {
    const row = document.createElement('div');
    row.className = 'row';
    const left = document.createElement('div');
    const label = document.createElement('div');
    label.textContent = `${bet.label} · ${multiple(bet.multiplier)}`;
    const note = document.createElement('div');
    note.className = 'small muted';
    note.textContent = `${bet.description} 1 in ${bet.oneIn}.`;
    left.append(label, note);

    const controls = document.createElement('div');
    controls.className = 'stepper-control';
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '−';
    const amount = document.createElement('span');
    amount.className = 'v';
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '+';
    const render = () => {
      const units = state.sideBets.get(bet.id) ?? 0n;
      amount.textContent = units === 0n ? 'off' : credits(units);
      renderStakePanel();
    };
    const step = (direction) => {
      const units = state.sideBets.get(bet.id) ?? 0n;
      const min = BigInt(state.config.money.minSideBetStakeUnits);
      const max = BigInt(state.config.money.maxSideBetStakeUnits);
      const allowed = STAKE_STEPS.filter((value) => value >= min && value <= max);
      if (units === 0n) {
        if (direction > 0) state.sideBets.set(bet.id, allowed[0]);
      } else {
        const index = allowed.findIndex((value) => value === units);
        const nextIndex = index + direction;
        if (nextIndex < 0) state.sideBets.delete(bet.id);
        else if (nextIndex < allowed.length) state.sideBets.set(bet.id, allowed[nextIndex]);
      }
      render();
    };
    down.addEventListener('click', () => step(-1));
    up.addEventListener('click', () => step(1));
    controls.append(down, amount, up);
    row.append(left, controls);
    dom.sidebetRows.append(row);
    render();
  }
}

async function prepareRound() {
  const created = await api.createRound();
  state.roundId = created.roundId;
  state.seedCommitment = created.seedCommitment;
  renderSession(created.session);
  // The client seed is generated *here*, after the server published its
  // commitment, and is never pre-filled from a server response.
  state.clientSeed = generateClientSeed();
  dom.serverCommitment.textContent = shortHex(state.seedCommitment, 16, 12);
  dom.clientSeed.textContent = shortHex(state.clientSeed, 16, 12);
}

// ------------------------------------------------------------------ the round

function screen(name) {
  dom.s0.hidden = name !== 's0';
  dom.s1.hidden = name !== 's1';
  dom.settlement.hidden = name !== 'settlement';
  dom.stepper.hidden = name !== 'stepper';
  dom.reality.hidden = name !== 'reality';
  if (name !== 'sheet') dom.sheet.hidden = true;
  if (name !== 'reality') stopTicking();
  /*
   * The pre-round screens own the whole frame.
   *
   * Their scrims are translucent so the vent shows through them, and a translucent
   * scrim over a value strip carrying the *last* round's numbers is a ghost of a
   * position the player no longer holds. So while S0, S1 or the reality check is
   * up, the play surface below is not drawn at all. The harvest stepper and the
   * settlement keep theirs, because in both cases the numbers behind are the ones
   * the screen is about.
   */
  dom.frame.dataset.screen = name;
}

/**
 * `docs/DESIGN.md` §9.9's reality check, shown **between rounds**.
 *
 * It never lands on a live decision or on the settlement ceremony: a summary of
 * the session pushed on top of a payout is a different object — it would be
 * reading a result back at the player at the moment §7.1 governs — so it is shown
 * where the next stake is chosen, before the stake is chosen.
 */
function realityCheckOr(next) {
  if (!state.realityDue || state.session === null) {
    screen(next);
    return;
  }
  state.realityDue = false;
  state.afterReality = next;
  const session = state.session;
  dom.realityElapsed.textContent = elapsed(sessionElapsedMs());
  dom.realityStaked.textContent = credits(session.stakedUnits);
  dom.realityCredited.textContent = credits(session.creditedUnits);
  dom.realityNet.textContent = signedCredits(session.netUnits);
  dom.realityInterval.textContent = String(session.realityCheck?.intervalMinutes ?? 30);
  screen('reality');
  tickClock(dom.realityElapsed);
  void api.acknowledgeRealityCheck().then(renderSession).catch(() => {});
}

/**
 * While no round is live, the session clock is still running, so the reality
 * check has to be able to fall due on a screen nobody is sending commands from.
 * One poll a minute, and only between rounds.
 */
function pollSessionBetweenRounds() {
  setInterval(() => {
    if (state.frame !== null && state.frame?.state === 'STAGED') return;
    if (!dom.s1.hidden || !dom.s0.hidden) {
      void api
        .session()
        .then((session) => {
          renderSession(session);
          if (state.realityDue && !dom.s1.hidden) realityCheckOr('s1');
        })
        .catch(() => {});
    }
  }, 60000);
}

async function seedColony() {
  await guard(async () => {
    if (state.roundId === null) await prepareRound();
    const response = await api.open(state.roundId, {
      idempotencyKey: commandKey('open'),
      expectedFrameRevision: 0,
      stakeUnits: state.stakeUnits.toString(),
      sideBets: [...state.sideBets.entries()].map(([id, units]) => ({
        id,
        stakeUnits: units.toString(),
      })),
      clientEntropy: state.clientSeed,
    });
    localStorage.setItem(STORAGE_ROUND, state.roundId);
    state.witness = [];
    state.seededAt = Date.now();
    state.bankedUnits = 0n;
    state.revealed = false;
    state.displayedValue = null;
    state.frozenFrame = null;
    state.shareable = null;
    applyView(response);
    screen('round');
    stage.reset();
    state.previousValue = ENTRY_VALUE;
    renderFrame();
    // S2 — three organisms fade up from the vent over 700 ms, each with its own
    // breath, voice-limited so a colony reads as a chord and not as a crowd (§8).
    await stage.seed(state.config.rules.seedUnits, (index, pan) => {
      sound.breath(pan);
    });
    // Generation 1 is mandatory and carries no decision: it resolves on its own.
    await runAdvance();
  });
}

async function runAdvance() {
  const previous = state.frame;
  const response = await api.advance(state.roundId, {
    idempotencyKey: commandKey('advance'),
    expectedFrameRevision: previous.revision,
  });
  await applyResolution(previous, response);
}

async function runHarvest(units) {
  const previous = state.frame;
  // The share card's picture has to be this round's own frame, and a harvest is
  // the beat that takes the colony away — so it is frozen here, while the colony
  // is still standing, rather than at a settlement that may have nothing left to
  // photograph (§7.1).
  state.frozenFrame = stage.freeze();
  const response = await api.harvest(state.roundId, {
    idempotencyKey: commandKey('harvest'),
    expectedFrameRevision: previous.revision,
    units,
  });
  applyView(response);
  renderSession(response.session);
  // A transfer, not a gain: no swell, no shower, no count-up (§6.5 R6).
  setActionBarInert(true);
  const credited = response.receipts?.[0]?.amountUnits ?? '0';
  state.bankedUnits += BigInt(credited);
  // The trails stream into the vessel; each arrival is one soft informational
  // mark and one tick of the balance chip — the chip is where the value actually
  // landed (§5, S5), and the vessel is that value made physical on the stage.
  stage.setBanked(Number(state.bankedUnits) / Number(state.stakeUnits));
  await stage.harvest(units, state.frame.units, previous.wildUnits, () => {
    sound.banked();
    dom.balanceButton.classList.add('credited');
    setTimeout(() => dom.balanceButton.classList.remove('credited'), 320);
  });
  renderFrame();
  // The divergence is taught once, at the moment it happens, and only to a player
  // who actually holds a side bet (§4.2). It is a caption on their own decision,
  // never a standing comparison.
  const liveSideBet = state.sideBets.size > 0;
  const taught = sessionStorage.getItem(STORAGE_GHOST_TAUGHT) !== null;
  const lesson =
    liveSideBet && !taught
      ? ' Side bets follow the colony that never gets harvested. Harvesting cannot lose you one.'
      : '';
  if (lesson !== '') sessionStorage.setItem(STORAGE_GHOST_TAUGHT, '1');
  stage.setNote(
    `Banked <strong>${credits(credited)}</strong> from ${units} organism${units === 1 ? '' : 's'}.${lesson}`,
  );
  await afterBeat();
  if (state.frame.state !== 'STAGED') await terminalFlow();
}

/**
 * The resolution beat, then the verdict, then the decision — never the reverse.
 *
 * `draw flash (120 ms) → all organisms resolve simultaneously (400 ms) → verdict
 * (380 ms)` (§2), and the verdict's treatment is a function of `D` — the signed
 * change in colony value in stake multiples — and of nothing else (§6.5 R1).
 *
 * Two beats can replace the verdict. A generation that carries the colony across
 * `475/48` fires the environment reveal instead, which is 1,000 ms and after
 * which the round continues (§7.2); a generation that ends the round goes to its
 * terminal screen (§6.5). Both are handled here, in that order, because a bloom
 * is both.
 */
async function applyResolution(previous, response) {
  applyView(response);
  renderSession(response.session);
  setActionBarInert(true);
  const resolution = state.frame.lastResolution;
  stage.setNote('');

  const before = previous.stage === 0 ? ENTRY_VALUE : valueOf(previous);
  const after = valueOf(state.frame);
  const delta = after - before;
  const crossing = !state.revealed && before < ENVIRONMENT_THRESHOLD && after >= ENVIRONMENT_THRESHOLD;

  if (resolution !== null) {
    sound.drawFlash();
    // The outcome marks fire with their own bodies, at one level for all three:
    // DIE and SPLIT are both −18 dB and HOLD is −22 dB, so no per-organism event
    // carries emphasis above the neutral baseline (§6.5 R2, R3).
    await stage.resolveOutcomes(resolution, state.frame.units, (id, pan) => {
      if (id === 'SPLIT') sound.split(pan);
      else if (id === 'HOLD') sound.hold(pan);
      else sound.die(pan);
    });
  } else {
    stage.render(state.frame.units);
  }

  sound.setPopulation(state.frame.units);
  renderFrame(delta);

  if (crossing) {
    state.revealed = true;
    sound.reveal();
    await stage.revealEnvironment();
  } else {
    sound.verdict(delta);
    if (delta >= 1) void stage.medusa();
    // The verdict's treatment is a function of `D` and of nothing else (§6.5 R1),
    // so `D` is what it is given.
    await stage.verdict(delta);
  }

  await afterBeat();
  if (state.frame.state !== 'STAGED') await terminalFlow();
}

/**
 * The dead period (§9.7): the action bar is inert for 350 ms after a generation
 * reaches its resolved state, by animation or by skip. It is a floor on the
 * *cycle*, never a deadline on a decision — no floor can cost a payout.
 */
async function afterBeat() {
  await sleep(state.config.pacing.decisionDeadPeriodMs);
  setActionBarInert(false);
}

function setActionBarInert(inert) {
  dom.actionbar.classList.toggle('inert', inert);
  state.acceptsInput = !inert;
}

async function terminalFlow() {
  const terminal = state.frame.terminal;
  // A FULL BLOOM or a generation-18 finish never passed through a harvest, so the
  // colony is still on screen and this is the frame worth keeping.
  if (state.frozenFrame === null) state.frozenFrame = stage.freeze();
  sound.setPopulation(0);
  if (terminal === 'EXTINCT') {
    // The lights fade. The vessel stays lit if anything was harvested, because the
    // story is what the player kept, not what they lost (§5, S6).
    sound.extinction();
    await stage.extinguish();
    stage.setNote(
      state.bankedUnits > 0n
        ? `Colony extinct. Banked this round: <strong>${credits(state.bankedUnits)}</strong>.`
        : 'Colony extinct.',
    );
  } else if (terminal === 'THRESHOLD') {
    stage.setNote('<strong>FULL BLOOM.</strong> The colony settles at its exact value.');
  } else if (terminal === 'FINAL') {
    stage.setNote('Generation 18. The colony settles at its exact value.');
  }
  // The chip is held from here to the ceremony. The settle response credits the
  // wallet, and a chip that showed the final balance for one frame before the
  // ceremony wound it back would be a flicker at the loudest beat in the round.
  //
  // The hold is released on the failure path too. A settlement that never
  // answers leaves the round unsettled and the balance is whatever the server
  // says it is — but a hold that nothing releases suppresses the balance chip
  // for the rest of the session, which turns a transient network error into a
  // wallet that has silently stopped updating.
  state.holdBalance = true;
  let response;
  try {
    response = await api.settle(state.roundId, {
      idempotencyKey: commandKey('settle'),
      expectedFrameRevision: state.frame.revision,
    });
  } catch (error) {
    state.holdBalance = false;
    if (state.session !== null) dom.balance.textContent = credits(state.session.balanceUnits);
    throw error;
  }
  applyView(response);
  renderSession(response.session);
  // The strip behind the ceremony now shows the settled round: the side-bet chips
  // carry their real resolutions, which is the first moment they exist.
  renderFrame();
  localStorage.removeItem(STORAGE_ROUND);
  showCeremony();
}

function applyView(view) {
  state.view = view;
  state.frame = view.frame;
  retainWitness(view.frame);
  if (view.session !== undefined) renderSession(view.session);
}

/**
 * The pre-reveal witness (`docs/ENGINE.md` §4.3).
 *
 * The chain value handed back with every frame is only evidence if the player
 * keeps it: an operator that later rewrites the log cannot produce a chain the
 * retained values are a prefix of. So each one is stored, in order, before the
 * seed exists — and the verify sheet checks the settlement against what was
 * retained rather than against the list the settlement itself supplied.
 */
function retainWitness(frame) {
  if (frame === null || frame === undefined || frame.state === 'SETTLED') return;
  if (state.witness.at(-1)?.actionChain === frame.actionChain) return;
  state.witness.push({ revision: frame.revision, stage: frame.stage, actionChain: frame.actionChain });
  try {
    localStorage.setItem(
      STORAGE_WITNESS,
      JSON.stringify({ roundId: state.roundId, values: state.witness }),
    );
  } catch {
    /* a full or blocked store costs the witness, not the round */
  }
}

function loadWitness(roundId) {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_WITNESS) ?? 'null');
    return stored !== null && stored.roundId === roundId ? stored.values : [];
  } catch {
    return [];
  }
}

async function resyncRound() {
  if (state.roundId === null) return;
  try {
    const view = await api.round(state.roundId);
    if (view.state === 'AWAITING_OPEN') return;
    applyView(view);
    renderFrame();
  } catch {
    /* the round is gone; the next command will say so */
  }
}

// ------------------------------------------------------------------ rendering

function renderFrame(delta) {
  const frame = state.frame;
  if (frame === null) return;

  const value = valueOf(frame);
  stage.setValue(value);
  dom.yield.textContent =
    frame.unitValue === null
      ? 'YIELD — · GENERATION 1 IS MANDATORY'
      : `YIELD ${multiple(frame.unitValue)} / ORGANISM · ${frame.units} ALIVE`;

  // The verdict count: the digits roll to the new value across the verdict beat,
  // and land on the server's exact decimal (§6.4). Any other render is a set.
  const valueText = frame.colonyValue === null ? '—' : multiple(frame.colonyValue);
  if (delta !== undefined && frame.colonyValue !== null)
    rollMultiple(dom.colonyValue, state.displayedValue, value, valueText);
  else {
    if (dom.colonyValue.dataset.roll !== undefined) {
      cancelAnimationFrame(Number(dom.colonyValue.dataset.roll));
      delete dom.colonyValue.dataset.roll;
    }
    dom.colonyValue.textContent = valueText;
  }
  state.displayedValue = frame.colonyValue === null ? null : value;

  const bankable = frame.colonyValue === null ? 0n : creditForK(frame.units);
  dom.colonyValue.title = `${credits(bankable)} bankable now`;

  if (delta === undefined || frame.stage === 0) {
    dom.delta.textContent = '';
    delete dom.strip.dataset.band;
  } else {
    // The verdict band is keyed to D, the signed change in colony value measured
    // in stake multiples, and to nothing else (§6.5 R1).
    const band =
      delta <= -1 ? 'heavy-loss' : delta < 0 ? 'loss' : delta === 0 ? 'flat' : delta < 1 ? 'gain' : 'large-gain';
    dom.delta.dataset.band = band;
    dom.delta.textContent = `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${truncate(Math.abs(delta).toFixed(6), 2)}x THIS GENERATION`;
    // The strip takes the verdict too: the largest reading on the play surface
    // gets weight in the same band the frame does, so the beat is legible on a
    // muted phone held at arm's length and not only in the light of the stage.
    replayBandAnimation(band);
  }
  // The stake and the current bankable value are both on screen at every
  // decision (§9.3), and neither is ever dressed as a distance to travel.
  dom.position.textContent =
    frame.stage === 0
      ? `STAKE ${credits(state.stakeUnits)}`
      : `STAKE ${credits(state.stakeUnits)} · BANKABLE ${credits(bankable)}`;

  // The stake line is the exposure of a position worth exactly what was paid, so
  // the strip agrees with the frame rather than contradicting it (§6.3).
  const exposureOf = (multipleValue) =>
    0.04 + 0.96 * (Math.log2(1 + Math.max(0, multipleValue)) / Math.log2(1 + 527.355936));
  dom.fill.style.width = `${(exposureOf(value) * 100).toFixed(2)}%`;
  dom.tick.style.left = `${(exposureOf(1) * 100).toFixed(2)}%`;
  // The strip is lit by the stage above it, on the same monotone curve, so the UI
  // never disagrees with the frame about which position is richer (§6.3).
  dom.frame.style.setProperty('--strip-exposure', exposureOf(value).toFixed(4));

  renderChips();
  renderDots();

  // Where the round is, and nothing more. The one forward-looking number §9.2
  // permits — the next generation's per-organism ladder constant — lives on the
  // `NEXT` control, beside the decision it is the price of. Printing it twice put
  // it somewhere no decision was being made, which is a target rather than a
  // price, and it wrapped the footer onto two lines.
  dom.ladderChip.textContent = `GEN ${frame.stage} / ${state.config.rules.stages}`;

  renderActionBar();
}

/**
 * The verdict, on the value strip.
 *
 * `D` decides the whole treatment and nothing else does (§6.5 R1): how far the
 * numerals move, how hard the strip flashes, and — through the band — what
 * colour that flash is. A larger `D` never gets less than a smaller one (R4),
 * and `D = 0` gets a tick and no beat at all.
 *
 * Driven from the Web Animations API rather than from CSS keyframes, because a
 * band that does not change between two consecutive losing generations would not
 * restart a CSS animation, and the alternative — dropping a class and reading
 * layout to flush it — is a forced reflow six times a round on the one surface
 * that must not thrash. Every property animated here is composited.
 */
const VERDICT_BEAT = {
  'large-gain': { scale: 1.075, flash: 0.85, ms: 500 },
  gain: { scale: 1.032, flash: 0.4, ms: 400 },
  flat: null,
  loss: { scale: 0.988, flash: 0.34, ms: 360 },
  'heavy-loss': { scale: 0.968, flash: 0.62, ms: 440 },
};

function replayBandAnimation(band) {
  dom.strip.dataset.band = band;
  const beat = VERDICT_BEAT[band];
  if (beat === null || beat === undefined || reducedMotion.matches) return;
  for (const node of [dom.colonyValue, dom.stripFlash])
    for (const running of node.getAnimations?.() ?? []) running.cancel();
  dom.colonyValue.animate?.(
    [
      { transform: 'scale(1)' },
      { transform: `scale(${beat.scale})`, offset: 0.22 },
      { transform: 'scale(1)' },
    ],
    { duration: beat.ms, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
  dom.stripFlash.animate?.(
    [
      { opacity: 0, transform: 'scaleX(0.6)' },
      { opacity: beat.flash, transform: 'scaleX(1)', offset: 0.18 },
      { opacity: 0, transform: 'scaleX(1.08)' },
    ],
    { duration: beat.ms, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
}

/**
 * A live side bet's chip, derived here from the wild-line state the frame is
 * allowed to carry (§5.2) — the protocol never sends a resolution, and the
 * settled state comes from the settlement like every other credited fact.
 *
 * `docs/DESIGN.md` §4.2 is the table: FIRST LIGHT is decided by the wild line at
 * generation 1; DARK VENT is LIVE until the wild line is extinct or generation 3
 * has passed; SWARM shows its peak against the target and may flip to WON early,
 * because a peak is monotone — but "it can no longer win" is never knowable
 * early and is never implied.
 */
function chipFor(id, frame, settled) {
  const populations = frame.wildPopulations ?? [];
  if (id === 'FIRST_LIGHT') {
    const first = populations[0];
    return { state: first === undefined ? 'LIVE' : first >= 4 ? 'WON' : 'LOST', text: null };
  }
  if (id === 'DARK_VENT') {
    const extinct = populations.indexOf(0);
    if (extinct !== -1 && extinct + 1 <= 3) return { state: 'WON', text: null };
    return { state: populations.length >= 3 || settled ? 'LOST' : 'LIVE', text: null };
  }
  const peak = frame.wildPeakUnits;
  if (peak >= 10) return { state: 'WON', text: null };
  return { state: settled ? 'LOST' : 'LIVE', text: `PEAK ${peak} / 10` };
}

function renderChips() {
  dom.chips.replaceChildren();
  const frame = state.frame;
  const settled = frame.state === 'SETTLED';
  for (const [id] of state.sideBets) {
    const bet = state.config.sideBets.find((entry) => entry.id === id);
    if (bet === undefined) continue;
    const chip = chipFor(id, frame, settled);
    const node = document.createElement('span');
    node.className = 'chip';
    node.dataset.state = chip.state;
    node.dataset.settled = String(settled);
    node.textContent = `${bet.label} · ${chip.text ?? chip.state}`;
    dom.chips.append(node);
  }
}

function renderDots() {
  const stages = state.config.rules.stages;
  if (dom.dots.children.length !== stages) {
    dom.dots.replaceChildren();
    for (let index = 0; index < stages; index += 1) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dom.dots.append(dot);
    }
  }
  [...dom.dots.children].forEach((dot, index) => {
    dot.className = 'dot';
    if (index + 1 < state.frame.stage) dot.classList.add('done');
    if (index + 1 === state.frame.stage) dot.classList.add('current');
  });
}

/**
 * The action bar. Its layout, order, sizing, colour and emphasis are identical
 * whether the position is above or below the stake — only the numbers differ.
 * That is the single most important anti-chase rule in the game (§9.2).
 */
function renderActionBar() {
  const frame = state.frame;
  const live = frame.state === 'STAGED';
  const decision = live && frame.decisionOpen && frame.stage >= 1;
  dom.actionbar.classList.toggle('single', live && !decision);
  dom.bank.hidden = !decision;
  dom.harvest.hidden = !decision;
  dom.next.hidden = !live;

  if (!live) return;

  if (decision) {
    dom.bankSub.textContent = credits(creditForK(frame.units));
    const half = Math.floor(frame.units / 2);
    if (frame.units === 1) {
      dom.harvest.setAttribute('aria-disabled', 'true');
      dom.harvest.firstChild.textContent = 'HARVEST';
      dom.harvestSub.textContent = 'same as BANK at one organism';
    } else {
      dom.harvest.removeAttribute('aria-disabled');
      dom.harvest.firstChild.textContent = `HARVEST ${half}`;
      dom.harvestSub.textContent =
        frame.units >= 3
          ? `→ ${credits(creditForK(half))} · hold to choose k`
          : `→ ${credits(creditForK(half))}`;
    }
    dom.next.firstChild.textContent = 'NEXT';
    dom.nextSub.textContent =
      frame.nextUnitValue === null ? '' : `${multiple(frame.nextUnitValue)} per organism`;
  } else {
    dom.next.firstChild.textContent = 'NEXT';
    dom.nextSub.textContent =
      frame.stage === 0 ? 'generation 1 is mandatory' : 'this generation is committed';
  }
}

// ------------------------------------------------------------------ ceremony

/**
 * The round's shape, on the payout card: one bar per generation, at the
 * population that generation resolved to.
 *
 * It is the player's own resolved history — the same numbers the receipt lists —
 * so it is a record and never a counterfactual (§9.8), and there is nothing
 * forward-looking in it. It carries the same information on a loss as on a win,
 * in ASH rather than LUMEN: a colony that grew to eleven and then died is a
 * better story than a blank card, and telling it is not celebrating it.
 */
function renderTrace(populations, down) {
  dom.trace.replaceChildren();
  dom.trace.hidden = populations.length === 0;
  if (populations.length === 0) return;
  const peak = Math.max(1, ...populations);
  populations.forEach((population, index) => {
    const bar = document.createElement('span');
    bar.className = 'trace-bar';
    if (population === 0) bar.classList.add('gone');
    bar.style.height = `${Math.max(6, Math.round((population / peak) * 100))}%`;
    // The bars grow in, left to right, once the card has settled — the round
    // replayed in a third of a second. The delay is stacked on top of the
    // container's own reveal, because a bar that finishes growing while its
    // container is still transparent is a bar nobody sees grow.
    bar.style.animationDelay = `calc(var(--reveal-delay, 230ms) + ${140 + index * 26}ms)`;
    dom.trace.append(bar);
  });
  dom.trace.dataset.tone = down ? 'spent' : 'won';
}

/** Clears every timer and count the ceremony has in flight. */
function stopCeremony() {
  for (const timer of state.ceremony.timers) clearTimeout(timer);
  for (const cancel of state.ceremony.cancels) cancel();
  state.ceremony = { timers: [], cancels: [] };
}

/** Schedules a ceremony beat, tracked so a new round can cancel it. */
function beat(ms, action) {
  if (ms <= 0) {
    action();
    return;
  }
  state.ceremony.timers.push(setTimeout(action, ms));
}

/**
 * The settlement ceremony, tiered on what the round actually paid (§7.1).
 *
 * The first thing it splits on is whether the player is up or down. A round that
 * returned less than it cost gets no count-up, no amber and no share card, and
 * its signed net result is at least as prominent as the credited amount — the
 * most common outcome class in the game does not get a win's treatment.
 *
 * **A win is a sequence.** The card lands with weight, the figure counts from
 * zero, the round's take visibly leaves the vessel for the balance chip, and
 * above ten stakes the frame lifts behind it. The round-1 build had none of
 * that: the card cut from absent to fully opaque in a single frame and then held
 * still, and the one specified count-up was dead on every round whose money
 * arrived by BANK or HARVEST — which is very nearly every win a player ever
 * sees, because `balanceBeforeSettle` was captured *after* the harvest had
 * already credited the wallet, so the count ran from a number to itself.
 *
 * The count-up is therefore over the **round's whole credited total**, which is
 * the figure §7.1's tiers are defined on. `credited` sums every CREDIT receipt
 * in the round, harvests included, so `balance − credited` is exactly the
 * balance at the moment the ticket was paid for and nothing had come back. The
 * chip is set there and counts home. Nothing here is derived from a snapshot
 * that a beat earlier in the round could invalidate.
 */
function showCeremony() {
  const settlement = state.view.settlement;
  const credited = BigInt(settlement.creditedUnits);
  const staked = BigInt(settlement.stakedUnits);
  const net = BigInt(settlement.netUnits);
  // The tiers compare integers, never floats: `X` is the round's credited
  // multiple of what the ticket cost, and the first thing it splits on is whether
  // the player is up or down (§7.1).
  const atLeast = (multipleOfStake) => credited >= staked * BigInt(multipleOfStake);
  const tier =
    credited === 0n
      ? 'T-nil'
      : !atLeast(1)
        ? 'T0-loss'
        : !atLeast(2)
          ? 'T0-win'
          : !atLeast(10)
            ? 'T1'
            : !atLeast(50)
              ? 'T2'
              : 'T3';

  dom.settlement.dataset.tier = tier;
  dom.settlementTerminal.textContent =
    settlement.proof.terminal === 'RECONCILED'
      ? 'Closed by the 72-hour rule'
      : `Terminal · ${settlement.proof.terminal}`;
  // Below the stake, the signed net *is* the headline: §7.1 requires it to be at
  // least as prominent as the credited amount, and a player must never have to do
  // subtraction to find out they lost.
  const down = tier === 'T-nil' || tier === 'T0-loss';
  // Two readings, not one string: at a 1,000 stake `RETURNED 527355.94 · NET
  // +526355.94` is far wider than the card, and a single run of text breaks
  // wherever it runs out of room — which put `NET` at the end of one line and its
  // own figure at the start of the next. They wrap as units or not at all.
  dom.settlementNet.replaceChildren();
  const reading = (text) => {
    const node = document.createElement('span');
    node.textContent = text;
    return node;
  };
  if (down) dom.settlementNet.append(reading(`RETURNED ${credits(credited)} OF ${credits(staked)} STAKED`));
  else
    dom.settlementNet.append(
      reading(`RETURNED ${credits(credited)}`),
      reading(`NET ${signedCredits(net)}`),
    );
  const lines = settlement.receipts.filter((receipt) => receipt.direction === 'DEBIT').length;
  dom.settlementCopy.textContent =
    tier === 'T-nil'
      ? 'Colony extinct. Whatever was not harvested is gone.'
      : tier === 'T0-loss'
        ? 'This round returned less than it cost.'
        : `Staked ${credits(staked)} across ${lines} ${lines === 1 ? 'line' : 'lines'}.`;

  // The round's credited multiple — the tier's own basis. Wins only: below the
  // stake the signed net *is* the headline, and a third figure beside it would
  // dilute the one number §9.3 requires to lead.
  dom.settlementMultiple.hidden = down;
  if (!down) dom.settlementMultiple.textContent = `${stakeMultiple(credited, staked)}× YOUR STAKE`;

  renderTrace(settlement.proof.populations ?? [], down);

  dom.openWild.hidden = settlement.proof.sideBetResults.every(
    (result) => result.resolved === 'NOT_SELECTED',
  );

  // §7.1: the share card is available at T1, offered at T2 and T3, and does not
  // exist at any total below the stake — not offered, not available.
  const shareable = tier === 'T1' || tier === 'T2' || tier === 'T3';
  const offered = tier === 'T2' || tier === 'T3';
  state.shareable = shareable ? { tier, credited, staked, net, settlement } : null;
  dom.shareOpen.hidden = !offered;
  dom.shareLink.hidden = !shareable || offered;

  // The ceremony's own beats, per tier (§7.1). `T-nil` and `T0-loss` get the value
  // settling in place, in MIST, with no count-up into the balance chip — a number
  // flowing into an amber chip reads as a win in peripheral vision, which is
  // exactly the frame the most common outcome class in the game must not get.
  const countUp = { 'T0-win': 600, T1: 800, T2: 1000, T3: 1200 }[tier] ?? 0;
  const silence = tier === 'T2' || tier === 'T3' ? 250 : 0;
  // The figures that confirm the headline wait for the count-up to land. A loss
  // has no count-up, so on a loss the whole card is on screen inside 400 ms —
  // quick, and over.
  dom.settlement.style.setProperty(
    '--reveal-delay',
    `${countUp > 0 ? silence + 300 + countUp : 230}ms`,
  );
  sound.settle(tier);
  stopCeremony();

  const balance = BigInt(state.session?.balanceUnits ?? 0);
  // Sized from the figure the headline will *end* on, so it does not resize
  // under the count-up.
  const finalHeadline = down ? signedCredits(net) : credits(credited);
  dom.settlementHeadline.style.fontSize = `${fitHeadline(finalHeadline, tier).toFixed(1)}px`;
  if (down || countUp <= 0) {
    // The value settles in place. The chip is simply the truth, at once.
    state.holdBalance = false;
    dom.settlementHeadline.textContent = finalHeadline;
    dom.balance.textContent = credits(balance);
  } else {
    // The chip goes back to the moment the ticket was paid for, and the round's
    // whole return flows into it. The reset is simultaneous with the vessel
    // lighting, so what the player sees is money that is visibly *in the vessel*
    // and has not reached the balance yet — not a chip that glitched downward.
    state.holdBalance = true;
    dom.settlementHeadline.textContent = credits(0n);
    const from = credited > balance ? 0n : balance - credited;
    dom.balance.textContent = credits(from);
    beat(silence, () => {
      // The round's take goes home: the vessel drains and anything still alive
      // streams out of frame toward the chip, which is where the value landed.
      void stage.bankOut(() => {
        dom.balanceButton.classList.add('credited');
      });
    });
    beat(silence + 220, () => {
      dom.balanceButton.classList.add('credited');
      state.ceremony.cancels.push(
        rollUnits(dom.settlementHeadline, 0n, credited, countUp),
        rollCredits(dom.balance, from, balance, countUp),
      );
      beat(countUp + 240, () => dom.balanceButton.classList.remove('credited'));
    });
  }

  // §7.1: T2 lifts the frame one exposure stop and T3 takes it to full
  // illumination. The colony has usually just been banked away, so there is no
  // colony light left to lift — the ceremony supplies its own.
  if (tier === 'T2' || tier === 'T3') beat(silence, () => void stage.celebrate(tier));

  // The settlement hold, and the round-cycle floor: a loss cannot be skipped into
  // the next stake, and a whole round cannot be chained faster than 2.5 s (§9.7).
  dom.newRound.disabled = true;
  const wait = Math.max(
    state.config.pacing.settlementHoldMs,
    state.config.pacing.roundCycleMs - (Date.now() - state.seededAt),
  );
  setTimeout(() => {
    dom.newRound.disabled = false;
  }, Math.max(0, wait));

  screen('settlement');
}

async function newRound() {
  state.roundId = null;
  state.view = null;
  state.frame = null;
  state.previousValue = null;
  state.displayedValue = null;
  state.bankedUnits = 0n;
  state.revealed = false;
  state.shareable = null;
  state.frozenFrame = null;
  // A ceremony beat that has not fired yet must not fire after the player has
  // already asked for the next round, and a count still running must not keep
  // writing into the balance chip behind the new stake screen.
  stopCeremony();
  state.holdBalance = false;
  dom.balance.textContent = credits(state.session?.balanceUnits ?? 0);
  dom.balanceButton.classList.remove('credited');
  sound.setPopulation(0);
  stage.reset();
  dom.delta.textContent = '';
  dom.colonyValue.textContent = '—';
  dom.yield.textContent = 'YIELD —';
  dom.chips.replaceChildren();
  await guard(async () => {
    await prepareRound();
    renderStakePanel();
    realityCheckOr('s1');
  });
}

// ------------------------------------------------------------------ sheets

function openSheet(title, fragment, keepScroll = false) {
  const scroll = dom.sheet.scrollTop;
  dom.sheetTitle.textContent = title;
  dom.sheetBody.replaceChildren(fragment);
  dom.sheet.hidden = false;
  // A sheet that re-renders in place — the limits sheet after a change — keeps the
  // player where they were. Only a newly opened sheet starts at the top.
  dom.sheet.scrollTop = keepScroll ? scroll : 0;
}

/** MENU → session; the session sheet's own control → safer play. Two taps (§9.9). */
async function openSession() {
  const session = await api.session();
  renderSession(session);
  openSheet(
    'Session & history',
    historySheet(session, { onTick: tickClock, onSaferPlay: () => void openSaferPlay() }),
  );
}

async function openSaferPlay(keepScroll = false) {
  const session = await api.session();
  renderSession(session);
  openSheet(
    'Safer play',
    saferPlaySheet(state.config, session, {
      onTick: tickClock,
      onLimit: (field, value) => {
        void guard(async () => {
          const updated = await api.setLimit(field, value);
          renderSession(updated.session);
          await openSaferPlay(true);
          return null;
        });
      },
    }),
    keepScroll,
  );
}

async function openVerify() {
  const view = state.view;
  if (view?.settlement == null) return;
  const result = await api.verify(view.settlement.proof);
  openSheet('Verify', verifySheet(state.config, view, result, state.witness));
}

/**
 * The share card (§7.1). It exists at T1, T2 and T3 and at no total below the
 * stake — `state.shareable` is only ever set for those three tiers, so there is
 * no path from a losing round to this sheet.
 */
function openShare() {
  const share = state.shareable;
  if (share === null || state.view?.settlement == null) return;
  openSheet(
    'Share this round',
    shareSheet({
      view: state.view,
      tier: share.tier,
      stakeMultiple: stakeMultiple(share.credited, share.staked),
      frame: state.frozenFrame,
      onToast: toast,
    }),
  );
}

// ------------------------------------------------------------------ wiring

function wireStake() {
  const step = (direction) => {
    const min = BigInt(state.config.money.minStakeUnits);
    const max = BigInt(state.config.money.maxStakeUnits);
    const allowed = STAKE_STEPS.filter((value) => value >= min && value <= max);
    const index = allowed.findIndex((value) => value === state.stakeUnits);
    const next = Math.min(allowed.length - 1, Math.max(0, index + direction));
    state.stakeUnits = allowed[next];
    renderStakePanel();
  };
  $('stake-down').addEventListener('click', () => step(-1));
  $('stake-up').addEventListener('click', () => step(1));

  dom.sidebetsToggle.addEventListener('click', () => {
    dom.sidebets.hidden = !dom.sidebets.hidden;
    dom.sidebetsToggle.textContent = dom.sidebets.hidden ? '+ SIDE BETS' : '− SIDE BETS';
  });
  dom.fairnessToggle.addEventListener('click', () => {
    dom.fairness.hidden = !dom.fairness.hidden;
  });
  $('copy-commitment').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(state.seedCommitment ?? '');
    toast('Server commitment copied.');
  });
  $('regenerate-seed').addEventListener('click', () => {
    state.clientSeed = generateClientSeed();
    dom.clientSeed.textContent = shortHex(state.clientSeed, 16, 12);
  });
  $('edit-seed').addEventListener('click', () => {
    const entered = prompt('Your client seed — 32 bytes of hex. Every value gives the same odds.', state.clientSeed);
    if (entered === null) return;
    if (!isClientSeed(entered.trim())) {
      toast('A client seed is exactly 64 hex characters.');
      return;
    }
    state.clientSeed = entered.trim().toLowerCase();
    dom.clientSeed.textContent = shortHex(state.clientSeed, 16, 12);
  });
  dom.seed.addEventListener('click', () => void seedColony());
  $('s1-help').addEventListener('click', () => openSheet('Help & paytable', helpSheet(state.config)));
  $('s1-history').addEventListener('click', () => void guard(openSession));
  $('limit-lock-open').addEventListener('click', () => void guard(openSaferPlay));
}

function wireActions() {
  dom.bank.addEventListener('click', () => {
    if (!state.acceptsInput || state.frame?.decisionOpen !== true) return;
    void guard(() => runHarvest(state.frame.units));
  });

  let holdTimer = null;
  let held = false;
  const openStepper = () => {
    const units = state.frame?.units ?? 0;
    if (units < 3) return;
    held = true;
    state.k = Math.max(1, Math.floor(units / 2));
    dom.kRange.min = '1';
    dom.kRange.max = String(units - 1);
    dom.kRange.value = String(state.k);
    renderStepper();
    screen('stepper');
  };
  dom.harvest.addEventListener('pointerdown', () => {
    if (!state.acceptsInput || state.frame?.decisionOpen !== true || state.frame.units < 3) return;
    held = false;
    holdTimer = setTimeout(openStepper, 260);
  });
  for (const event of ['pointerup', 'pointerleave', 'pointercancel'])
    dom.harvest.addEventListener(event, () => clearTimeout(holdTimer));
  dom.harvest.addEventListener('click', () => {
    clearTimeout(holdTimer);
    if (held) {
      held = false;
      return;
    }
    const frame = state.frame;
    if (!state.acceptsInput || frame?.decisionOpen !== true) return;
    if (frame.units === 1) {
      toast('At one organism, HARVEST is the same as BANK.');
      return;
    }
    void guard(() => runHarvest(Math.floor(frame.units / 2)));
  });
  // No gesture is required beyond a tap: the stepper has a keyboard path too.
  dom.harvest.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      openStepper();
    }
  });

  dom.next.addEventListener('click', () => {
    if (!state.acceptsInput || state.frame?.state !== 'STAGED') return;
    void guard(() => runAdvance());
  });

  // Tapping the stage skips the animation. It buys the resolved state, never the
  // next decision: the action bar is inert for the dead period afterwards.
  dom.stage.addEventListener('click', () => stage.skip());

  $('k-down').addEventListener('click', () => setK(state.k - 1));
  $('k-up').addEventListener('click', () => setK(state.k + 1));
  dom.kRange.addEventListener('input', () => setK(Number(dom.kRange.value)));
  $('k-cancel').addEventListener('click', () => screen('round'));
  $('k-commit').addEventListener('click', () => {
    const k = state.k;
    screen('round');
    void guard(() => runHarvest(k));
  });
}

function setK(value) {
  const units = state.frame?.units ?? 2;
  state.k = Math.min(units - 1, Math.max(1, value));
  dom.kRange.value = String(state.k);
  renderStepper();
}

function renderStepper() {
  const units = state.frame?.units ?? 0;
  dom.kValue.textContent = String(state.k);
  dom.kCredit.textContent = credits(creditForK(state.k));
  const left = units - state.k;
  dom.kLeft.textContent = `${left} organism${left === 1 ? '' : 's'}`;
  $('k-commit').textContent = `HARVEST ${state.k} → ${credits(creditForK(state.k))}`;
}

function wireSheets() {
  dom.menu.addEventListener('click', () => void guard(openSession));
  /*
   * The mute toggle (§8's mix rules).
   *
   * The game is fully playable muted: every audio event has a visual counterpart
   * and every visual event that carries money information has an audio one, so a
   * muted phone loses nothing but pleasure. That is why this is a plain toggle
   * with nothing attached to it — no "turn sound on for the full experience", no
   * warning, no re-prompt.
   */
  dom.sound.addEventListener('click', () => {
    sound.unlock();
    sound.setMuted(!sound.muted);
    renderSoundToggle();
  });
  // The free-play marker is the visible link to help resources §9.9 asks for, on
  // every screen and one tap from every screen.
  dom.freeplay.addEventListener('click', () => void guard(openSaferPlay));
  $('reality-continue').addEventListener('click', () => screen(state.afterReality ?? 's1'));
  $('reality-limits').addEventListener('click', () => {
    screen(state.afterReality ?? 's1');
    void guard(openSaferPlay);
  });
  $('sheet-close').addEventListener('click', () => {
    stopTicking();
    dom.sheet.hidden = true;
  });
  dom.newRound.addEventListener('click', () => void newRound());
  $('open-receipt').addEventListener('click', () =>
    openSheet('Receipt', receiptSheet(state.config, state.view)),
  );
  $('open-verify').addEventListener('click', () => void guard(openVerify));
  dom.shareOpen.addEventListener('click', () => openShare());
  dom.shareLink.addEventListener('click', () => openShare());
  dom.openWild.addEventListener('click', () =>
    openSheet('The wild line', wildSheet(state.config, state.view)),
  );
  dom.s0done.addEventListener('click', () => {
    localStorage.setItem(STORAGE_EXPLAINER, '1');
    realityCheckOr('s1');
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  state.config = await api.config();
  dom.legend.textContent = state.config.rules.offspring
    .map((band) => `${band.id} ${band.percent}%`)
    .join(' · ');
  // The explainer's own legend comes from the same served paytable as the stage's,
  // so the first screen a player sees cannot disagree with the model either (§5, S0).
  for (const band of state.config.rules.offspring) {
    const cap = document.querySelector(`#s0-outcomes .cap[data-outcome="${band.id}"]`);
    if (cap !== null) cap.textContent = `${band.id} ${band.percent}%`;
  }
  // The persistent free-play marker, from the server rather than hard-coded here.
  dom.freeplayText.textContent =
    state.config.protection?.freePlayNotice ?? 'FREE-PLAY DEMO CREDITS · NO CASH VALUE';
  renderSession(await api.session());
  wireStake();
  wireActions();
  wireSheets();
  wirePressFeedback();
  renderSoundToggle();
  renderSideBetRows();

  // Reconnect: dropping mid-round returns to the exact decision state, including
  // whether this generation's decision is still open (§5). Nothing resolved while
  // the player was away — the round only advances on their tap.
  const stored = localStorage.getItem(STORAGE_ROUND);
  if (stored !== null) {
    try {
      const view = await api.round(stored);
      if (view.state !== 'AWAITING_OPEN' && view.settlement === null) {
        state.roundId = stored;
        state.seedCommitment = view.seedCommitment;
        state.clientSeed = view.clientEntropy;
        state.stakeUnits = BigInt(view.stakeUnits);
        state.sideBets = new Map(
          Object.entries(view.sideBetStakes).map(([id, units]) => [id, BigInt(units)]),
        );
        state.seededAt = Date.now() - state.config.pacing.roundCycleMs;
        state.witness = loadWitness(stored);
        applyView(view);
        // A restored round has no beat to play: the colony is drawn where it
        // already is, and the environment is lit if the position it is being
        // restored to is worth it — the reveal is a value, not an event (§7.2).
        stage.render(state.frame.units, { immediate: true });
        stage.setValue(valueOf(state.frame));
        state.revealed = valueOf(state.frame) >= ENVIRONMENT_THRESHOLD;
        state.bankedUnits = BigInt(state.frame.creditedUnits ?? '0');
        if (state.bankedUnits > 0n)
          stage.setBanked(Number(state.bankedUnits) / Number(state.stakeUnits));
        sound.setPopulation(state.frame.units);
        renderFrame();
        setActionBarInert(false);
        screen('round');
        toast('Round restored. Nothing resolved while you were away.');
        if (state.frame.state !== 'STAGED') await terminalFlow();
        return;
      }
    } catch {
      /* fall through to a fresh round */
    }
    localStorage.removeItem(STORAGE_ROUND);
  }

  await prepareRound();
  renderStakePanel();
  const first = localStorage.getItem(STORAGE_EXPLAINER) === null ? 's0' : 's1';
  // The explainer is shown before a round and never after a loss (§5, S0), so a
  // reality check that is already due waits behind it rather than in front of it.
  if (first === 's0') screen('s0');
  else realityCheckOr('s1');
  pollSessionBetweenRounds();
}

boot().catch((error) => {
  console.error(error);
  toast('SWARM could not reach the round service.');
});
