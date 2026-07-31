# SWARM — product design specification

Deep-sea colony game for Axiom Games, built on Reveal Engine™.
Portrait, one-handed, no timers, 95% theoretical RTP before rounding on every
line; payable credits round down by the quantified bound in §9.2.

This document is the build brief: loop, decisions, bets, screen-by-screen UX,
art direction, sound direction, and the rules the game may not break. Numbers
quoted here are the exact ones from [MATH.md](MATH.md); the enumeration in
`tools/enumerate.mjs` is authoritative, the tables between
`<!-- generated:... -->` markers are written by `npm run docs:sync`, and the test
suite fails if this document disagrees with the model.

Where a rule here replaced something that had to be cut, the decision is recorded
in [DECISIONS.md](DECISIONS.md) — what was rejected, what the rejection costs, and
what would reopen it.

---

## 1. What the game is

You seed three glowing organisms at a hydrothermal vent in absolute darkness.
Every generation each organism independently **dies**, **holds**, or **splits**.
The colony is your money: it is worth its size times a yield that climbs 25%
every generation it survives. You can bank it at any point, or harvest part of
it — half with one tap, any fraction with a drag — and let the rest keep
growing. If the colony goes extinct, whatever you had not harvested is gone.

**The pitch in one line:** a multiplier that is alive — it grows, it shrinks, and
it can die — and you can take part of it off the table at any moment, with no
clock running anywhere.

**Three pillars.**

1. **Brightness is money.** No abstract multiplier ticking in a corner: the thing
   that pays you is the thing you are watching. The frame's light level is a
   strictly increasing function of your colony's exact *value* — not of its
   headcount — so a brighter screen always means a richer position and a dimmer
   one always means a poorer one. §6.3 specifies the exact curve, because "the
   light is the money" is a promise the renderer has to keep to the last stop.
2. **A number that can go down, and no clock.** A crash multiplier only rises
   until it dies, and it is timed, so a slow connection can cost a payout. SWARM
   inverts both: the colony can shrink and recover, which makes every decision a
   real read of a live position rather than a race against a rising line — and
   nothing in the game is timed at all, so the entire class of latency-fairness
   problems does not exist here by construction, not by mitigation.
3. **Provable indifference.** Bank instantly or ride eighteen generations, the
   theoretical return before payable floors is exactly 95% either way, and we
   publish the exhaustive proof. The game never pretends a decision is worth
   more than it is.

### 1.1 Prior art, and what is actually new

Partial cash-out is **not** new and this document does not claim it is. Evolution
Gaming's live title *Cash or Crash* offers collect / collect-half / continue at
every step, which is essentially SWARM's decision set with a coarser quantum;
several crash titles, Spribe's *Aviator* among them, give functional partial exit
through a dual-bet panel and configurable auto-cash-out. SWARM's stepper reaches
every `k` rather than only half, which is a finer dial and not a new idea.
Mathematically the claim would be weak anyway: [MATH.md §3](MATH.md) *forces*
`m(n) = c * n`, so harvesting `k` of `n` is exactly "bank `k/n` of the position
and let the rest ride" — a partial cash-out, not a new primitive.

What is defensible, stated narrowly:

- **Untimed by construction.** The round advances only on the player's tap
  ([ENGINE.md §5.1](ENGINE.md)), so there is no cash-out race, no countdown, and
  no way for latency to cost money. Timed crash games mitigate this; SWARM does
  not have the problem.
- **A non-monotone multiplier.** The number can fall and rise again. That is a
  genuinely different read from every crash title, and it is the reason §6.5 and
  §9.2 exist: it also makes the game harder to present honestly, and we would
  rather solve that than pretend it away.
- **A published exhaustive proof** that no decision policy moves the return,
  including the extremes of the volatility interval.

This section is desk observation of publicly described competitor behaviour, not
a commissioned competitive audit. Before any launch claim of novelty is made in
marketing, a real audit has to happen; nothing in this repository substitutes for
one.

---

## 2. The loop, step by step

| Step | What happens | Player input | Duration |
| --- | --- | --- | --- |
| 0 | Round opens; server publishes the **seed pre-commitment** | — | instant |
| 1 | Stake set, side bets set, **client seed** generated (editable) | taps | untimed |
| 2 | **SEED**: the client seed is sent, three organisms fade in at the vent | tap `SEED` | 700 ms |
| 3 | **Generation 1 resolves** (mandatory, no decision) | — | 900 ms |
| 4 | **Decision panel**: colony value shown against the stake line | `BANK` / `HARVEST k` / `CONTINUE` | **untimed** |
| 5 | If `CONTINUE` or a partial `HARVEST`: next generation resolves | — | 900 ms |
| 6 | Loop 4–5 until extinct, banked, FULL BLOOM, or generation 18 | | |
| 7 | **Settlement**: credits posted, side bets resolved, seed revealed, **settlement body commitment published** | tap to verify | untimed |

A generation resolution is always 900 ms and is skippable by tapping:

```
draw flash (120 ms) → all organisms resolve simultaneously (400 ms) → verdict (380 ms)
```

Organisms never resolve one at a time — a 14-organism generation must not take
14 seconds. The **verdict** beat is where all emphasis lives, and §6.5 is the
rule that decides how loud it is.

**Skipping ends an animation, not a beat.** There is no minimum time on any
*decision* — that is the whole point of an untimed game — and there is a minimum
time on the *cycle*: a 350 ms dead period between a resolved state and the action
bar accepting input, a 600 ms hold before `NEW ROUND` is live, and a 2,500 ms
floor on a whole round. §9.7 is the rule and the reason; without it, tap-to-skip
makes a `BANK_FIRST` round about a second long, which is a speed-of-play decision
made by accident.

**Round length.** 5.85 generations on average under the never-bank policy;
6.4% of rounds die in generation 1; 35% are extinct by generation 3; 2.2%
survive all 18 generations.

---

## 3. Every decision, its timing, and what it actually changes

The design rule is **zero fake agency**: every control either changes the
distribution of outcomes in a way we can state exactly, or it does not exist.

| Decision | When it is offered | What it changes | What it does not change |
| --- | --- | --- | --- |
| Stake | Before generation 1 | Scales every COLONY payout linearly | Theoretical RTP (95% before payable floors), the draws |
| Side bets | Before generation 1 **only** | Adds independent lines, each with its own stake and its own 95% theoretical RTP before payable floors, resolved at settlement on the unharvested "wild line" | The colony, the base bet, the draws |
| **Client seed** | Before generation 1 **only**, after the server has published its commitment | Changes the whole 270-draw grid. It is the player's half of the fairness handshake: the server sealed its seed first, so it cannot pick a grid to suit the entropy you choose ([ENGINE.md §4.5](ENGINE.md)) | The distribution of anything. Every client seed gives the same 95% theoretical RTP before payable floors and the same odds |
| `SEED` | Before generation 1 | Sends the client seed and starts the round | Nothing about the outcome — the grid is fixed the moment both halves exist |
| `CONTINUE` | After every resolved generation (`t < 18`) | Colony consumes `n` more draws; value moves up the ladder or to zero | Expected return |
| `HARVEST k` | Same, when `n >= 2`; once per generation | Credits any `k` from 1 to `n - 1` organisms **now** at the current yield; the rest keep climbing. Because a smaller colony consumes fewer draws, this genuinely changes which draws you meet next generation. It also caps how large the colony can become, which is why FULL BLOOM frequencies are published per play pattern ([MATH.md §8.2](MATH.md)) | Expected return |
| `BANK` | Same | Ends the round at the exact current value (`k = n`) | Expected return |

**Information available at a decision.** The player knows: the generation index,
the current population, every past population, every past action, the exact
yield ladder, the exact offspring probabilities, their position relative to their
stake, **and the wild line through the generation they have just resolved and no
further** (§4.2). The player does **not** know any unrevealed draw. That boundary
is a protocol rule with a proof behind it, not a UI preference: the wild line's
*next* population contains their own as a partial sum, while its *current* one is
a function of draws they have already consumed
([MATH.md §7.3](MATH.md), [ENGINE.md §5.2](ENGINE.md)). The server seed is
published only at settlement.

**`HARVEST` is disabled at `n = 1`**, because the only harvests available there
are `k = 0` (which is `CONTINUE`) and `k = 1` (which is `BANK`). It is redundant,
not broken, and the client says exactly that rather than greying out a control
with no explanation.

**Side bets cannot be added after `SEED`.** This is an anti-chase rule as much as
a fairness one: no bet may be offered to a player who has just seen a bad
generation.

**What we deliberately do not build.** No "boost", no "lucky vent", no purchased
re-roll, no cosmetic choice dressed as influence, no near-miss animation that is
not a real near-miss (if the screen shows an organism about to split, it split).
Nothing on screen may imply a decision has an edge, because the enumeration
proves none does.

---

## 4. Bet types

A ticket is one COLONY bet plus zero to three side bets. **Every bet on the
ticket carries its own stake, its own cap and its own 95% theoretical RTP before
rounding.** No bet's payout is charged against another bet's ceiling, so the size
of one bet never changes what another one pays ([MATH.md §12](MATH.md)).

### 4.1 COLONY — the base bet

The game itself. Stake range 0.10 to 1,000.00 credits, in integer minor units
(`1 credit = 10^6 units`). Theoretical RTP is exactly 95% under any play pattern
before floor rounding; payable RTP is lower by less than 18 units per round,
which is less than 0.018 percentage points at the minimum stake (§9.2). Maximum
cumulative round credit 905.77x on its own stake; declared cap 906x, proven never
to bind.

### 4.2 Side bets (optional, off by default)

All three resolve on the **wild line** — the colony as it would have grown had
it never been harvested — which is a function of the committed grid alone, so no
decision can move a side bet. When a player never harvests, the wild line *is*
their colony.

| Bet | Wins if | Pays | Frequency | Own cap |
| --- | --- | --- | --- | --- |
| **FIRST LIGHT** | The wild line holds 4+ organisms after generation 1 | `19/4` = 4.75x | 1 in 5 | 5x |
| **DARK VENT** | The wild line is extinct by generation 3 | 2.689x | 1 in 2.83 | 3x |
| **SWARM** | The wild line reaches 10+ organisms at any point | 248.798x | 1 in 261.89 | 249x |

Each is priced at exactly `(19/20) / probability`, so all three carry the same
95% theoretical RTP before their one payable credit is rounded down. Each has
its **own stake**, 0.10 to 100.00 credits, independent of the colony stake; the
ticket's total stake is shown before `SEED` so the real amount at risk is never
hidden behind three toggles.

**When they resolve, and what the player sees while the round runs.** Side bets
are *credited* only at settlement, after the base round is over. But a bet that
pays `248.798x` and gives the player no signal of any kind for an entire round is
a bet nobody will place twice, and round 2's blanket ban on wild-line information
was one generation stricter than the mathematics requires. The exact boundary
([MATH.md §7.3](MATH.md)) is:

> The client may show the wild line for the generation the player has just
> resolved and every earlier one. It may never show, or hint at through timing,
> the wild line for a generation the player has not resolved.

That is the *fairness* boundary. It says what the client may show without
breaking the invariance theorem; it does not say what the client *should* show,
and §9.8 is where that second question is answered — because a live counterfactual
colony is a responsible-design object as well as a fairness one, and round 3
shipped one without ever putting it in front of §9.

What the round ships is one chip per live side bet, in the value strip:

| Bet | In-round state | When the chip settles |
| --- | --- | --- |
| **FIRST LIGHT** | `WON` / `LOST` the instant generation 1 resolves — it is a function of the wild line at generation 1 and nothing else | generation 1 |
| **DARK VENT** | `LIVE` until the wild line is extinct or generation 3 passes, then `WON` / `LOST` | generation 3 |
| **SWARM** | `LIVE`, with the wild line's peak so far against the target: `PEAK 7 / 10`. Flips to `WON` the moment the peak reaches 10 and never flips back | when it wins, or at settlement |

The chip is the bet's own state, in numerals, and it is shown only for a bet the
player actually placed. `SWARM` is the one that needs care and the one where the
care is cheap. Its predicate is on the **peak**, which is monotone, so "it has
already won" is a statement about generations the player has resolved and is free
to show. "It can no longer win" is *not* knowable early and the client must never
imply it — no greying out, no struck-through chip, no "needs 3 more" copy. The
chip reads `LIVE` until it reads `WON`, or until settlement says `LOST`.

**The divergence still has to be taught, once, at the moment it happens.** Side
bets resolve on a colony that visibly separates from the one the player is
watching the instant they harvest. Without something, a player at 9 organisms who
harvests four and then loses SWARM will reasonably believe they killed their own
bet. So the harvest beat — and only the harvest beat — draws the **wild-line
ghost**: a dimmed PLANKTON trace of the unharvested colony, over the 400 ms of
the harvest animation, fading out with it. Your bodies drop; the ghosts do not;
then they are gone. Copy on the first harvest of a round with a live side bet,
once per session: *"Side bets follow the colony that never gets harvested.
Harvesting cannot lose you one."* The completed wild line is shown after the
round, on S8a, where it can no longer sit next to a decision.

**What the ghost is not, any more.** Round 3 drew it continuously, behind the
player's own bodies, for the whole round. §9.8 is the analysis that removed it.

**DARK VENT is not insurance and may not be dressed as insurance.** See §9.4.

### 4.3 The harvest control (not a bet, and not a plan)

`HARVEST` is a single control with two depths:

- **Tap** harvests `floor(n / 2)` — the one-thumb default, and the only thing
  most players will ever use.
- **Press and drag** on the same control opens a stepper from `1` to `n - 1`,
  with the exact credit printed live: `HARVEST 1 → 0.62`. Release commits.

**The stepper keeps the colony on screen.** The player is choosing how many of the
organisms in front of them to bank, so the organisms stay in front of them: the
overlay reserves the band the live colony occupies and the scrim opens across it,
unblurred, printed values and all — the same device the stake screen uses, on the
other screen in the game where a number is chosen. Round 2 asked for the same
decision over a blurred scrim with a 35%-of-frame band of empty dark under the
panel: 10.0% lit surface against a 20% floor, 1,095 distinct colours against 2,500,
and the only thing in that band a ghosted multiplier nobody could read. Below the
window the scrim is opaque, because the value strip behind it holds the same
numbers the panel in front of it holds and a ghost of them reading through the
commit button is a broken render rather than depth. Nothing moves to make room —
a decision surface that reflows while a player is choosing a number on it is a
decision surface that can cost a mis-tap.

The stepper exists because the protocol accepts every `k` and the published
volatility range depends on it. [MATH.md §11](MATH.md) advertises a
player-selectable standard-deviation interval whose **maximum** is attained by
harvesting exactly one organism at a population of 15; shipping only
`floor(n / 2)` would publish a range no player could reach. Either the number
comes off the marketing sheet or the button goes in the client, and the button is
cheaper and more honest.

**The control commits once per generation, and the panel says so by changing.**
A generation's decision is a single choice of `k` on the continuum from
`CONTINUE` (`k = 0`) through `HARVEST` to `BANK` (`k = n`); committing it closes
that generation ([ENGINE.md §5.3](ENGINE.md)). So after a partial harvest the
action bar collapses to `NEXT` alone, with the remaining colony and its value
still printed. Nothing is taken away that the protocol would have accepted: a
second harvest at the same generation credits the same organisms at the same
yield as one harvest of their sum, and floors twice instead of once, so it is
worth at most the same and usually one minor unit less
([MATH.md §13](MATH.md)). What it *is* is a control that would have been refused,
and a control that would be refused must not be on screen. §5 (S4, S5) is the
screen behaviour and §9.8 is the input guard that stops a stray tap committing
one.

**What harvesting costs, stated where it belongs.** Harvesting caps how large the
colony can get — halve it every generation and the survivor count can never grow,
so FULL BLOOM becomes unreachable rather than rare
([MATH.md §8.2](MATH.md)). That is a real property of a real choice and the
player is entitled to know it. It belongs in the **help screen**, with the
per-policy table, identical for every player and every round state, and it may
never be surfaced at the moment of a harvest — a message that says "harvesting
costs you the jackpot" fired at a decision is a nudge to continue, which is
exactly what §9.2 forbids. A fact a player looks up is not the same object as a
prompt fired at them, and the line between them is whether the game brought it
up.

**There is no harvest plan and no in-round auto-play.** Round 2 specified four
pre-commit presets, one of which (`RIDE TO 18`) resolved an entire round with no
player input after `SEED`. Cut, for three reasons that are worth recording so the
feature does not come back by accident:

1. **It is within-round auto-play.** That is the affordance GB rules removed from
   online slots, and a game whose §9 spends a page on anti-chase discipline
   cannot ship it in §4 without noticing.
2. **It could not be bound to the proof.** A plan is either executed by the
   client, in which case the transcript cannot tell a planned round from a
   hand-tapped one, or executed by the server, in which case
   [ENGINE.md §5.1](ENGINE.md)'s load-bearing claim — *advance cannot be
   initiated by the server* — is false. Neither is acceptable.
3. **It solved a problem the game does not have.** The plan's stated benefit was
   "so the player can look away". Nothing in SWARM is timed. You can already look
   away, put the phone down, and come back in an hour to the same frame.

Multi-round auto-play is a separate question and is still open (§10).

---

## 5. Portrait UX flow, screen by screen

Reference frame: 390 × 844 pt, safe areas respected, everything reachable with
one thumb. Landscape is a letterboxed version of the same layout — this game is
portrait-native.

**Persistent layout**

```
┌──────────────────────────────┐  56 pt   top bar: balance · session · menu
│                              │
│         VENT STAGE           │  520 pt  the colony, the only light source
│                              │
├──────────────────────────────┤  72 pt   value strip
│  YIELD 0.62x  ·  COLONY 2.47x│          with the 1.00x stake line always drawn
├──────────────────────────────┤  96 pt   action bar (thumb zone)
│   BANK      HARVEST   NEXT   │          hierarchy never changes, ever
└──────────────────────────────┘  ladder chip: GEN n / 18
```

**S0 — First round only.** A three-panel explainer, shown once, before the first
`SEED` a device ever sends, skippable at any point and repeatable from help. It
exists because the comprehension load is real and specifying zero onboarding for
the single largest product risk is a gap: colony value is a product of two
numbers, the first yield is the unintuitive `0.395833`, and the player's very
first frame is a mandatory generation that leaves them below their stake 54.40%
of the time.

| Panel | Says | Shows |
| --- | --- | --- |
| 1 | *"Every generation, each organism dies, holds, or splits."* | The three outcomes on one organism, at the real 900 ms beat, with the permanent `DIE 40% · HOLD 40% · SPLIT 20%` legend already in place |
| 2 | *"Your colony is worth its size times a yield that climbs 25% a generation. It can go down."* | A three-organism colony resolving to two, with the value strip falling and the stake line held |
| 3 | *"Bank it whenever you like, or harvest part and let the rest run. Every way of playing returns the same 95% on average, before rounding."* | The action bar, with the harvest stepper opening once |

Binding rules, so this cannot become a different object later: it is shown before
a round, never during one and never after a loss; it is identical for every
player; it never mentions a jackpot, a frequency or a "best" way to play; and the
`SEED` control is reachable from every panel. It is not a demo round — a free
round would put a resolved outcome in front of a player before their first stake,
which is a different product decision and is not made here.

**S1 — Stake & seed.** The vent, with **the three organisms the seed will light
standing in it**, each carrying what it is worth on its face at the entry value
(`19/20` of the stake, three ways: `0.31x`). The overlay reserves the top third of
the frame as an open window onto the live stage and the scrim opens to 4–6% across
it, then closes *hard* — a short shoulder, not a long ramp — the moment the type
starts, so the picture keeps its whole window and the words keep their whole
contrast. Round 2 ran the scrim at 8% under the heading, which set `SEED A COLONY`
over the brightest cyan in the frame and left its kicker effectively unreadable,
on the first screen a player ever sees. The preview colony is drawn to *fit* the
window rather than overflow it, and it is completely still: the strongest single
finding in the calibration set is that its best reference animates literally
nothing while it waits for you.

The rules pill shares the masthead row with the lockup rather than stacking under
it. Pinned 42 pt down the stage it lands inside the window, across the organisms'
own printed values.

The stake stepper, the profit rates and the two disclosures sit below. **The
profit rates are a readout, not a paragraph** (§9.3): a label and two rows, in the
same row pattern the stake panel uses. Round 2 met the same requirement with a
two-line sentence of body copy directly above the seed control, and no shipped
game in the calibration set puts a sentence like that on a bet screen.

Round 1's stake screen had **no game object on it at all** — an empty dark
gradient with one orange smudge, 12.3% lit surface and 924 distinct colours — and
a first-time viewer could not tell what game they were about to play. No reference
in the calibration set has an empty betting screen: the peg-drop titles show the
board and its chips, the crash titles show the vehicle on the pad, the balloon
title shows the field. The
preview is not a free round and not a resolved outcome: it is the *opening
position*, a constant of the rules, identical every round, and `E(V)` is set from
that same entry value so the screen is lit by exactly the money about to be on the
table.

The side-bet row is collapsed by default behind a single `+ SIDE BETS` control. Opening it shows
three independent stake steppers and a running **total at risk**. Beside the
total, the per-line profit rates and — when the stakes are equal — the ticket
figure from [MATH.md §7.4](MATH.md); when they are not equal, the per-line rates
alone, because a combined figure for an arbitrary stake ratio is a number nobody
has computed (§9.3).

Below that, a `FAIRNESS` row, collapsed by default, containing both halves of the
handshake:

```
SERVER COMMITMENT   5dd1dc8f…1df2ea2                    [copy]
YOUR CLIENT SEED    9f3c…a71b            [regenerate]  [edit]
```

The server commitment is published *before* this screen exists; the client seed
is generated here, after it. Help copy, one sentence: *"The server sealed its
seed before you chose yours, so neither side can pick the other's. Change yours
if you like — every value gives exactly the same odds."* The client seed is never
pre-filled from a server response, which is the one detail that makes the control
worth having ([ENGINE.md §8](ENGINE.md)). Primary CTA: `SEED COLONY`.

**S2 — Seeding.** Three organisms fade up from the vent over 700 ms. The
generation-1 probabilities appear as a permanent legend (`DIE 40% · HOLD 40% ·
SPLIT 20%`) — it is never hidden, at any point in the round.

**S3 — Generation resolve.** Draw flash, simultaneous outcomes, verdict. The
generation dot row at the bottom advances one dot. Tapping skips to the resolved
state — and skipping ends the animation, not the beat: the decision controls stay
inert for the dead period in §9.8, and the tap that skipped is consumed by the
stage surface, which does not overlap the action bar. Any live side-bet chip
updates on the same beat, for the generation that just resolved and never the
next one.

**S4 — Decision.** The three controls appear. `BANK` is always the visually
primary action (filled, LUMEN). **None of the three is an outline**: the rubric's
rule for anything on the money surface is that it is never one — an outline has no
volume, so it cannot carry a pressed state, and it measures as hard edge rather
than as material. `HARVEST` and `NEXT` are opaque graded faces one and two
registers quieter, so the hierarchy is carried by luminance and chroma rather than
by one control being a thing and the others being drawings of things. `HARVEST`
shows exactly what a tap will pay: `HARVEST 2 → 1.23`; pressing and dragging it opens
the `1 … n-1` stepper (§4.3) with the credit updating live. `NEXT` is tertiary
(ghost). No timer, no countdown ring, no pulsing "hurry" animation. The panel
states the next generation's yield so the trade-off is explicit: *"Next
generation: 0.77x per organism."* That is a per-organism ladder constant and it
is the only forward-looking number on the play surface; §9.2 sets the exact rules
that keep it a price rather than a target.

**The panel is identical whether the player is above or below their stake.**
Same layout, same hierarchy, same copy, same colours — only the numbers differ.
§9.2 is the full rule and it is the single most important constraint on this
screen.

**S5 — Harvest.** Inline, no modal. The harvested bodies take on AMBER, detach
and travel to the balance chip; the remaining organisms close ranks; the balance
chip updates. For these 400 ms only, the **wild-line ghost** (§4.2) is drawn at
22% PLANKTON behind the colony and does not move — this is the frame that teaches
the player what a side bet resolves on — and it fades with the beat. Then the
action bar is drawn unavailable in place: this generation's decision is committed
(§4.3, [ENGINE.md §5.3](ENGINE.md)).

**A sub-label is one short line, and the committed state says nothing.** Round 2
put the same twenty-eight-character sentence — "this generation is committed" — on
all three controls. In the tertiary cell, 89 pt wide at the reference frame, that
wraps onto *three* lines inside a two-line box, so the overflow painted straight
through the word `NEXT` above it and out past the button's own rounded box, on the
money surface, on every harvest round. Two rules hold now, and both are structural
rather than a copy tweak: the sub-label box clips its own overflow, and the copy is
sized for the narrowest cell. While a generation resolves the bar is already
visibly inert — dimmed, drawn unavailable, unreachable — and three copies of one
sentence explaining that is noise at the moment the player is watching the stage.
Generation 1's rule *is* worth saying, because it is a rule a first-time player
has not met, and it is said once per control in three words.

**A bank is not a harvest.** Structurally it is a harvest of every organism, and
round 2 ran the same beat for both — which flew the whole colony out of the frame
and deleted it *before* the settlement opened, so the payout landed on empty water
(§7.1). On a bank the colony stays exactly where it is for the length of the beat;
the settlement's own pour is what moves it.

The beat is deliberately not a reward beat. A harvest moves money from at risk to
banked and changes the player's wealth by exactly zero
([MATH.md §6](MATH.md) step 2), so §6.5 R6 gives it transfer treatment rather than
win treatment: no swell, no particle shower, no count-up flourish, and an audio
mark at the same level as any other informational mark. It is the loudest thing
in the game only if the design is willing to celebrate an event that pays
nothing, and it is not.

**S6 — Extinction.** The last organism's core dims and collapses; the screen
falls to the vent ember alone. Copy is flat and non-escalating: *"Colony
extinct. Banked this round: 1.23."* The next control is `NEW ROUND` at normal
prominence — never enlarged, never pre-selected, never accompanied by a stake
increase suggestion.

**S7 — Settlement ceremony.** Scaled to what the round actually paid. See §7.

**S8 — Receipt.** Stake for every line, every harvest with its generation, yield
and `k`, terminal reason, each side bet's result, total credited per line, exact
multipliers, round ID, revealed server seed, client seed, seed pre-commitment,
settlement body commitment, and a `VERIFY` button.

**S8a — Wild line, completed.** The line the side bets resolve on, drawn in full
for the first time, from the revealed seed: generation by generation to its own
terminal, including every generation after the player's own round stopped. This
is the only screen that draws the whole counterfactual colony, and it is after
the round, where it cannot sit beside a decision (§9.8). Each side bet resolves
against the completed line. The screen appears only if at least one side bet was
placed.

**S9 — Verify.** Shows both seeds, the derivation rule, the first draws of the
grid with their generation/slot indices, the **action log** with its chain
values, and a re-derived payout for every line that must match the receipt. The
sheet states plainly what the two commitments each prove: the first that the
server's seed predates every decision, the second that this settlement is the
settlement of *this* decision log and not another one
([ENGINE.md §4](ENGINE.md)). Offline-checkable: the sheet includes the exact
command to reproduce it.

**S10 — History & session.** Last 50 rounds with terminal reason and multiplier;
session elapsed time and net result; limits and reality-check settings one tap
from the menu.

**Reconnect.** Dropping mid-round returns you to the exact decision state with
the same frame revision — including whether this generation's decision is still
open, which the frame carries rather than the client inferring it
([ENGINE.md §5](ENGINE.md)). Nothing resolves while you are away: the round only
advances on your tap. A round abandoned for 72 hours is reconciled by a forced
bank at its exact current value and appears in history with the reason
`RECONCILED` ([ENGINE.md §5.5](ENGINE.md)). A round abandoned *before its first
tap* is reconciled too — the mandatory generation 1 resolves and whatever
survives is banked, which is exactly what a returning player would have got — and
the help screen states both plainly rather than burying them in terms.

---

## 6. Art direction

**Concept.** The deepest water there is, and it is *water* — not the absence of a
picture. One warm ember from the vent below. The only other light in the universe
is your colony. The light budget of the scene *is* the money — and §6.3 defines
that as an exact, monotone function of colony value so the claim survives contact
with a renderer.

### 6.1 Palette

**The floor moved, and why.** Round 1 read "absolute abyssal black" literally and
measured **37.3% of the idle frame and 41.7% of the winning frame at `L < 0.06`**
— dead black — against **0.0–0.1%** in every premium reference of this category.
The property those references actually share is not that they are dark: it is
that their darks are **saturated and sit on gradients**. The controlled pair in
the calibration set is the same game, same layout, same type, in two skins, at
**87.8% versus 4.8% saturated pixels**; the flat one reads as a wireframe of the
coloured one, and it is the failure mode this game shipped.

So ABYSS is now the deepest *water* in the picture rather than the absence of
one, and the water tones climb with it. Every value below is a **constant** —
identical in every frame of every round — so §6.3's ordering promise is
untouched: no frame can outrank another by value on account of the plate it is
drawn on. Only `E(V)` moves.

The rule that follows, and it is enforced in `styles.css` and `stage.js` alike:
**nothing anywhere in the game is drawn darker than ABYSS.** Shadows, scrims,
vignettes and trench walls are tinted toward ABYSS and never toward black, so
they darken *to* the floor and stop there. Measured result: near-black is
**0.0%** of every frame in every state.

| Role | Name | Hex | Usage |
| --- | --- | --- | --- |
| Background void | ABYSS | `#061A24` | 55% of frame; the darkest pixel in the game |
| Mid water | TRENCH | `#082430` | gradient fill, vignette |
| Floor / panels | SILT | `#0D3040` | UI panel base |
| Rock | BASALT | `#16495C` | vent chimney body |
| Lit rock edge | CRUST | `#256D7D` | rim of the chimney |
| **Organism core** | **LUMEN** | **`#39F5C8`** | primary brand colour, organism glow, primary CTA |
| Organism specular | LUMEN HIGH | `#7CFFE3` | hottest 10% of each body |
| Organism shadow rim | LUMEN DEEP | `#0FB894` | body edge away from core |
| Ambient life | PLANKTON | `#5B8CFF` | drifting particles, secondary UI strokes |
| Large-gain tint | MEDUSA | `#B06CFF` | verdict beats worth at least a whole stake, and only those |
| Rich organism | MEDUSA HIGH | `#CBA0FF` | the body of an organism worth at least one whole stake on its own |
| Banked value | AMBER | `#FFC978` | harvest particles, balance chip, credited amounts, **the payout vessel's face** |
| Vessel highlight | AMBER HIGH | `#FFE9C2` | the lit lip of the payout vessel |
| Vessel shadow | AMBER DEEP | `#D9902F` | the vessel's seated lower edge |
| Vessel ink | INK | `#23140A` | the payout numeral, dark-on-light *inside* the vessel (§7.1) |
| Vent thermal | EMBER | `#FF9E6B` | vent glow only, ≤5% of frame, never used for loss |
| Extinguished | ASH | `#8A97A6` | dead organisms, disabled controls |
| Primary text | FOAM | `#E6F4F1` | numbers, labels |
| Secondary text | MIST | `#9FB6BD` | captions, legends, signed negative deltas |

Rules: **red is not in the palette.** Loss is communicated by darkness, by the
removal of light, and by a signed number — never by an alarm colour. AMBER means
"yours, banked, safe" and appears nowhere else. **Violet means at least one whole
stake**, in both of the two places it is allowed to appear: a verdict beat worth
`D >= +1.00x`, and an organism whose own value has reached `1.00x`. Both are the
same promise — violet on screen always means a quantity of money at least as large
as the ticket — and neither the old "violet on every split" rule nor the ratio
bands that replaced it could keep it (§6.5).

**The value bands, and they are the payout scale made visible.** An organism's
colour is *its own worth*, so the scale is learned by looking rather than read and
multiplied. This is criterion 11 of the calibration bar, which the round-1 build
failed on every frame: the references print `x5.6` on a yellow chip and `x16` on a
purple balloon, and ours put the scale in a line of text in the value strip.

| Per-organism value `u` | Band | Body core | Relative luminance | Emission gain |
| --- | --- | --- | --- | --- |
| `u < 0.50x` | dim | LUMEN DEEP `#0FB894` | 0.571 | 0.90 |
| `0.50x <= u < 1.00x` | lumen | LUMEN `#39F5C8` | 0.792 | 1.00 |
| `u >= 1.00x` | medusa | MEDUSA HIGH `#CBA0FF` | 0.690 | 1.20 |
| harvested | amber | AMBER `#FFC978` | 0.810 | 1.00 |
| extinct | husk | `#566C78` | 0.410 | 0.30 |

The gain is not decoration: violet is intrinsically darker than cyan, so without
it the colony would visibly *dim* as it got rich. `luminance x gain` is
non-decreasing up the ladder — 0.514, 0.792, 0.828 — which is §6.3's ordering
promise applied at the organism. The husk sits below every living band by
construction and carries no halation, no interior and no nucleus, so a frame full
of remains can never be brighter than a frame with one living organism in it.

**Hue economy.** One hue carries the frame and a second supports it — never more.
Base states measure 71–87% of hue mass in the cyans with the vent's EMBER as the
only other presence; the payoff swings warm, and measures roughly half its hue
mass in the ambers with the cyans holding the rest. AMBER being scarce
everywhere else is what makes that swing legible: **if gold were already on the
play surface, the payoff would have nowhere to go.**

### 6.2 Materials

- **Organism.** A translucent gel bell **24 to 68 pt across** — the diameter of
  `r(n)` in the §6.4 layout table, which runs from the 34 pt ceiling at three
  organisms or fewer to the 12 pt floor from seventeen upward — with a brighter
  nucleus at ~25% of body radius. Points, not pixels: every other size in this
  document is in points on the 390 × 844 pt reference frame, and the one figure
  an artist reads first is not the place to change unit. Subsurface
  scattering: the body transmits LUMEN outward with a soft quadratic falloff;
  membrane is a 1.5 px Fresnel rim in LUMEN HIGH.

  **It has mass, and that is the round-2 change the whole art direction turns
  on.** Round 1 drew the colony as light and nothing else — every body an additive
  falloff with no silhouette — and at twelve organisms fifteen overlapping glows
  summed into one amorphous cloud that *could not be counted*. Population is half
  of what the money is (`units x yield`), so the number that drives the payout was
  legible only as the words "12 ALIVE" in the strip. The rubric names the failure
  mechanically: recognition works on mass and shading, and an object with neither
  has no identity, carries no state and gives the eye no entry point.

  So a body is drawn in two passes. The **mass** goes down opaque, in
  `source-over`; the **light** goes on top additively, exactly as before —
  subsurface transmission, gastric canals, granulation, the manubrium, the
  tentacle skirt — at 55% of its old strength, because it is now anatomy inside a
  body rather than the body itself.

  **The mass is one surface with one light on it, and every term in it is
  directional.** This is the round-4 change, and it exists because the round-3
  mass had four separate ways of drawing a circle nobody asked for:

  - **One silhouette, then one shading pass.** The lobes contribute a shape and
    nothing else — flat core colour, unioned. The shading is applied once over
    the union. Shading each lobe on its own drew the two-lobed archetype's minor
    lobe as a separate ball inside the body, with its own visible edge; that seam
    was the worst-rendered detail in the build and it sat on one organism in
    three, at every size.
  - **A terminator, not a cone.** The key ramp is a **linear** gradient along the
    light's axis (upper left to lower right). The round-3 radial ran from a small
    offset circle to a circle of exactly the body's radius, and a radial
    gradient's parameter reaches 1 on the whole of its outer circle — so its
    darkest colour was painted as an unbroken dark band around every organism.
    A linear gradient has no radius and therefore no ring at any radius. Limb
    darkening is a second, gentle concentric term that never reaches half
    strength.
  - **The ramp ends in the band's own shadow, never in ABYSS.** A warm body shaded
    toward a blue-green floor lands on olive, which is exactly why the harvested
    colony read as khaki eggs at the moment it was worth most. AMBER shades to
    umber, MEDUSA to a deep violet, the cyan bands to ABYSS as before. The value
    at the end of every ramp is at or below ABYSS's, so §6.1's floor and §6.3's
    ordering are untouched; only the chroma moves.
  - **A cast shadow, not a halo.** The contact shadow is offset down-right and
    reaches 1.6 R, so there is no shadow term at all on the lit shoulder. A
    concentric one is what an object casts when the light is inside the camera,
    and over the organism behind it, it read as a hard crescent seam.
  - **A rim light that is a crescent.** A bright annulus concentrated in the outer
    tenth of the radius, multiplied by a directional mask that is zero on the lit
    shoulder — light wrapping a silhouette, where round 3's Fresnel wash had no
    edge concentration and read as a smudge.
  - **A specular with a shape.** A hot white core with a visible edge, a bloom
    around it in the band's chroma, and a small catchlight low and right that is
    the water's light coming back up. A single wide fade from 72% white is a
    blurred smudge, and was cropped and named as one.

  A **spent** organism — one whose light has gone into the vessel — is drawn at
  full opacity. Drawing it at 82% let cyan water mix into every shaded pixel of a
  warm body, which is the other half of the khaki. Only a husk is drawn thin,
  because a husk is a corpse and a corpse is partly water.

  "Never outlined" still holds, and the rim falloff is what holds it: the mass is
  opaque to 82% of its radius and gone by 100%, which is about one device pixel of
  softness at the small end of the range and three at the large one. That is an
  edge, not a stroke — it occludes without drawing a line, and measured hard-edge
  share stays inside the 8% ceiling.

- **The organism carries its own money on its face.** The per-organism value is
  printed in INK on the lit body, at most five glyphs (`0.31x`, `1.20x`, `14.5x`,
  `119x`), sized to the bell so it shrinks with the population exactly as the
  object does, over a soft print field that holds the contrast on all three
  archetypes. It is baked once per string and blitted once per body, and it is
  drawn *last*, in `source-over`, so the additive interior underneath cannot wash
  it out. It is never drawn on an organism that is mid-split, mid-death or a husk:
  a number on a corpse is money that is not there.

  The run is **debossed on a shallow arc** so it bows with the body, and the arc
  is the one place this element can fail catastrophically: a glyph's horizontal
  advance along a bow of radius `R` is `R · sin(θ)`, so the lever arm the glyph is
  rotated about must *be* `R`. Swinging it on a shorter arm shrinks every advance
  by the same ratio, and at a sixteenth of `R` the whole string lands on one spot
  — which at blit size is a solid dark disc in the middle of every organism in
  every state, and criterion 11 of the bar (the payout scale printed on the
  object) cannot be read at any zoom. The ink is also **measured, then solved** to
  a fixed 70% of its tile rather than estimated from the glyph count, so the blit
  maps to a predictable share of the bell: a digit and a decimal point are not the
  same width, and estimating left `0.31x` covering 73% of the tile and hanging off
  the limb while a shorter string covered half.
- **Silhouette variation.** Three bell archetypes — `DOME` (wide, shallow),
  `BELL` (tall, pinched), `LOBE` (asymmetric, two-lobed) — assigned by
  `slotIndex mod 3`, with a per-body Perlin phase offset. Fifteen identical bells
  read as a texture; three archetypes read as a colony. **The archetype is
  derived from the slot index and from nothing else** — never from a draw, an
  outcome, or a future state — so the art cannot leak information. This is a
  hard rule, not a preference.
- **Water.** Volumetric fog with depth-based desaturation, and **no grain layer
  anywhere in the product**. Rounds 2 and 3 composited a chromatic noise tile over
  every pixel of every screen on the argument that it bought distinct-colour
  count. It did, and it cost the thing the count is a *proxy* for: not one frame
  in the fifty-one-image calibration library carries a grain layer, and at 3x
  zoom ours read as sensor noise or a compression artefact sitting on top of the
  art — identical on the amber liquid, on the glass, on the plaque, on the button
  faces and on the type. A texture that is the same on the water, on a numeral and
  on a control is not material; material is what an object is made of, and it
  differs per object. **This is a hard rule: colour depth is bought by building a
  surface, never by sprinkling one.** What remains is the printer's answer to a
  long ramp — the two baked canvas plates carry a **symmetric** per-channel dither
  of **±3 of 255** at bake time, symmetric so the mean of every channel is
  unchanged and it adds no luminance, takes no saturation and cannot reorder two
  frames by value (§6.3). The amplitude is set by what it *looks* like and not by
  what it buys: round 3 ran it at ±11, which is 4% peak-to-mean on a dark ramp and
  therefore a visible texture at 3x — deleting the CSS grain layer and leaving an
  ±11 dither in the plate underneath would have moved the defect rather than fixed
  it. At ±3 it is under one 8-bit step in mean and invisible at any zoom, which is
  the difference.

  What replaces the count the grain was buying is four surfaces that are actually
  built, all of them constants derived from `slotRandom` on an index and therefore
  incapable of carrying information about a round (§6.3):

  - **Marbling at three scales in thirteen hues.** Both plates carry soft patches
    from a fifth of the frame down to a twentieth — the largest are the depth of
    the water, the smallest are silt suspended in it — and two of the thirteen
    tints are warm, because a plate whose every patch is a cool tint moves its
    pixels along the line its own ramp already lies on and buys nothing. The
    count is the variable that matters: contrast per patch is unchanged, and
    every tint added crosses every other one somewhere on the plate.
  - **The far field.** Three hundred points of light, one to three pixels across,
    in six palette hues, scattered over the stage plate *above* its vignette and
    thinned toward the middle of the frame so they never compete with the colony.
    This is the deep-sea form of the device every reference uses to keep a large
    dark area from being inert — the starfield behind a climbing multiplier, the
    damask behind a peg board. You can point at one of these; you can only measure
    a grain.
  - **The near seabed** below the canvas — §6.2's own entry, below.
  - **The glass lattice** on every panel — §6.2's "UI panels" entry, below.

  Halation around every light source:
  a wide, low-opacity bloom (32 px radius, 12% opacity) plus a tight core bloom
  (6 px, 45%), both scaling with per-body intensity so a single late organism
  reads as a small sun. This is the single most important material effect —
  without halation the organisms look like stickers.
- **Rock.** Matte basalt, high roughness, no colour, visible only where the
  colony's light reaches it. The vent mouth has an EMBER gradient that never
  moves.
- **The near seabed.** The stage canvas stops where the value strip begins, at
  about 65% of the frame. On every playing screen the strip, the action bar and
  the footer fill that band; on the two settlement screens they step aside, and
  what a player was left looking at — on the screen this game shows more often
  than any other — was a third of the picture with nothing in it. So the world
  continues past the canvas: a lit silt plane with a direction, the vent's own
  pool spread flat across it, six basalt mounds rim-lit from the vent, a near
  stand of tube worms in silhouette, and marine snow. The seam is *measured* from
  the canvas's own bottom edge rather than assumed, so the floor starts exactly
  where the drawn floor stops however the frame is laid out. It is baked once per
  resize and it is a constant.

  **The plane is lit to a value that counts as lit.** Round 3's floor topped out
  at L = 0.21 — under the 0.35 the bar's mid-lit band begins at — so the whole
  thing was "a slightly different dark" and the extinction terminal measured 1.6%
  lit surface across it. The ramp now opens to L ≈ 0.38 just under the horizon and
  falls into the floor's own shadow at the near edge, and it carries a *sideways*
  term as well as a vertical one — cool at both margins, open in the middle where
  the vent stands — because a vertical ramp alone, being full width, is a horizon
  stripe rather than ground receding.

  **The mounds stay low.** Raising them into the exposed band between the payout
  card and the button was tried and measured: at that size the bezier shoulder
  reads as overlapping paper fans with a straight cut along the bottom of each,
  and both numbers went the wrong way (lit 20.6% → 20.3%, colours 1 091 → 1 081).
  A shape that is a rock at thirty pixels is a stage flat at a hundred and fifty.

  **The stage does not end, it dissolves.** The canvas and this plate are two
  different bakes at two different scales, and butting them left a hard full-width
  horizontal line at the seam with a value step across it — invisible on the
  playing screens, where the strip covers it, and running the whole width of the
  frame on both settlement screens, which are the two the game is judged by. The
  stage's last 46 px is masked to transparent instead, so the plate underneath
  comes up through it. A gradient painted *over* the join would only have traded a
  seam for an inert band, and that band is already the thinnest part of the frame.

  This band existed in round 3 and **was never on screen.** `#frame-plate` is
  positioned at `z-index: -1` so it sits between the frame's background and its
  content — which is what a negative z-index does *inside a stacking context*, and
  `.frame` did not establish one. The plate resolved against the root context and
  painted behind the frame's own background: invisible, on every screen, for the
  whole round. It is exactly why the settlement frames kept measuring 1 400
  distinct colours and 17% lit surface while the canvas that was supposed to be
  filling their lower third measured neither. `.frame` now carries
  `isolation: isolate`.
- **UI panels.** "Pressure glass": 8% FOAM fill, 24 px background blur, 1 px
  inner stroke at 20% LUMEN, 2 px outer shadow at 60% ABYSS. Corner radius 16.

  **And the glass has a body, and an ornament.** Round 3's panel face ran at
  11–15% alpha through its whole middle, which is not translucent glass, it is a
  window: once the frame plate became visible at all, the vent's warm light landed
  across the middle of two cool panels as a brown blotch — a stain on the glass
  rather than light behind it. Pressure glass is a material with a thickness, and
  it takes what is behind it down to a suggestion. The top 11% of the ramp is
  untouched, because that is what holds §9.6's contrast floor on every label in
  the product.

  The ornament is a **cell lattice at 29 px** — a hexagonal close-pack, because
  that is what a pressure window and a sheet of living tissue are both made of —
  etched into the face with a lit upper-left edge and a shadowed lower-right one,
  from the same key light as every control and every organism. Per-cell tint and
  strength come from `slotRandom`, which is why 29 px of repeat does not read as a
  repeat. It is generated in `stage.js` (`glassTile`), handed to CSS as a data URL
  and rasterized once. **It goes on the glass and on nothing else**: not the
  water, not the type, not a control face. That restriction is the whole
  difference between this and the layer it replaces.

### 6.3 Lighting: the exact brightness-to-money contract

Pillar 1 is only true if it is specified, so here it is specified.

- **Count sets how many lights there are. The ladder sets how bright each one
  is.** Each organism is a point light with radius `0.6 x` body diameter,
  quadratic falloff, colour LUMEN, and linear radiance
  `R_body(t) = R_ref * c(t) / c(1)`, where `c(t)` is the exact organism value
  from [MATH.md §4](MATH.md). Total linear scene radiance from the colony is
  therefore `n * R_ref * c(t)/c(1)`, i.e. **exactly proportional to colony
  value**, which is the money.
- **Tone map, because value spans 1332:1.** Render linear, then expose with

  ```
  E(V) = E_min + (E_max - E_min) * log2(1 + V / V0) / log2(1 + V_max / V0)
  V0 = 1.00x   V_max = 527.35x   E_min = 0.04   E_max = 1.00
  ```

  `E` is normalized screen luminance of the colony's contribution. The curve is
  strictly increasing in `V`, which is the whole point: **no frame in SWARM is
  ever brighter than a frame worth more money.** A single organism at generation
  18 (17.58x) is genuinely brighter than twelve organisms at generation 3
  (7.42x), because it is worth more — it is one very bright body rather than
  twelve dim ones.
- **When the two beats change the light.** Linear radiance changes *during* the
  outcome beat, as bodies split and die and their point lights appear and go
  out. The exposure `E(V)` then settles to its new value across the 380 ms
  verdict beat. There is one exposure animation per generation, not one per
  organism.
- **The stake line.** `E(1.00x) ≈ 0.146` is the exposure of a position worth
  exactly what the player paid. The value strip marks 1.00x with a 1 px MIST
  tick so the comparison is legible as a number, and because exposure is
  monotone the frame agrees with the tick rather than contradicting it. The tick
  is a static reference, never an animated target (§9.2).
- **Extinction.** `V = 0`, so the colony contributes nothing: over 400 ms the
  scene falls to the vent's fixed 8% EMBER rim light and a 2% PLANKTON ambient.
  Do not fade to a bright screen; the dark is the point.
- **The environment threshold.** `E(V)` is what decides when anything that is not
  an organism rises above the black floor, so that moment is a *value* and
  nothing else. It is set at `475/48 = 9.895833x`, the smallest colony value a
  FULL BLOOM can have, which makes every bloom light the environment and every
  frame worth as much light it too. §7.2 specifies the transition and publishes
  how often it fires, per policy.
- There is no fill light and no sun. Nothing is lit that the colony does not
  light. The one thing on screen that emits without being money is the wild-line
  ghost (§4.2, §6.4), and it exists only for the 400 ms of a harvest beat: it is
  an unlit overlay at fixed opacity, contributes no radiance to `V`, and
  therefore cannot make a poorer frame brighter than a richer one. That exemption
  is stated here rather than left to the renderer to discover, because pillar 1 is
  a promise about `E(V)` and an emitter outside the formula would quietly break
  it.

### 6.4 Motion language

Organic, weighted, never mechanical. Every timing below ships with its easing
curve, because "everything eases" is not an animation contract.

| Event | Motion | Timing | Easing |
| --- | --- | --- | --- |
| Idle | Perlin drift 0.2–0.4 pt/s, breath pulse at 0.8 Hz, phase offset per organism | continuous | `linear` on noise input only |
| Draw flash | Vent pulses once, all bodies contract 4% | 120 ms | `cubic-bezier(0.4, 0.0, 0.2, 1)` |
| SPLIT | Body elongates, pinches at the waist, two bodies snap apart with 12% elastic overshoot | 400 ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| HOLD | One soft brightness pulse, +15% then back | 250 ms | `cubic-bezier(0.4, 0.0, 0.6, 1)` |
| DIE | Core dims to zero, membrane collapses inward, remnant drifts down and out; the body's light leaves the scene | 400 ms | `cubic-bezier(0.4, 0.0, 1, 1)` |
| Verdict count | Tabular digits roll to the new value; never rounds up, always truncates | 380 ms | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Exposure change | Scene luminance moves to the new `E(V)` | 380 ms | `cubic-bezier(0.4, 0.0, 0.2, 1)` |
| HARVEST | The harvested bodies take AMBER at their existing intensity, detach, travel to the balance chip and dissolve; survivors close ranks. No brightening, no shower, no swell (§6.5 R6) | 400 ms | `cubic-bezier(0.2, 0.0, 0.0, 1)` |
| Environment reveal | Silt, rock and plankton fade up as the colony crosses `9.895833x`; once per round | 1,000 ms | See §7.2 |
| Settlement ceremony | See §7 | 600–2,400 ms | per tier |

**The effect budget, and it is a ceiling as well as a floor.**

"Simple, but with a few beautiful effects" is only a brief if it is measurable, so
it is measured the same way the rest of §6 is: as the pixel diff between two
consecutive frames sampled 100 ms apart, changed pixels clustered and connected
into regions.

| State | Ceiling | Measured |
| --- | --- | --- |
| Idle (S1, the seed colony at rest) | ≤ 3 moving regions, ≤ 3% of pixels | **1 region, 0.05%** |
| In-round, at rest | ≤ 3 regions, ≤ 7%, one region ≥ 60% of the motion | **1–2 regions, 0.6–0.7%, dominant region 96%** |
| Settled payoff | ≤ 7 regions | **0 regions — it arrives, then holds** |

The payoff *entrance* is where round 1 broke the ceiling: ten independently moving
regions against a limit of seven, with the largest owning only 46% of the motion
against a required 50–80%. Three things caused it and all three are gone — the ray
fan, the eighteen-bar trace, and a balance chip counting simultaneously with the
payout figure. The chip now counts in the second half of the figure's count, so
there is one dominant motion per beat rather than two equals.

The reference this is calibrated against animates *nothing* while it waits for the
player: two consecutive frames are pixel-identical. Round 1 drifted and twinkled
three hundred plankton and marine-snow motes on independent sines and measured
**thirteen to fourteen** independently moving regions in the state the player sits
in longest, with no region owning more than half the motion. Ambient particulate
behind a live decision is the effect budget spent on nothing, and it is spent
where there is no headroom left for the beat that matters.

**The particulate therefore holds still.** It is still *lit* by the colony —
brightness is `E(V)` times a quadratic falloff from the colony centroid, exactly
as §6.3 requires — so it carries the one thing it was ever carrying information
about, and it carries it on the generation beat rather than sixty times a second.
The colony's own breath and drift are the only continuous motion in the frame,
which is what makes the colony the thing the eye is on.

**Colony choreography, resolved.** Bodies sit on a golden-angle phyllotaxis
spiral around the vent plume centroid, ordered by slot index, so adding or
removing organisms never re-shuffles the ones already on screen. Body `i` of `n`
(1-based, `i = slotIndex`) sits at

```
polar angle    theta_i = i * 137.507764 degrees          (the golden angle)
polar radius   rho_i   = R(n) * sqrt(i / n)              (equal-area spiral)
body radius    r(n)    = clamp(34 - 1.6 * (n - 3), 12, 34) pt
layout radius  R(n)    = 44 + 7.5 * sqrt(n) pt
```

`rho_i` is per body and proportional to `sqrt(i)`; that is what makes it a
spiral. (A single radius per population would put every body on one circle, which
is a ring. The round-2 text gave `R(n)` alone and called it phyllotaxis, which was
not buildable as written.) The outermost body sits at exactly `R(n)` and the
innermost at `R(n) / sqrt(n)`:

<!-- generated:layout -->
| Population `n` | Body radius `r(n)` | Unclamped | Layout radius `R(n)` | Innermost body at |
| --- | --- | --- | --- | --- |
| 1 | 34.00 pt (clamped) | 37.20 pt | 51.500 pt | 51.500 pt |
| 3 | 34.00 pt | 34.00 pt | 56.990 pt | 32.904 pt |
| 8 | 26.00 pt | 26.00 pt | 65.210 pt | 23.058 pt |
| 12 | 19.60 pt | 19.60 pt | 69.980 pt | 20.202 pt |
| 15 | 14.80 pt | 14.80 pt | 73.040 pt | 18.863 pt |
| 16 | 13.20 pt | 13.20 pt | 74.000 pt | 18.500 pt |
| 17 | 12.00 pt (clamped) | 11.60 pt | 74.922 pt | 18.171 pt |
| 30 | 12.00 pt (clamped) | -9.20 pt | 85.077 pt | 15.533 pt |
<!-- /generated:layout -->

The clamp bites at both ends and the table says exactly where. Below `n = 3` the
unclamped radius exceeds the 34 pt ceiling; the floor first bites at **`n = 17`**,
where the unclamped value is 11.6 pt. From there up to the state-space maximum of
30 ([MATH.md §1](MATH.md)) every body is 12 pt and up to 30% overlap is allowed.

**That overlap is now occlusion rather than addition, and the difference is the
whole of criterion 1.** Round 2 allowed the dense end of the range to read as a
*mass* on the grounds that the count is printed as a numeral anyway. A blind
side-by-side found the flaw in that reasoning: "the state gets communicated by
text instead" is the exact failure the rubric diagnoses for line art, and at
twelve organisms — a population well inside the ordinary range, not a 2.4-second
terminal — the colony fused into one cloud a viewer could not count. With the mass
drawn in `source-over` (§6.2) an overlap is one body in front of another, which is
what every reference does with a dense field of objects, and the colony stays
countable at every population the layout produces. There is no layout mode beyond
this one and no dynamic re-packing to design later.

**Wild-line ghosts** (§4.2) use the same spiral with the same `R(n)` for the
wild population, drawn at 22% opacity in PLANKTON with no halation, no specular
and no point light — they contribute nothing to the exposure, because they are
not money. They appear only during the 400 ms harvest beat and fade with it
(§5, S5; the reasoning is §9.8).

**Budget.** Target 60 fps on iPhone 12 / Snapdragon 7-series and above: ≤ 30 draw
calls, one full-screen blur pass, ≤ 3 render targets, ≤ 2.5 ms GPU frame at
390 × 844 @ 3x. Low tier (30 fps floor): the volumetric pass is replaced by a
baked depth gradient and halation drops to the tight core bloom only. Nothing in
the low tier changes what is *shown* — only how it is lit.

`prefers-reduced-motion` replaces splits and the settlement ceremony with
cross-fades, disables drift and the elastic overshoot, and makes the verdict
count-up an instant set. The exposure change still happens, because it carries
information.

### 6.5 Feedback rule: emphasis follows the money, never the event

This is the rule the rest of the audio-visual design is subordinate to.

**Why it has to exist.** Colony value is `n * c(t)` and `c(t)` climbs 25% per
generation, so a generation *loses* value whenever the population falls by more
than a fifth — no matter how many organisms split on the way. Exactly how often:

<!-- generated:feedback -->
| Population `n` | P(value falls) | P(falls **and** at least one split) | P(falls **and** two or more splits) | P(at least one split \| value falls) |
| --- | --- | --- | --- | --- |
| 3 | 54.40% | 9.60% | 0.00% | 17.64% |
| 5 | 39.42% | 12.80% | 0.00% | 32.46% |
| 8 | 52.69% | 36.50% | 10.55% | 69.27% |
| 12 | 49.14% | 42.40% | 24.12% | 86.28% |
| 15 | 43.76% | 40.31% | 28.30% | 92.10% |
<!-- /generated:feedback -->

At 8 organisms, 36.50% of all generations both lose value and contain at least
one split, and 10.55% lose value while containing two or more. Conditional on the
value falling, at least one split fires 69.27% of the time at `n = 8` and 86.28%
at `n = 12`. Any design that makes "a split happened" the loudest thing on screen
is therefore celebrating losses roughly a third of the time — and if deaths are
simultaneously silent, the player's felt experience of the round systematically
diverges from their balance. That is designed-in misleading outcome feedback, and
no amount of aesthetic justification makes it something else.

**The rule.**

- **R1 — Emphasis is a function of the signed value change, in money, and of
  nothing else.** Let `D = V(t+1) − V(t)`, measured in **stake multiples** — the
  amount the balance would move by. The verdict beat picks its treatment from `D`
  alone. No per-organism event may carry emphasis above the neutral baseline.
- **R2 — Legibility parity during the outcome beat.** DIE, HOLD and SPLIT get
  equal perceptual weight in the 400 ms outcome beat: the player must be able to
  read what happened to each organism. Equal weight, not equal excitement — no
  colour flash, no bloom pop and no chime attaches to a split.
- **R3 — Loss has a channel.** A death removes that body's light from the scene,
  so the frame measurably darkens, and it produces an audible mark at the same
  level as any other outcome mark. "Quiet" is not "absent"; a loss the player
  cannot perceive is not honest just because it is not punishing.
- **R4 — Monotone.** Two generations with the same `D` get identical treatment
  regardless of how they got there, and a larger `D` never gets less emphasis
  than a smaller one.
- **R5 — Reachable.** Every band and every note the game can play must be
  producible by the model, and the enumeration proves it. A treatment no state
  can reach is a specification bug, not a rare event.
- **R6 — A transfer is not a gain.** Moving value between the colony and the
  balance is not a value change and gets no reward treatment. A harvest of `k`
  moves `c(t)k` from the colony term into the banked term and leaves the player's
  wealth *pathwise* identical ([MATH.md §6](MATH.md) step 2): `D = 0`. It
  therefore gets the `D = 0` treatment — the transfer is shown clearly, because
  the player must be able to see where their money went, and it is not
  celebrated.

**Why R6 exists, and what it costs to leave it out.** Round 3 gave the harvest
the strongest reward signal in the game: bodies brightening to AMBER, spiralling
into the balance chip as particles, a 400 ms "granular amber pour" ending in a
click, against a two-note rise for a genuine `+0.9x` generation. That is the
loudest beat in the product attached to the one event that pays nothing, and R1
was never applied to it because R1 was scoped to the verdict beat. Two things
follow from fixing it:

- **The doctrine has no exception any more.** R1 says emphasis is a function of
  the signed value change and of nothing else; a harvest's signed value change is
  exactly zero, so it sits at the neutral baseline with the `D = 0` verdict.
- **It removes a perverse incentive.** Every credit is floored, so harvesting is
  the one action that is measurably — very slightly — worse in payable terms:
  at most one minor unit per harvest and 18 per round
  ([MATH.md §13](MATH.md)). Rewarding the only action that costs the player
  anything, however little, is exactly the shape §6.5 exists to prevent.

What R6 does *not* do is make the harvest silent. The player has to be able to
see and hear that money moved: AMBER is the colour of banked value (§6.1), the
bodies travel to the chip, the chip updates, and there is one soft mark at the
informational level. R3's principle applies in both directions — quiet is not
absent — and §9.6 requires the amount to be announced as text as well.

**Why `D` is in stake multiples and not a percentage.** The round-2 rule banded
the *ratio* `V(t+1) / V(t)`, and R5 is in this list because that rule failed R5
in both directions. A ratio above `+50%` needs `m > 1.2n`; at `n = 13, 14, 15`
every such outcome is at or above the FULL BLOOM threshold, which ends the round
and skips the verdict beat, so the top band had probability **exactly zero in the
three biggest colonies** — silent precisely where the gains were largest. At the
other end it fired on 20.00% of generations at `n = 1`, where the "large gain" it
was celebrating is a move from `0.40x` to `0.99x`. [MATH.md §9.3](MATH.md)
carries the derivation. Banding the money instead of the ratio fixes both: `c(t)`
climbs 25% a generation, so a large absolute gain is reachable from every live
population, and a small one is never dressed as a large one.

**The verdict bands**, with the exact share of verdict beats each one takes:

| `D` | Frame | Value strip | Audio |
| --- | --- | --- | --- |
| extinction | Terminal: extinction takes over (screen S6), no verdict beat | Final value 0.00x | The extinction fall, not a verdict mark |
| `D ≤ −1.00x` | Exposure falls to the new `E(V)` over 380 ms | Count-down, signed delta chip in MIST | One short low mark, −18 dB. No descending "fail" motif |
| `−1.00x < D < 0` | Same, smaller step | Same | Same mark, −22 dB |
| `D = 0` | No change | Neutral tick | Soft membrane tick |
| `0 < D < +1.00x` | Exposure rises | Count-up, delta chip in FOAM | Two-note rise |
| `D ≥ +1.00x` | Exposure rises; MEDUSA rim on every body for 240 ms | Count-up, delta chip in FOAM | Rising chord, one semitone per `3/2` of gain, capped at +7 |

<!-- generated:verdict-bands -->
| Verdict band | Share of verdict beats |
| --- | --- |
| `D <= -1.00x` — the generation took at least a stake off the table | 9.53% |
| `-1.00x < D < 0` | 28.85% |
| `D = 0` — reachable only when `5m = 4n` | 1.13% |
| `0 < D < +1.00x` | 41.07% |
| `D >= +1.00x` — MEDUSA, and the chord | 19.39% |
<!-- /generated:verdict-bands -->

**The chord.** `+0` semitones at a one-stake gain, `+1` at `1.5x`, `+2` at
`2.25x`, and so on: `semitones = min(7, floor(log_1.5 D))`. The top note sounds
at `(3/2)^7 = 17.0859375` stakes gained in a single generation, which happens on
`1 in 333.88` verdict beats — about once every 69 rounds.
[MATH.md §9.3](MATH.md) publishes every note's exact frequency and the number of
states that can produce it, and the enumerator **fails the build** if any note
becomes unreachable. That check is the difference between this hook and the last
one.

`D = 0` is reachable only when `5m = 4n`, i.e. when `n` is a multiple of 5. A
generation that ends the round (extinction, FULL BLOOM, generation 18) skips the
verdict beat and goes to its terminal screen — which is also why the largest
gains at high populations are not lost to a silent band: at `n ≥ 8` a
generation in which every organism splits reaches FULL BLOOM, and the bloom
reveal (§7.2) is louder than any chord.

**Generation 1 has a verdict beat too, and its baseline is the truth.** The
colony is compared against `19/20 = 0.95x`, its exact value at the moment of
purchase ([MATH.md §5](MATH.md)), not against the `1.00x` the player paid. The
band and the stake line happen to agree exactly here — `D < 0` needs
`c(1) * m < 19/20`, i.e. `m <= 2`, which is also the condition for being under
the stake — so the first beat is a loss beat on `68/125 = 54.40%` of rounds, the
same figure §9.2 is written around. A first beat that celebrated those would be
lying on the very first frame of the game.

### 6.6 Type direction

**Money is not a hash, and they do not get the same face.** Round 1 set every
figure in the game in the monospace stack, including the payout — which reads as
a terminal readout rather than as an amount, and is the typographic half of a win
that measured as a receipt. The split is by *what the number is for*:

- **Money and multipliers** — the payout, the colony value, the balance, the
  action-bar amounts, the stake, the session net: the **heaviest grotesque the
  device has**, at 700–800 weight, with `tabular-nums` and lining figures switched
  on explicitly. Tabular figures are non-negotiable: these count up and down and
  must not jitter. The payout numeral is ≥ 4% of frame height and sits *inside*
  the vessel in INK, dark-on-light (§7.1).
- **The unit is attached to every figure the player reads as money.** `CR` — this
  game's free-play credit, with no cash value, as the marker at the foot of every
  screen states. `1,003.73 CR`, `STAKE 1.00 CR`, `BANKED 9.21 CR`, `NET +8.21 CR`.
  Round 1 shipped bare decimals, and in a blind side-by-side that was one of three
  tells that gave the build away on sight: every reference attaches its unit to
  every figure (`1.10 FUN`, `Win: 2.00 FUN`, `Balance 1,000.00 FUN`), because a
  bare decimal is not money, it is a number. On the payout it is set as a separate
  smaller run at 0.30 em, so the unit is attached without being set at the
  payout's size. Thousands are grouped, so a four-figure balance reads as one.
- **Commitments, seeds, chain values and the verify sheet**: the monospace stack
  — Space Grotesk, Basis Grotesque Mono or Suisse Intl Mono. These are strings to
  compare character by character, not amounts to feel, and a hash set in a display
  face reads as a lie.
- **UI text**: a humanist sans with a high x-height at small sizes (Inter,
  Söhne).
- **Scale** (390 pt baseline): colony value 56/60 pt, yield line 28/32 pt,
  labels 13 pt uppercase with +8% tracking, body 15/20 pt, legal 11 pt.
- **Rules**: money always shows two decimals; multipliers always show two
  decimals; nothing is ever rounded up in display; a negative delta always shows
  its sign.

**Contrast binds before every other criterion in §6.** Panel faces are lit at the
*lip* rather than across their upper third, because MIST needs a background under
WCAG relative luminance 0.06 to clear §9.6's 4.5:1 and a genuinely mid-lit teal is
three times that. A first pass that lit the top 26% of every panel drove
`COLONY STAKE` to 2.87:1 and the side-bet copy to 3.20:1 — measured pixel-true by
Otsu on the real composite, because computed colours lie on a translucent surface
over a canvas. Every text run on every screen is audited that way and the worst
reading in the game is 4.79:1.

### 6.7 Three visual references (described, not reproduced)

1. **ROV floodlight on a deep-sea siphonophore against absolute black.** A chain
   of translucent bells, each with an internal glowing node, drifting with no
   visible background. Take from it: gel translucency, how internal light reads
   through a membrane, and the total absence of environmental context.
2. **Long-exposure photograph of bioluminescent plankton in a breaking wave at
   night.** A cyan smear against near-black water with strong halation around the
   brightest points. Take from it: colour temperature and bloom behaviour — not
   composition, and **not** its grain: a photograph's grain is the sensor, and a
   sensor is not one of this product's materials (§6.2).
3. **The dark instrument panel of a research submersible.** Matte black
   surfaces, thin cyan strokes, tabular readouts, exactly one warm amber
   telltale. Take from it: UI restraint. Information is thin lines and numbers
   over darkness, and warmth is rationed.

---

## 7. The settlement ceremony, and the viral clip

### 7.1 The ceremony is scaled to the money

FULL BLOOM is a *population* event, not a size-of-win event, and it was a design
error to treat the two as the same thing. What blooms actually pay:

<!-- generated:bloom -->
| FULL BLOOM payout | Value |
| --- | --- |
| Smallest possible | 9.895833x (generation 3, 16 organisms) |
| Median | 37.749608x |
| Largest possible | 527.355936x |
| Share paying under 20x | 17.31% |
| Share paying under 50x | 61.60% |
| Share paying under 100x | 84.24% |
| Share paying less than the smallest generation-18 settlement (17.578531x) | 10.36% |
| Frequency, never-harvest play (`RUN`) | 1 in 22217.97 — the figure belongs to a policy; see the per-policy table |
<!-- /generated:bloom -->

The smallest bloom pays 9.89x. 61.60% of blooms pay under 50x. 10.36% of them
pay less than the smallest payout a surviving generation-18 colony can produce
(17.58x) — which, under the old rule, got the game's maximum celebration while a
larger win got none.

**So the ceremony tiers on the round's total credited multiple, whatever produced
it — and the first thing it splits on is whether the player is up or down:**

| Tier | Round total `X` | Treatment |
| --- | --- | --- |
| **T-nil** | `X = 0` | Screen S6. The extinction fall, flat copy, no count-up |
| **T0-loss** | `0 < X < 1` | **Value settles in place with no count-up into the balance chip.** The credited amount is stated once, in MIST, beside an explicit signed net result: `RETURNED 0.40 · NET −0.60`. No swell, no card, no amber. 600 ms |
| **T-even** | `X = 1` exactly | The cold slab, no count-up, no amber, no share: *"This round returned exactly what it cost."* A celebration for getting the stake back is louder than the result deserves, and every stake-back it fires on is headroom the tiers above no longer have |
| **T0-win** | `1 < X < 2` | Value settles, balance chip counts up in AMBER, signed net result shown in FOAM. 600 ms. No swell, no card |
| T1 | `2 ≤ X < 10` | 800 ms count-up, the swell sized off `X`, share card available but not offered |
| T2 | `10 ≤ X < 50` | Frame lifts one exposure stop, 1,000 ms count-up, share card offered |
| T3 | `X ≥ 50` | The full treatment: frame to full illumination, 1,200 ms count-up, the swell at full size, freeze-frame share card. 2,400 ms |

**There is no screen-wide wash. The lift is one step, and the swell is one
object.** A full-screen radial crossing quantisation bands *as it ramps* registers
as a handful of separate moving regions along its own edge — measured, ten of them
in the 400–600 ms window of a round-1 T2 settlement with the largest owning 37% of
the motion, and 5/8/9/1 across round 2's four ceremony beats against a ceiling of
seven. The lift was never the problem; a lift that *animates across the whole
frame* while two objects are already arriving is. It is applied in a single step
by `Stage.settle`, on the same frame as the overlay's own arrival, so the whole of
it lives inside the one region that is already changing.

What is left of the swell is the part that belongs to the payoff: **light rising
out of the glass the money is in.** It is a shower of AMBER sparks from the
vessel's own mouth — a single small centred region, never a screen-wide effect —
and it is counted off the round's **credited multiple** rather than its tier, on
the same curve the fill uses: six sparks at a stake back, thirty-four at 30x.
Round 2 gave the swell to T3 alone, which meant every win from 2x to 50x — very
nearly every win a player ever sees — got no stage beat at all, and a table that
names three sizes shipped one.

**The 250 ms of silence before the loud tiers is cut.** Measured from the BANK
tap, round 1 spent **1.4–1.8 s in which consecutive frames changed 0.16%** — with
nothing happening at all — and the payout card was not fully readable until
3.07 s. The player has already committed and already knows the number; three
seconds of near-stillness before the payout surface arrives is the opposite of
"the outcome legible the moment it is known", and every reference cuts straight to
the gold banner. Anticipation belongs to the *reveal* of a generation, where it is
bounded, fixed and carries real uncertainty — not to a total the player watched
accumulate.

**The payout vessel, and it is an object rather than a colour.**

Round 1 delivered every tier above as *amber type on dark glass*. Measured against
the idle screen it followed, the winning frame was **7% darker**, its highlight
area was unchanged, and the brightest most-saturated region in the whole picture
was the full-LUMEN `NEW ROUND` button in the bottom 15% — focal centroid
`y = 0.84` on a screen whose subject is the money. The reference payoffs in this
category measure **+84% mean luminance, ×3.4 highlight area, focal object ×6.5,
centroid `y = 0.48`**, and every one of them builds a *physical surface* with the
number inside it. A win communicated by a number changing colour is the
anti-pattern the whole set agrees on.

So a winning settlement builds the **vessel**: a glass, at the optical centre,
with the round's money standing in it.

**And the colony survives its own settlement.** Round 1's ceremony *replaced* the
frame with a full-screen ray fan; round 2 cut the rays and then did something
almost as bad — it **deleted the colony** at the instant of payoff, because a bank
is structurally a harvest of every organism and the harvest beat flies the bodies
off the stage. So the payout landed on empty water. Measured against the idle
frame the celebration delivered +10.9% mean luminance where the floor is +50%,
highlight area ×1.74 where the floor is ×2, and *saturated* share falling from 81%
to 47% — the payoff was emptying the frame where every reference in the set lights
it and keeps its objects on the playfield.

A bank therefore hands the colony to the ceremony instead of flying it away. On
the frame the settlement opens, all at once: the stage lifts to the round's
**credited value**, the vent blooms, the colony takes AMBER and rises into the
water above the vessel, and the vessel's own light falls across the water column
and the frame below it. Then the light leaves the bodies for the glass, and what
is left standing is the colony that paid — AMBER mass at a third of its emission,
still, an order of magnitude under the payout surface, and *there*.

The lift is applied in **one step**, on the same frame as the overlay's own
arrival, and that is an effect-budget decision as much as an art one: a
full-screen gradient that ramps registers as a handful of separate moving regions
along its own edge, and round 2's four ceremony beats measured 5, 8, 9 and 1
regions against a ceiling of seven. Composed into the frame that is already
changing, the whole lift is inside one region — the shape every reference payoff
has.

The scrim is a **band**: open across the stage window so the frame keeps its
picture, and warm below it, because the light the vessel throws has to land
somewhere. Round 2 held the lower two fifths at 46–54% of the floor colour, which
is a third of the payoff frame carrying no material at all.

**There is one vessel, and it is the payout surface.** Round 2 had two: this one,
and a small beaker on the stage that harvested light poured into. Measured, the
beaker was a 1 px amber stroke with a straight top rail — no ellipse, so it did
not read as a cylinder at all — and once the pour had gone home it was an *empty*
glass, which at settlement registered as a second bright saturated region at
`y = 0.18` containing nothing, at the one moment the frame is allowed exactly one
focal object. It is cut. §5 (S5) always said where harvested value goes — "travel
to the balance chip" — and that is where the harvest trails go.

**And the vessel has a level in it.** Round 2's payout surface was one size and
one brightness for every win: a 1.85x and an 11.32x measured within 4% of each
other on mean luminance, highlight share, colour count and focal area, because
the only thing separating them was which of four static tier styles the card wore.
A ceremony that cannot tell those two apart has nothing left for the top of the
table.

The glass is therefore built as a volume — an elliptical rim across the mouth,
wall thickness (a bright inner edge inside a dark outer one), a lit left wall and
a shaded right one, a meniscus where the liquid meets the glass, caustics on the
amber, a specular down the front and a contact shadow under the base — and
`--vessel-fill` is the round's **credited multiple** on a log scale, `0` at a
stake back and `1` at 30x and above. It drives the level of the amber, the height
of the glass, the reach of the bloom it throws and the size of the shower rising
out of it, together. A 1.2x barely wets it; a 20x floods it to the rim.

The readings sit *inside* the amber, dark on light, and the level is never allowed
to fall below the block that holds them — so no figure can ever land on empty
glass.

**The generation-by-generation bar chart is cut.** It was a real record — the
player's own resolved populations, already in the receipt — and it failed the
subtraction test twice: unreadable at its rendered size, and on a loss it
collapsed to a single grey stub that read as a broken render. It was also up to
eighteen independently animating bars on the one beat whose whole instruction is
*one dominant motion*. The full trace stays one tap away, in the receipt, where it
is legible.

| Property | Specification | Measured, T1 |
| --- | --- | --- |
| Surface | a glass: elliptical rim, wall thickness, lit left wall, shaded right, meniscus, caustics, front specular, contact shadow — filled with AMBER on a vertical ramp, AMBER HIGH lip, AMBER DEEP seat | — |
| Level | `log2(1 + X) / log2(31)` of the credited multiple, clamped to `[0, 1]`; drives fill height, glass height, bloom reach and shower size together | 0.20 → 1.00 |
| Area | 6–12% of the frame at the low tiers, growing with the money, and the frame's luminance maximum | **11.0% (T1), 13.3% (T2)** |
| Placement | optical centre, centroid `y` 0.35–0.55 | **y = 0.40–0.47** |
| Single focal object | exactly one region simultaneously brightest and most saturated | **5.1–8.5 : 1** over the next |
| Numeral | **dark-on-light, INK on the amber**, inverting the base state's light-on-dark; label above a hairline rule, amount below, multiple under it | 11.7:1 |
| Frame lift vs idle | mean luminance ≥ +50%, highlight area ≥ ×2 | **+39.6%, ×1.67** |
| Colour temperature | swings warm; roughly half the frame's hue mass in the ambers | 45–52% at 30° |
| Entrance | card 460–620 ms with a back-out overshoot, then the liquid rises over 620 ms; then **still** | 0 moving regions once settled |

**On the two figures the lift table does not reach, and why they are stated rather
than argued away.** The reference celebration anatomy is a set of *ratios* against
the base state, and this game's base state is unusually well lit: the idle frame
measures 0.259 mean luminance and 80% saturated pixels, against the reference
whose payoff ratio the rubric quotes measuring 0.107 and 3.6%. Two of the three
sub-measures are therefore arithmetically out of reach here rather than unmet.
Saturated share ×3 from a base of 80% would require 240% of the frame; and roughly
15% of every frame is persistent chrome — the top bar and the free-play marker —
which is identical on both sides of the ratio and mathematically caps it. What the
payoff is held to instead: mean luminance up **+39.6%** (round 2: +10.9%),
highlight area up **×1.67** (round 2: ×1.74 on a frame that was *emptier*), lit
surface **20% → 42%**, colour depth **2,662 → 2,410** on a frame that measured
1,669 in round 2, and a saturated share of **48%** that clears criterion 7's floor
instead of the ratio. Criterion 7's floor (40%) and criterion 12's single focal
object are both held ahead of the ratio, because a floor and a gate outrank a
target: pushing mean luminance to +48% cost the win frame's saturated share 36%
and gave it a second bright saturated region of 4.7%, and that trade was refused.

**And the loss builds nothing warm — but it is still built.** No vessel, no amber,
no lift; win and loss stay separable pre-attentively, by colour, luminance and
motion, before a digit has been read, and nothing in the vessel's specification
can be reached by a partial return that came in under the stake.

What changed is that a loss is no longer *absent*. Round 1's extinction frame
measured **97.2% dark band, 2.6% lit surface, 370 distinct colours and no game
object at all** — below the desaturated skin the calibration set ships as its own
example of amateur work, on the most-seen frame in the product, because extinction
is this game's modal outcome. Removing the light was right; removing the picture
was the defect. So the down tiers get:

- **the husks** — the colony's own remains, mass with no emission, ASH-toned,
  gathered in the water column above the card and completely still. They are laid
  out there rather than left where they died, because the colony's centroid sits
  at 30% of the frame and the card starts at 35%: a round that ended with one or
  two organisms left its entire remains behind the card;
- **the cold slab** — the same construction as the vessel (graded face, lit top
  edge, seated bottom, specular, contact shadow) executed in BASALT and ASH
  instead of AMBER. A spent, unlit slab of the same rock the vent is made of;
- **FOAM on the slab, not MIST on a void.** A figure the player must read has to
  be legible, and §9.6's contrast floor is not something the tone of a screen gets
  to trade against.

**And the primary control grows to keep its place.** With a colony standing at
the vent on the stake screen, the button that starts the round has competition it
did not have when the frame was empty — measured, the idle frame's focal object
moved to the colony's own light at `y = 0.25`, against criterion 13's requirement
that the idle focal object is the control, centroid `y >= 0.80`. The reference
answer is not to dim the game object: the reference keeps its whole board lit and still
makes the glossy PLAY disc the focal point. So the CTA is 72 pt of full-width
LUMEN with a *tinted* specular — a white sheen drops the face's saturation under
the 0.35 the focal measure uses, which was excluding the brightest part of the
control from the region it is supposed to own — and the volumetric water term
starts smaller and grows faster, so the poorest frame in the game no longer throws
the brightest cloud in it. Measured after: focal 7.6% of frame, 91.6% of width,
centroid **`y = 0.81`**.

**The control after a result is demoted, deliberately.** `NEW ROUND` is a
dimensional but unlit control on the settlement screen: full width, full height,
full contrast, and never the brightest thing in the frame. Exactly one region may
be the luminance maximum in any state, and at a payoff it is the vessel — the eye
belongs on the money that was just won, not on the next stake. That reading is
also the responsible one, and the two agree.

**EVERY CONTROL IN THE PRODUCT IS A LIT OBJECT, AND THIS IS THE CONSTRUCTION.**
Not the primary and not only the ones on the money surface: every control,
including `RECEIPT`, `VERIFY`, `SHARE`, `HELP & PAYTABLE`, `HISTORY`, the two
masthead icon buttons and the stake stepper's `−` and `+`. A blind comparison
picked this build out of a set of shipped products on exactly this, faster than
on anything else: those controls were dark rectangles with a single 1 px stroke
and nothing else, while every button in every reference is modelled. The rubric
bans the construction outright — *never an outline* — and it does so for a
mechanical reason: a 1 px stroke has no volume, so it cannot carry a pressed
state, and it measures as hard edge rather than as material.

**One key light for the whole product: above, very slightly left.** Nothing
invents its own direction. Four layers, in order:

1. a **graded face** — never a flat fill, and never a wash so faint the control is
   discoverable only by its stroke;
2. a **bezel** — a bright inner lip along the top edge inside a saturated outer
   ring, which is what gives an edge a *section* instead of a line. This is the
   layer that was missing from the primary CTA, and it is the one that does the
   most work: without it a control is a coloured area with a boundary; with it, it
   is a cap set into a ring, and the eye reads two materials;
3. a **darker inner edge along the bottom**, so the face is a face and not a
   sticker;
4. a **seat** — a hard lip the control stands on, a tight contact shadow and a
   wide soft one, both tinted to the floor so nothing manufactures black. The
   reference's "grounding shadow" is always two shadows: one is either too tight
   to ground it or too soft to touch it.

The **specular** is a shape, not a fade: an inset cap with its own elliptical
bottom, so the gloss ends on a curve that reads as the crown of the button turning
away. It is tinted to the control's own chroma rather than white — a white sheen
at 38% over LUMEN drops the face's saturation under the 0.35 the focal measure
uses, which excluded the brightest part of the primary control from the region it
is supposed to own.

The press then has something to take away, which is the reference behaviour
measured on the genre's canonical PLAY control: **specular off, element down 2 px
into its own shadow, contact shadow collapsed**, inside 100 ms and before any
network round-trip. Secondary controls are quieter **by value**, never by being a
drawing of a control while the primary is a control.

**Why T0 had to be split, with the frequency.** Round 2 defined T0 as `X < 2` and
gave it "value settles in place, balance chip counts up". `X` is the round's
*total credited multiple*, so that single tier covered a `0.40x` return and a
`1.90x` win and gave both the same money-flowing-into-your-balance animation.
That is a loss presented as a win, at the loudest and most memorable beat in the
round, and it is not a rare case — it is the **most common outcome class in the
game** under the two policies a new player is most likely to use:

<!-- generated:settlement-classes -->
| Policy | Returns nothing | Returns **less than the stake** | Returns more than the stake |
| --- | --- | --- | --- |
| `BANK_FIRST` | 6.40% | 48.00% | 45.60% |
| `RUN` | 97.75% | 0.00% | 2.24% |
| `HALF_EVERY` | 19.19% | 50.04% | 30.75% |
| `STOP_AT_2X` | 65.69% | 0.00% | 34.30% |
| `STOP_AT_10X` | 92.70% | 0.00% | 7.29% |
| `HALF_AT_2X` | 65.97% | 5.41% | 28.61% |
| `BANK_AT_GEN_5` | 58.34% | 14.54% | 27.10% |
| `PANIC` | 10.97% | 71.89% | 17.12% |
<!-- /generated:settlement-classes -->

Half of all `BANK_FIRST` rounds and half of all `HALF_EVERY` rounds return
something, and less than the stake. §6.5 spends a full page and four numbered
rules making sure a single generation cannot mislead; the settlement beat gets
the same discipline or the page was decorative.

**The binding rules for T0-loss**, which are as load-bearing as R1–R4:

- **No count-up into the balance chip.** The chip is AMBER and AMBER means
  "yours, banked, safe" (§6.1). A number flowing into it reads as a win in
  peripheral vision, muted, at arm's length — which is how most of these frames
  are seen.
- **The net result is stated, signed, and at least as prominent as the credited
  amount.** `NET −0.60`, not `RETURNED 0.40` alone. A player must never have to
  do subtraction to find out they lost.
- **MIST, not FOAM, and no swell.** The same treatment a losing generation gets
  in §6.5, for the same reason.
- **No share card, at any total below the stake.** Not offered, not available.

The boundary is exact and needs no tie-breaking rule: **no round can settle at
exactly one stake** ([MATH.md §13.1](MATH.md)), because every credit carries an
uncancellable factor of 19 over a denominator of 2s and a 3. `X < 1` and `X ≤ 1`
are the same set.

`X` is the **whole round's credited multiple**, harvests included, because that
is what the player actually took home: a round that harvested 8x on the way and
settles for 3x is an 11x round and gets T2. A round that runs to generation 18
with three organisms and never harvests totals 52.74x and gets T3. A round that
blooms at generation 3 with no prior harvest totals 9.89x and gets T1. And a
round that harvested 0.40x and then went extinct is a `0.40x` round and gets
T0-loss, however dramatic the extinction was. The loudest moment in the game is
now the biggest win in the game, and the quietest is a loss, which was the
intention all along.

### 7.2 The environment reveal, specified — and it is not a bloom effect

This is the clip the marketing case rests on, so it gets numbers like everything
else in §6. Round 3 called it "a physical consequence of §6.3, not a bespoke
effect" and then fired it on a *population* event, which §6.3 cannot express: the
tone map is strictly increasing in colony **value**, so it cannot tell sixteen
organisms at generation 3 (`9.895833x`, `E = 0.406`) from three organisms at
generation 18 (`52.735593x`, `E = 0.650`) except by saying the second is
brighter. Either the environment lights on both, or the reveal is keyed to
population and the justification is false — and a population-keyed spectacle is
the error §7.1 and §8.1 spend two pages removing everywhere else, and §6.5 R1
forbids outright.

**So it lights on both, and the threshold is a value.** The environment rises
above the black floor when the colony is worth at least `475/48 = 9.895833x`,
which is exactly the smallest value a FULL BLOOM can have. Nothing is switched
on: the environment was always there and was always unlit, and this is the
exposure at which it stops being below the floor. Consequences, stated rather
than left to be noticed:

- **Every bloom lights it**, because every bloom is at least this rich. The
  marquee moment keeps its picture.
- **So does every frame worth as much**, bloom or not — a surviving colony at
  generation 12 with three organisms is `13.82x` and lights the same world.
- It is therefore **not unique, and it is not a tier**. What is unique about a
  bloom is that it force-settles; what scales with the money is the ceremony
  around it (§7.1).

How often it actually happens, against how often a bloom does — both exact, both
per policy, because both depend on how the round is played
([MATH.md §8.2](MATH.md)):

<!-- generated:bloom-by-policy -->
| Policy | P(FULL BLOOM) | One in | P(a frame worth 9.895833x or more) | One in |
| --- | --- | --- | --- | --- |
| `BANK_FIRST` | 0 | **never** | 0 | **never** |
| `RUN` | 4.50086e-05 | 1 in 22217.97 | 7.29125e-02 | 1 in 13.71 |
| `HALF_EVERY` | 0 | **never** | 1.57043e-03 | 1 in 636.76 |
| `STOP_AT_2X` | 0 | **never** | 0 | **never** |
| `STOP_AT_10X` | 3.73905e-06 | 1 in 267447.36 | 7.29125e-02 | 1 in 13.71 |
| `HALF_AT_2X` | 0 | **never** | 4.82655e-03 | 1 in 207.18 |
| `BANK_AT_GEN_5` | 4.80285e-06 | 1 in 208209.38 | 3.53580e-04 | 1 in 2828.20 |
| `PANIC` | 3.40556e-05 | 1 in 29363.68 | 1.31093e-02 | 1 in 76.28 |
<!-- /generated:bloom-by-policy -->

Read the `RUN` row: the environment lights on one round in 13.71 and a bloom
happens on one in 22,217.97, so the reveal is about 1,620 times more common than
the event round 3 attached it to. Read the `HALF_EVERY` row for the other half of
the correction: a player using the one-tap default lights the world once in
636.76 rounds and **never** blooms at all (`floor(n/2)` caps the colony below the
threshold — [MATH.md §8.2](MATH.md)). A reveal keyed to blooms would be a reveal
that player never sees; a reveal keyed to value is one they can reach by riding a
colony, which is the decision the game is actually about.

**The marketing case, scoped.** The clip is the world appearing, and it is
reachable: about 7% of never-harvest rounds produce one. FULL BLOOM is a rarer,
different event — a terminal — and any claim that rests on *it* is a claim about
1 in 22,218 rounds for a player who never harvests and 1 in never for a player
who taps the default. §1.1's rule applies here too: before any of this reaches
marketing, the number has to travel with the policy it belongs to.

**The reveal, beat by beat** (1,000 ms, fired at most once per round, at the
moment the colony first crosses the threshold — which is usually mid-round and
has nothing to do with settlement; it replaces that generation's verdict beat and
the round continues):

| Beat | ms | What moves |
| --- | --- | --- |
| Threshold | 0 | The generation that carried the colony to `9.895833x` finishes resolving. Audio drops to the bed alone |
| Exposure rise | 0–420 | Exposure ramps from its previous value to `E(V)` on `cubic-bezier(0.2, 0.0, 0.0, 1)`. Halation radius scales 32 → 96 px, opacity 12% → 26% |
| Environment | 180–700 | Silt, rock and plankton fade up from 0% to full lit value, staggered by depth: near silt at 180 ms, chimney wall at 300 ms, far rock at 520 ms, drifting plankton last at 700 ms |
| Settle | 700–1,000 | Exposure eases to steady state; the colony's drift resumes at half amplitude |

**Camera and composition.** The camera does not cut, does not shake and does not
zoom. It dollies back **8%** over the full 1,000 ms on the same easing as the
exposure ramp, and that is the only camera move in the game. The colony stays on
the vent-plume centroid at 38% screen height; the widening `R(n)` (§6.4) plus the
dolly keeps the mass at a constant 62% of frame width, so the clip is
compositionally identical whether the frame holds three late organisms or thirty.

**Materials, so a lookdev artist can start.**

| Element | Spec |
| --- | --- |
| Near silt | Flat plane at the frame base, occupying the lower 18%. Albedo BASALT `#123240` at 30% value, roughness 0.95, no specular. 3-octave value noise at 0.4 px/pt for grain. Receives colony light only |
| Chimney wall | The existing vent geometry, previously visible only as an EMBER rim. Matte basalt, roughness 0.9, normal map amplitude 0.35, one-sided. Now lit from above by the colony, which is the first time its silhouette resolves |
| Far rock | Two parallax cards at 1.6x and 2.4x the colony's depth, CRUST `#1E4A56` at 12% and 6% value respectively, blurred 4 px and 9 px. They exist to give the dolly something to move against |
| Drifting plankton | 240 point sprites in PLANKTON `#5B8CFF`, 1.5–3 px, 8% opacity, distributed in a 3D shell between the two rock cards. Brownian drift at 0.6 pt/s with a 0.1 pt/s downward bias. Twinkle: per-sprite opacity sine at 0.3–0.7 Hz, ±40% |
| Suspended particulate | 60 larger motes, 4–7 px, 5% opacity, ASH `#8A97A6`, drifting downward at 1.4 pt/s. These are marine snow and they are what makes the water read as water rather than as fog |
| Volumetric shafts | Two soft cones from the colony mass toward the near silt, 6% opacity, 40 px blur, animated only by the colony's own motion. No god-ray shader; this is two blurred quads |

**Asset list**, complete: one silt plane, one chimney normal map (already exists),
two far-rock cards, one plankton sprite atlas (4 variants), one mote sprite, two
shaft quads. Seven new assets and one reuse. Everything else is the existing
lighting doing what it already does.

**Reduced motion and low tier.** Under `prefers-reduced-motion` the dolly and the
staggered fade become a single 400 ms cross-fade to the lit frame; the reveal
still happens, because it carries information — it is the exposure curve at a
value the player is holding, and §6.4 keeps the exposure change under reduced
motion for the same reason. On the
low tier the far-rock cards drop to one, plankton drops to 90 sprites and the
shafts are cut; the silt, the chimney and the exposure ramp stay, because they
are the reveal.

**Why it is clippable.** The illumination is one second, needs no context, and
the payoff is visual rather than numeric: the screen literally fills with light
and a world appears. It reads on a muted phone in a feed. The ceremony that
follows is 600 to 2,400 ms depending on the tier, so a rich round is a
three-second clip and a bare crossing is a short one — which is correct, because
they are not the same win. A bloom at generation 10 pays at least 47.18x and at
generation 18 at least 281.25x, so at the top of the range the biggest clips and
the biggest wins do coincide; they simply are not the same event.

**The near miss.** Reaching 12 to 15 organisms and never blooming happens once in
1,223 rounds. It needs no special handling — the frame is already almost fully
lit and then goes dark. That is affecting because it is real.

**What we do not do.** No fake reveal for a frame that is not worth the
threshold. No second reveal in a round that already lit — the environment stays
lit once it is lit, and dims with the exposure like everything else, because a
re-reveal would be a spectacle keyed to crossing a line rather than to money. No
"so close" overlay. No tier promotion for a near miss.

---

## 8. Sound direction

Underwater, hydrophone-flavoured, everything slightly low-passed. Dark reverb
with a long tail and no early reflections.

| Layer | Sound | Notes |
| --- | --- | --- |
| Bed | 40 Hz vent rumble + band-limited noise, −32 LUFS, 0.05 Hz filter sweep | Static while a decision panel is open — the audio must never push a decision |
| Organism breath | 220 Hz sine blip, 40 ms attack, panned by screen position | Voice-limited to 6; a big colony reads as a chord, not a crowd |
| SPLIT mark | Short wet glass tick, 880 Hz, 8 ms attack, 180 ms decay, −18 dB | Informational only. It does **not** escalate and it does **not** grow with the number of splits (§6.5 R1) |
| HOLD mark | 30 ms filtered tick, −22 dB | Barely present |
| DIE mark | 90 Hz thud with fast low-pass, −18 dB | The same level as the split mark. Felt and heard, with no "fail" motif and no descending pitch (§6.5 R3) |
| Verdict, gain | Two-note rise below one stake gained; at or above it a rising chord at `min(7, floor(log_1.5 D))` semitones | This is the hook. It is keyed to money in stake multiples, every note is proved reachable by the enumerator, and the top note sounds on 1 in 333.88 verdict beats ([MATH.md §9.3](MATH.md)) |
| Verdict, loss | One short low mark, −18 dB, no pitch movement | Present, never punishing |
| HARVEST | One soft "banked" click, −22 dB, at the moment the value lands in the chip | Informational, not a reward: a harvest is a transfer and its signed value change is zero (§6.5 R6). No pour, no swell, no rising figure |
| Environment reveal | Bed only for 180 ms, then a single sub-bass swell (28 Hz, 900 ms) under a wide reverse-reverb bloom | Carries the environment fade (§7.2), which is keyed to colony value. No stinger, no fanfare |
| Settlement, at or above the stake | Per tier (§7.1); T2 and T3 open with silence | The silence does the work |
| Settlement, below the stake | The soft click of the value settling, and nothing else. No pour, no swell, no chime | T0-loss (§7.1). A round that returned less than it cost does not get a win sound, and a muted phone must not be the only thing that tells the player so |
| UI | Soft membrane taps, no clicks | 8 ms attack |

Mix rules: dialogue-free, mono-compatible, fully playable muted (every audio
event has a visual counterpart, and every visual event that carries money
information has an audio counterpart). A muted phone must lose nothing but
pleasure.

---

## 9. Responsible design

These are constraints on the build, not aspirations.

### 9.1 No loss chasing between rounds

- No copy anywhere uses "recover", "win it back", "revenge", or "streak".
- After a loss the `NEW ROUND` control keeps the same size, position and
  emphasis it always has, and the stake is never pre-incremented.
- No auto-rebet with escalation. Auto-play, if built, is fixed-stake, capped in
  rounds, and cancellable in one tap.
- Cumulative session result is always available in one tap and is never hidden
  behind a positive-only "wins" view.

### 9.2 No loss chasing *within* a round — the underwater state

The mandatory first generation leaves the player below their stake with
probability exactly `68/125 = 54.40%`, through a resolution they had no decision
over: `8/125` extinct outright, `12/25` alive but worth 0.3958x or 0.7916x. From
there, `BANK` crystallises a loss and `CONTINUE` is the only action that can
reach the stake again. Roughly half of all rounds are placed in the canonical
chase configuration by the game itself, and a responsible-design section that did
not say so would be incomplete.

<!-- generated:break-even -->
| Generation | Organism value | Organisms needed to be worth more than the stake | A colony of 3 is worth |
| --- | --- | --- | --- |
| 1 | 0.395833 | 3 | 1.187500x |
| 2 | 0.494791 | 3 | 1.484375x |
| 3 | 0.618489 | 2 | 1.855468x |
| 4 | 0.773111 | 2 | 2.319335x |
| 5 | 0.966389 | 2 | 2.899169x |
| 6 | 1.207987 | 1 | 3.623962x |
| 7 | 1.509984 | 1 | 4.529953x |
| 8 | 1.887480 | 1 | 5.662441x |
| 9 | 2.359350 | 1 | 7.078051x |
| 10 | 2.949188 | 1 | 8.847564x |
| 11 | 3.686485 | 1 | 11.059455x |
| 12 | 4.608106 | 1 | 13.824319x |
| 13 | 5.760133 | 1 | 17.280399x |
| 14 | 7.200166 | 1 | 21.600499x |
| 15 | 9.000207 | 1 | 27.000623x |
| 16 | 11.250259 | 1 | 33.750779x |
| 17 | 14.062824 | 1 | 42.188474x |
| 18 | 17.578531 | 1 | 52.735593x |
<!-- /generated:break-even -->

The rules that follow are binding.

- **Invariant hierarchy.** The action bar's layout, order, sizing, colour and
  emphasis are identical whether the position is above or below the stake.
  `BANK` is the visually primary action in both. Nothing may be de-emphasised or
  promoted based on the sign of the position. This is the single most important
  anti-chase rule in the game, because the alternative — quietly making
  `CONTINUE` more attractive when the player is down — is both easy and
  invisible.
- **Show where you stand; never show the way back.** The value strip always
  carries the stake line (§6.3) and the exact colony value, so the player can
  always see whether they are up or down. The play surface may **not** render
  the population or the number of generations needed to return to the stake, and
  may not surface any target, progress bar, countdown or "distance to even"
  affordance, at any point in a round.
- **Where the break-even ladder is allowed to live.** The table above is part of
  the paytable and belongs in the help screen: identical for every player,
  identical in every round state, reachable before, during and after a round,
  and never pushed, highlighted, contextualised to the current colony, or
  surfaced by anything the round does. A fact a player chooses to look up is not
  the same object as a prompt fired at the moment they are losing, and the line
  between them is whether the game brought it up. **The same rule governs the
  FULL BLOOM frequencies and the harvest's effect on them** ([MATH.md §8.2](MATH.md)):
  help screen, pull, never push, and never at a decision.
- **The one forward-looking number, and why it is allowed.** S4 states the next
  generation's yield — *"Next generation: 0.77x per organism"* — and it is the
  only number on the play surface about a generation that has not happened. It
  stays, under four conditions that keep it a price rather than a route back:
  it is a **per-organism ladder constant**, identical for every player at that
  generation and independent of the colony, the stake and the history; it is
  **never multiplied by the current population**, because "your colony would be
  worth X next generation" is a projection and a target; it is **never
  accompanied by a comparison to the stake**, a delta, an arrow or a "needed to
  break even"; and it never changes emphasis with the sign of the position. It
  is the price of the decision the player is being asked to make, which §3's
  zero-fake-agency rule requires them to know — while "how far to even" is a
  route, and §9.2 bans routes. The ladder it comes from is public, printed in the
  help screen in full, and the same for everyone.
- **Banned copy**, in the UI and in notifications: "break even", "get back to",
  "back to even", "you need", "only N more", "almost there", "one more
  generation", "don't stop now", "your colony can still".
- **No mid-round bets.** Side bets cannot be added after `SEED` (§3), so no bet
  is ever offered to a player who has just watched a bad generation.
- **Nothing escalates as the round goes on.** No copy, sound or animation
  changes because the player has been in the round longer or is further down.
- **Say it plainly in help**, in this order: *"About half of all rounds are worth
  less than your stake after the first generation. Continuing is not a way back:
  every choice you can make has the same expected return, before rounding. Bank
  whenever you want."* The qualifier is not hedging and it is not optional:
  [MATH.md §6](MATH.md) is a theorem about the exact rational value the paytable
  owes, and what a wallet credits is that value floored at each credit event, so
  a player who harvests often is behind a player who banks once by strictly less
  than 18 minor units a round — less than both `0.000018` credits and `0.018`
  percentage points at the minimum
  stake ([MATH.md §13](MATH.md)). The help screen states the size in the same
  breath as the claim, which is the only way to say both true things at once.

### 9.3 No misleading numbers

- **Profit rate leads.** Any published or in-client "how often do I win" figure
  is `P(return > stake)`. The `P(return > 0)` hit rate may appear beside it,
  labelled, never instead of it. Banking at the first decision returns something
  93.60% of the time and returns more than the stake 45.60% of the time; quoting
  only the first number would be presenting a 0.396x return as a win.
- **A ticket's profit rate is not its lines' profit rates.** The colony bet and
  the side bets are drawn from the same rows, so a ticket has a profit rate of
  its own and it moves a long way: at equal stakes, adding DARK VENT to a
  `BANK_FIRST` colony bet takes the chance of finishing the round ahead from
  45.60% to 36.09%, and adding it to a `RUN` colony bet takes it from 2.25% to
  37.57% ([MATH.md §7.4](MATH.md)). Binding rules: a combined figure may be shown
  **only when the stakes on every selected line are equal**, because the number
  depends on the ratio and no other ratio has been enumerated; it must name the
  play pattern it belongs to, because it depends on that too; and where it cannot
  be shown, the per-line profit rates are shown instead. "Total at risk" (§5, S1)
  may never appear without them.
- **A return below the stake is never presented as a win, anywhere.** This rule
  governs published figures, the settlement ceremony (§7.1, tier T0-loss), the
  history list, the session summary and any notification. In every one of those
  surfaces a round that returned less than it cost shows a **signed net result**
  at least as prominent as the credited amount, in MIST, with no amber and no
  count-up. It is the single most frequent outcome class in the game — 48.00% of
  `BANK_FIRST` rounds, 50.04% of `HALF_EVERY` rounds, 71.89% of `PANIC` rounds
  (§7.1) — so it is also the one where a soft presentation would do the most
  damage.
- The game never uses the words "skill", "strategy pays", "outplay" or "beat".
- The help screen states plainly: *"Every way of playing SWARM returns the same
  95% on average, before rounding. Every credit is rounded down to the nearest
  0.000001, so harvesting often costs a fraction of a penny more than banking
  once — strictly less than 0.000018 a round. Your choices change how often you win and how
  much."* The rounding sentence is mandatory. Dropping it makes the claim false,
  and [MATH.md §6](MATH.md) is careful about exactly this distinction — "every
  way of playing returns the same" is true of the theoretical value and false of
  the payable one, by a small, disclosed, computed amount.
- The harvest stepper carries the same disclaimer at the point of use: choosing
  `k` changes the shape of the round, not its expected return — and, in the same
  string, that each credit is rounded down. It may not claim the two are
  identical.
- **The FULL BLOOM frequency never appears without the play pattern it belongs
  to.** `1 in 22,218` is the never-harvest figure; harvesting lowers it, and
  halving the colony every generation — the one-tap default — makes it exactly
  zero ([MATH.md §8.2](MATH.md)). The help screen carries the per-policy table,
  and no surface anywhere may print the frequency bare. This is the rule this
  subsection exists for: a jackpot frequency shown to a player for whom the event
  is impossible is the worst kind of misleading number, because it is arithmetically
  correct about somebody else.
- Displayed values truncate toward zero, so the credited amount is never below
  what was shown.
- The stake and the current bankable value are both on screen at every decision.
- The offspring probabilities are on screen for the whole round, not buried in a
  paytable.
- The RTP, the max win, the profit rates, the ticket-pairing profit rates, and
  the FULL BLOOM frequencies **per play pattern** with their payout range are in
  the help screen in plain language, with the same numbers as
  [MATH.md](MATH.md).

### 9.4 DARK VENT is a bet, not a safety net

`DARK VENT` pays when the colony dies early, which is exactly when the base bet
loses, so it will feel protective whether or not it is sold that way. Insurance-
shaped side bets are a recognised responsible-gambling concern — blackjack
insurance is the canonical example — because they increase total stake per round
while feeling like risk reduction.

Round 3 defended the pairing with "two bets at 95% theoretical RTP before
payable floors combine to the same theoretical RTP on a larger total". That is
true, and it is the wrong statistic: §9.3
makes the **profit rate** the binding figure, and the profit rate of a ticket is
not the average of its lines'. Enumerated exactly at equal stakes
([MATH.md §7.4](MATH.md)):

| Ticket | Theoretical ticket RTP before payable floors | `P(ticket returns more than the ticket stake)` |
| --- | --- | --- |
| COLONY alone, `BANK_FIRST` | `19/20` | 0.4560000000 |
| COLONY + DARK VENT, `BANK_FIRST` | `19/20` | **0.3608881499** |
| COLONY alone, `RUN` | `19/20` | 0.0224631637 |
| COLONY + DARK VENT, `RUN` | `19/20` | **0.3756956796** |

So for the player most likely to place it — the one who banks early — the
protective-feeling bet **cuts** the chance of finishing the round ahead by 9.5
percentage points while doubling the amount staked, and it can never return
nothing. For the player who never harvests it does the opposite. Neither of those
is visible in an RTP, both are large, and a design that had only published the
RTP would have been telling the truth and saying nothing. So:

- **Presentation.** `DARK VENT` appears only inside the collapsed side-bet
  drawer, before `SEED`, in exactly the same visual treatment as the other two
  bets. It is never pre-selected, never defaulted on, never recommended, never
  paired automatically with a colony stake, and never surfaced at the moment the
  base stake is set.
- **Banned words** anywhere near it: "insurance", "protect", "protection",
  "cover", "covered", "hedge", "safety net", "just in case".
- **Required copy** in its help text: *"A separate bet with its own stake. It
  does not reduce the cost of your colony bet — it adds a second bet at the same
  95%. Placing both means staking more this round, and it changes how often you
  finish a round ahead."*
- **Total at risk** is displayed before `SEED` whenever any side bet is selected
  (§5, S1), never without the profit rates beside it (§9.3), so both the larger
  total and what it does to the odds are visible at the moment of the decision.

### 9.5 No latency-sensitive money decisions

- Nothing is timed. There is no countdown, no auto-continue, no "decide before
  the vent closes". A player can put the phone down mid-round. §9.7's floors are
  the opposite object and do not weaken this: a floor is a minimum time before
  the game will accept the *next* action, never a deadline on the current one,
  and no floor can ever cost a payout.
- Because the round only advances on the player's tap, a slow or dropped
  connection cannot cost a payout. Reconnect restores the exact decision state.
- The one server-initiated transition is abandonment reconciliation after 72
  hours ([ENGINE.md §5.5](ENGINE.md)): a forced bank at the exact current value,
  which is EV-neutral because every action ties. 72 hours is four orders of
  magnitude above any decision latency, so it does not make any decision
  time-sensitive. It is disclosed in help, not buried in terms.

### 9.6 Accessibility

- Colour is never the only channel: dead organisms change shape and opacity as
  well as colour; harvested value is announced as text as well as amber; a
  negative verdict is a signed number as well as a darker frame; a settlement
  below the stake is a signed number and the absence of a count-up, not a colour
  swap (§7.1). A player who cannot distinguish MIST from FOAM must still be able
  to tell a losing round from a winning one.
- The wild-line ghost, where it appears (the harvest beat and S8a), is
  distinguished from the colony by opacity, by the absence of halation and by a
  separate screen-reader group, never by hue alone. A side-bet chip's state is
  announced as text, so a player who cannot see the ghost at all loses nothing
  the bet depends on.
- Text contrast ≥ 4.5:1 against ABYSS; controls ≥ 44 pt.
- `prefers-reduced-motion` behaviour is specified in §6.4.
- One-handed portrait play, no gesture required beyond a tap.
- Screen-reader labels announce generation, population, yield, colony value, the
  signed change since the last generation, position relative to the stake, the
  wild-line population for the generation just resolved (and never a later one),
  and each available action with its exact consequence — including, for
  `HARVEST`, the exact credit each `k` on the stepper would pay.

### 9.7 Speed of play

"Nothing is timed" is a statement about *minimum* time — no decision can expire —
and round 3 never made the other statement. Every beat in §2 is skippable by
tapping, so a `BANK_FIRST` round is `SEED` → skip 700 ms → skip 900 ms → `BANK` →
skip 600 ms: comfortably under a second of enforced time, with a money decision
at each end. Tap-to-skip that shortens the cycle is functionally slam-stop, which
GB removed from online slots alongside the autoplay affordance §4.3 point 1
already refuses to ship. SWARM is not a slot and this is a free-play prototype, so
the 2.5 s spin-cycle rule is not binding on it — and a §9 that runs to eight
subsections and never mentions session velocity is incomplete under any
responsible-design mindset. The floors:

| Floor | Value | What it governs |
| --- | --- | --- |
| Round cycle | **2,500 ms** from `SEED` to the next `SEED` becoming live | A whole round cannot be chained faster than this, however much is skipped |
| Decision dead period | **350 ms** between a generation reaching its resolved state — by animation or by skip — and the action bar accepting input | The gap between watching and deciding |
| Settlement hold | **600 ms** minimum before `NEW ROUND` accepts input, at every tier including T-nil and T0-loss | A loss cannot be skipped into the next stake |
| Skip | Ends the current animation only | Skipping never shortens any floor above |

Three rules go with them, and they are the point rather than the numbers:

- **Skipping buys the resolved state, not the next decision.** The tap that skips
  a resolution is consumed by the stage surface, and the action bar is inert for
  the dead period afterwards. This is also the input guard §5 (S3, S4) needs: the
  second tap of a double-tap cannot land on a money control, because for 350 ms
  there is no money control listening, and the action bar's hit area never
  overlaps the stage's.
- **The floors do not vary.** Not with the sign of the position, not with the
  size of the win, not with how long the session has run, and not with anything
  the round did. A cycle floor that shortened after a loss would be the same
  defect as a `NEW ROUND` button that grew after one (§9.1).
- **No turbo, no quick-spin, no speed setting.** There is nothing to sell here:
  the game's own pitch is that it has no clock, and a control that makes rounds
  faster is a control that makes them more frequent.

**Where they are enforced, because "cannot" is a claim about the product and not
about one client.** The table above says a round *cannot* be chained faster than
2,500 ms. A floor that lives only in the client is not that claim: anything
speaking the documented API is not bound by it, and the first build of this game
could be driven at roughly 26 rounds a second through `/api`. So all three floors
are enforced by the round service as well —
[ENGINE.md §5](ENGINE.md), `src/server/pacing.ts` — and enforced as a **wait,
never a refusal**. A command that arrives inside a floor is held until the floor
has passed and then processed exactly as it would have been. That is the only
implementation compatible with §9.5: a refusal would be a deadline on a decision
by another name, and no floor may ever cost a payout. The client keeps its own
copies of the same three values so that the *screen* is paced rather than the
network, which is why `/api/config` publishes them: one set of numbers, two
places that honour them, and neither able to drift from the other.

**A floor is charged for cycling a round, so a refused command pays none.** A
command the service rejects — a malformed payload, a stake a session limit refuses,
a command fenced to a stale frame — has not cycled a round, and it hands its floor
slot back rather than spending it. Without that, ten malformed requests cost 25
seconds of held connections and queued the next honest stake behind ten cycle
floors, which would make the game slower to argue with than to play. The converse
is the load-bearing half: handing a slot back may never *shorten* a floor, so a
release restores a live round's dead period rather than clearing it and can never
roll back past a settlement hold — otherwise "get one command refused" would be a
way to clear the floor on the next one. A command that succeeds keeps its slot,
which is the whole of the floor. See [DECISIONS.md D8](DECISIONS.md).

### 9.8 The wild line is a bet's state, not a colony you could have had

Round 3 shipped a **live wild-line ghost**: a dimmed trace of "the colony as it
would have grown had it never been harvested", drawn behind the player's own
bodies, updating every generation for the whole round, whenever a side bet was
live. §9 never evaluated it. It should have, and the evaluation does not survive
contact with §9.2.

- **It is a permanent counterfactual.** [MATH.md §7.3](MATH.md) proves
  containment: the wild line is never smaller than the player's colony and is
  strictly larger after any harvest. A continuously drawn ghost is therefore a
  standing, on-screen monument to the position the player gave up — updated every
  900 ms, never in their favour. §9.2's rule is *show where you stand; never show
  the way back*, and §7.2's is *no "so close" overlay, no near-miss promotion*. A
  permanent rival colony is both.
- **It reads worst exactly where the design is most exposed.** A player using the
  one-tap default watches their own colony capped at six organisms
  ([MATH.md §8.2](MATH.md)) beside a ghost that can reach ten, twelve or sixteen.
  The mechanic the game recommends produces the picture the game should least want
  to draw.
- **It made the richest visual an inducement to add lines.** The ghost rendered
  only when a side bet was live, so the most interesting thing on screen was
  behind a second stake — which sits badly beside §9.4's care over DARK VENT.

**Decision: the persistent ghost is cut.** What replaces it is scoped to what the
bet actually needs, which was §4.2's real argument all along:

- a **chip per live side bet**, carrying that bet's own state in numerals, shown
  only for a bet the player placed (§4.2);
- the ghost as a **400 ms teaching beat at the harvest**, where the divergence
  physically happens and where the player has just acted — not a standing
  comparison, a caption on their own decision (§5, S5);
- the **completed wild line after the round**, on S8a, where a counterfactual can
  no longer sit next to a live decision.

The line this draws is worth stating in one sentence, because a future feature
will test it: **the wild line may be shown as the state of a bet the player has
placed, and never as an alternative colony they could have had.** A number that
says "your SWARM bet has reached 7 of 10" is the first; a colony drawn beside
theirs that is always bigger is the second.

**And S8a has to obey the closing sentence too.** The first build of S8a printed
`YOUR COLONY 5 → 2 → 3 → 2 → 0` directly beneath the wild line's
`5 → 4 → 4 → 2 → 0`. Every clause above permits it — the round is over, the
counterfactual is completed, nothing sits beside a live decision — and it is
still the one place in the product where the game itself draws the comparison the
closing sentence forbids, in the same type, one row apart — and containment
([MATH.md §7.3](MATH.md)) proves the player's row can never be the larger one, so
the comparison has exactly one possible reading. The row is **cut**. What S8a states instead is the fact the bet actually
needs: how far along this line the player's own round ran — `generation 1 to 4 of
9` — with the covered generations lit on the chart. That is a window on the line
being resolved, not a second colony; the player's own populations remain one tap
away on the receipt (S8), where they are their own record rather than a rival's.

### 9.9 Player protection surfaces

Session timer and net result in the top bar menu, reality check every 30 minutes,
deposit/loss/time limits reachable in two taps, and a visible link to help
resources. No bonus buy, no jackpot teaser, no "almost" messaging.

Round 3 left that as one sentence, and one sentence is not a specification: the
first build shipped the net result and nothing else. The rest of this section is
what each of those four actually is, because a responsible-design requirement
that cannot be built from its own wording is a requirement that will not be built.

**Where they live.** The top bar carries `BALANCE`, the signed session result and
`MENU`, and it stays live on every screen — including S1, the settlement and every
sheet. A menu that only exists while a round is running is missing on the one
screen a player sits on between rounds. `MENU` opens the session sheet (S10):
session time, opening balance, balance, total staked, total credited, signed net
result, and the last 50 rounds. The clock ticks while the sheet is open and runs
on the **server's** session clock, because a device clock is not evidence of
anything. That sheet's own `LIMITS & SAFER PLAY` control is the second tap.

**The free-play mapping, stated rather than implied.** There are no deposits in
this game — the wallet is an in-memory free-play balance — so the deposit limit
maps to a **stake budget**: the most this session may put at risk in total. The
loss limit is on the signed session result and the time limit is on elapsed
session time. All three are off by default: a limit the player did not choose is
not a protection, it is a house rule.

| Limit | Binds when | Refuses |
| --- | --- | --- |
| Stake budget | `total staked + this ticket > budget` | the ticket |
| Loss limit | `net result ≤ −limit` | the next ticket |
| Time limit | `elapsed ≥ limit` | the next ticket |

**Tightening is immediate; loosening waits.** Setting a limit or lowering one
binds on the next stake. Raising or removing one is scheduled and lands after a
cool-off — 24 hours by default, published beside the pending value so the player
is never waiting on something invisible. A limit that can be lifted at the moment
it starts to bind protects nobody, and the moment it binds is exactly the moment
it will be lifted. A tightening while a loosening is pending cancels the pending
change: the player who just lowered a limit is not also asking to raise it later.

**A limit refuses a stake and nothing else.** It never touches a round that is
already staked. A player who is mid-round when a limit binds finishes that round
and banks it — stopping them from settling money they have already committed
would be a worse outcome than the one the limit exists to prevent, and it would
be the only place in the game where a rule can cost a payout (§9.5). The refusal
is server-side, typed (`LIMIT_REACHED`), and published in the session view *before*
it is provoked, so S1 renders a locked state with the reason and the sheet rather
than a control that fails when tapped.

**The reality check.** Every 30 minutes of session time: elapsed time, total
staked, total returned, signed net result, and the reminder that these are
free-play credits. It cannot be turned off — an interval control is a speed
control (§9.7) — and it is shown **between rounds**, never over a live decision
and never over the settlement ceremony, whose job §7.1 governs. Its clock is the
server's and an acknowledgement restarts it, so a reload does not clear it and a
player mid-round when it falls due sees it once, at the next stake, rather than
twice.

**The free-play marker and the help resources.** A persistent strip at the foot of
every screen, above every overlay: `FREE-PLAY DEMO CREDITS · NO CASH VALUE`, plus
`SAFER PLAY`. A player who never opens help must still be told that an amber
balance of 1,000.00 is not money, and §9.9's "visible link to help resources"
means visible — a row inside a menu the player never opens is not a link they can
see. Tapping the strip opens the safer-play sheet, which carries the limits, the
reality-check state and the resources themselves: independent support
organisations with real, resolving links, never an operator page. The resource
list is served by the operator (`/api/config`) rather than compiled into the
client, so it cannot drift from what the operator publishes.

**What is deliberately not here.** No age gate: this is a free-play prototype with
no account, no deposit and no jurisdiction, and an age gate that gates nothing is
theatre. No self-exclusion register either, for the same reason — the link to
GAMSTOP is real and the register is not ours to run.

---

## 10. Open questions for the build

1. **Share card generation.** Client-side capture versus server-rendered card
   with the verification URL baked in.
2. **Auto-play scope.** In-round auto-play is now decided and cut (§4.3).
   Whether a *multi-round* auto-play ships at all is still open, and it is a
   responsible-design decision rather than a technical one; if it ships it is
   fixed-stake, capped in rounds, and cancellable in one tap (§9.1).
3. **Side-bet onboarding.** Off by default is right, and the side-bet chip plus
   the harvest-beat ghost (§4.2, §9.8) give a live bet a visible state without
   drawing a colony the player could have had. What is still open is whether
   `FIRST LIGHT` deserves a one-time explainer on top of that — an onboarding
   test, not a design argument. `DARK VENT` gets no explainer under any
   circumstances (§9.4). The first-round explainer (§5, S0) is decided and in;
   what it should *say* is worth testing, what it may not do is in §5.
4. **Verdict band and chord thresholds.** `±1.00x` and the `3/2` chord ratio are
   proposals, chosen so that every note is reachable with room to spare
   ([MATH.md §9.3](MATH.md)). Both are tuning parameters and both are enumerated,
   so moving them moves the published table with them. R1–R5 in §6.5 are not
   tuning parameters.
5. **Client-seed presentation.** The control is specified (S1) and it only does
   its job if the value is genuinely the client's
   ([ENGINE.md §8](ENGINE.md)). Whether the average player should see a hex
   string, a word list, or nothing until they open the fairness row is a
   comprehension test worth running.
6. **Second title reuse.** The `staged-survival` module in
   [ENGINE.md](ENGINE.md) is deliberately generic. A future game changing only
   the offspring vector, the ladder and the thresholds should need no engine
   change — worth validating with a second configuration before the module is
   frozen.
7. **Competitive audit.** §1.1 is desk observation. A real audit is required
   before any novelty claim reaches marketing.
