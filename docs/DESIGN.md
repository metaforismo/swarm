# SWARM — product design specification

Deep-sea colony game for Axiom Games, built on Reveal Engine™.
Portrait, one-handed, no timers, 95% RTP on every line.

This document is the build brief: loop, decisions, bets, screen-by-screen UX,
art direction, sound direction, and the rules the game may not break. Numbers
quoted here are the exact ones from [MATH.md](MATH.md); the enumeration in
`tools/enumerate.mjs` is authoritative, the tables between
`<!-- generated:... -->` markers are written by `npm run docs:sync`, and the test
suite fails if this document disagrees with the model.

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
   return is exactly 95% either way, and we publish the exhaustive proof. The
   game never pretends a decision is worth more than it is.

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

**Round length.** 5.85 generations on average under the never-bank policy;
6.4% of rounds die in generation 1; 35% are extinct by generation 3; 2.2%
survive all 18 generations.

---

## 3. Every decision, its timing, and what it actually changes

The design rule is **zero fake agency**: every control either changes the
distribution of outcomes in a way we can state exactly, or it does not exist.

| Decision | When it is offered | What it changes | What it does not change |
| --- | --- | --- | --- |
| Stake | Before generation 1 | Scales every COLONY payout linearly | RTP (95%), the draws |
| Side bets | Before generation 1 **only** | Adds independent lines, each with its own stake and its own 95%, resolved at settlement on the unharvested "wild line" | The colony, the base bet, the draws |
| **Client seed** | Before generation 1 **only**, after the server has published its commitment | Changes the whole 270-draw grid. It is the player's half of the fairness handshake: the server sealed its seed first, so it cannot pick a grid to suit the entropy you choose ([ENGINE.md §4.5](ENGINE.md)) | The distribution of anything. Every client seed gives the same 95% and the same odds |
| `SEED` | Before generation 1 | Sends the client seed and starts the round | Nothing about the outcome — the grid is fixed the moment both halves exist |
| `CONTINUE` | After every resolved generation (`t < 18`) | Colony consumes `n` more draws; value moves up the ladder or to zero | Expected return |
| `HARVEST k` | Same, when `n >= 2` | Credits any `k` from 1 to `n - 1` organisms **now** at the current yield; the rest keep climbing. Because a smaller colony consumes fewer draws, this genuinely changes which draws you meet next generation | Expected return |
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
ticket carries its own stake, its own cap and its own 95%.** No bet's payout is
charged against another bet's ceiling, so the size of one bet never changes what
another one pays ([MATH.md §12](MATH.md)).

### 4.1 COLONY — the base bet

The game itself. Stake range 0.10 to 1,000.00 credits, in integer minor units
(`1 credit = 10^6 units`). RTP exactly 95% under any play pattern. Maximum
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
95% RTP as the base game. Each has its **own stake**, 0.10 to 100.00 credits,
independent of the colony stake; the ticket's total stake is shown before `SEED`
so the real amount at risk is never hidden behind three toggles.

**When they resolve, and what the player sees while the round runs.** Side bets
are *credited* only at settlement, after the base round is over. But a bet that
pays `248.798x` and gives the player no signal of any kind for an entire round is
a bet nobody will place twice, and round 2's blanket ban on wild-line information
was one generation stricter than the mathematics requires. The exact boundary
([MATH.md §7.3](MATH.md)) is:

> The client may show the wild line for the generation the player has just
> resolved and every earlier one. It may never show, or hint at through timing,
> the wild line for a generation the player has not resolved.

So the round ships a **wild-line ghost**: a dimmed, desaturated PLANKTON trace of
the counterfactual colony drawn behind the player's own bodies, one ghost per
wild organism, updating on the same 900 ms beat and never ahead of it. Above it,
one chip per live side bet:

| Bet | In-round state | When the chip settles |
| --- | --- | --- |
| **FIRST LIGHT** | `WON` / `LOST` the instant generation 1 resolves — it is a function of the wild line at generation 1 and nothing else | generation 1 |
| **DARK VENT** | `LIVE` until the wild line is extinct or generation 3 passes, then `WON` / `LOST` | generation 3 |
| **SWARM** | `LIVE`, with the wild line's peak so far against the target: `PEAK 7 / 10`. Flips to `WON` the moment the peak reaches 10 and never flips back | when it wins, or at settlement |

`SWARM` is the one that needs care and the one where the care is cheap. Its
predicate is on the **peak**, which is monotone, so "it has already won" is a
statement about generations the player has resolved and is free to show. "It can
no longer win" is *not* knowable early and the client must never imply it — no
greying out, no struck-through chip, no "needs 3 more" copy. The chip reads
`LIVE` until it reads `WON`, or until settlement says `LOST`.

**Why the ghost is a design requirement and not a nicety.** Side bets resolve on
a colony that visibly diverges from the one the player is watching the moment
they harvest. Without the ghost, a player at 9 organisms who harvests four and
then loses SWARM will reasonably believe they killed their own bet. The ghost
makes the divergence the first thing they see: the moment you harvest, your
bodies drop and the ghosts do not. Copy on the first harvest of a round with a
live side bet, once per session: *"Side bets follow the colony that never gets
harvested. Harvesting cannot lose you one."*

**DARK VENT is not insurance and may not be dressed as insurance.** See §9.4.

### 4.3 The harvest control (not a bet, and not a plan)

`HARVEST` is a single control with two depths:

- **Tap** harvests `floor(n / 2)` — the one-thumb default, and the only thing
  most players will ever use.
- **Press and drag** on the same control opens a stepper from `1` to `n - 1`,
  with the exact credit printed live: `HARVEST 1 → 0.62`. Release commits.

The stepper exists because the protocol accepts every `k` and the published
volatility range depends on it. [MATH.md §11](MATH.md) advertises a
player-selectable standard-deviation interval whose **maximum** is attained by
harvesting exactly one organism at a population of 15; shipping only
`floor(n / 2)` would publish a range no player could reach. Either the number
comes off the marketing sheet or the button goes in the client, and the button is
cheaper and more honest.

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
└──────────────────────────────┘  ladder chip + generation dots
```

**S1 — Stake & seed.** Vent idle in darkness, stake stepper centred, side-bet
row collapsed by default behind a single `+ SIDE BETS` control. Opening it shows
three independent stake steppers and a running **total at risk**.

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
state. If any side bet is live, the **wild-line ghost** (§4.2) resolves on the
same beat, one frame behind nothing — it shows the generation that just
resolved and never the next one.

**S4 — Decision.** The three controls appear. `BANK` is always the visually
primary action (filled, LUMEN). `HARVEST` is secondary (outlined) and shows
exactly what a tap will pay: `HARVEST 2 → 1.23`; pressing and dragging it opens
the `1 … n-1` stepper (§4.3) with the credit updating live. `NEXT` is tertiary
(ghost). No timer, no countdown ring, no pulsing "hurry" animation. The panel
states the next generation's yield so the trade-off is explicit: *"Next
generation: 0.77x per organism."*

**The panel is identical whether the player is above or below their stake.**
Same layout, same hierarchy, same copy, same colours — only the numbers differ.
§9.2 is the full rule and it is the single most important constraint on this
screen.

**S5 — Harvest.** Inline, no modal. The harvested bodies brighten, detach,
spiral into the balance chip as amber particles; the remaining organisms close
ranks; the balance chip counts up. The wild-line ghosts **do not move** — this is
the frame that teaches the player what a side bet resolves on. 600 ms, skippable.

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

**S8a — Wild line, completed.** The ghost the player has been watching runs on
from where their own round stopped, to its own terminal, from the revealed seed.
If they banked at generation 2, generations 3 onward appear here for the first
time — the ghost stopped when their round stopped, exactly as §4.2 requires. Each
side bet resolves against the completed line. This screen appears only if at
least one side bet was placed.

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
the same frame revision. Nothing resolves while you are away — the round only
advances on your tap. A round abandoned for 72 hours is reconciled by a forced
bank at its exact current value and appears in history with the reason
`RECONCILED` ([ENGINE.md §5.4](ENGINE.md)); the help screen states this plainly
rather than burying it in terms.

---

## 6. Art direction

**Concept.** Absolute abyssal black. One warm ember from the vent below. The
only other light in the universe is your colony. The light budget of the scene
*is* the money — and §6.3 defines that as an exact, monotone function of colony
value so the claim survives contact with a renderer.

### 6.1 Palette

| Role | Name | Hex | Usage |
| --- | --- | --- | --- |
| Background void | ABYSS | `#02040A` | 55% of frame |
| Mid water | TRENCH | `#061019` | gradient fill, vignette |
| Floor / panels | SILT | `#0A1B28` | UI panel base |
| Rock | BASALT | `#123240` | vent chimney body |
| Lit rock edge | CRUST | `#1E4A56` | rim of the chimney |
| **Organism core** | **LUMEN** | **`#39F5C8`** | primary brand colour, organism glow, primary CTA |
| Organism specular | LUMEN HIGH | `#7CFFE3` | hottest 10% of each body |
| Organism shadow rim | LUMEN DEEP | `#0FB894` | body edge away from core |
| Ambient life | PLANKTON | `#5B8CFF` | drifting particles, secondary UI strokes |
| Large-gain tint | MEDUSA | `#B06CFF` | verdict beats worth at least a whole stake, and only those |
| Banked value | AMBER | `#FFC978` | harvest particles, balance chip, credited amounts |
| Vent thermal | EMBER | `#FF9E6B` | vent glow only, ≤5% of frame, never used for loss |
| Extinguished | ASH | `#8A97A6` | dead organisms, disabled controls |
| Primary text | FOAM | `#E6F4F1` | numbers, labels |
| Secondary text | MIST | `#9FB6BD` | captions, legends, signed negative deltas |

Rules: **red is not in the palette.** Loss is communicated by darkness, by the
removal of light, and by a signed number — never by an alarm colour. AMBER means
"yours, banked, safe" and appears nowhere else. MEDUSA appears only on a verdict
beat worth at least one whole stake, so violet on screen always means the
position just grew by more than the player paid to enter — a promise neither the
old "violet on every split" rule nor the ratio bands that replaced it could keep
(§6.5).

### 6.2 Materials

- **Organism.** A translucent gel bell, 40–70 px on a 390 pt screen at small
  colony sizes, with a brighter nucleus at ~25% of body radius. Subsurface
  scattering: the body transmits LUMEN outward with a soft quadratic falloff;
  membrane is a 1.5 px Fresnel rim in LUMEN HIGH. Slight background refraction
  (2–3 px displacement) so the water behind it warps. Never a flat sprite; never
  outlined.
- **Silhouette variation.** Three bell archetypes — `DOME` (wide, shallow),
  `BELL` (tall, pinched), `LOBE` (asymmetric, two-lobed) — assigned by
  `slotIndex mod 3`, with a per-body Perlin phase offset. Fifteen identical bells
  read as a texture; three archetypes read as a colony. **The archetype is
  derived from the slot index and from nothing else** — never from a draw, an
  outcome, or a future state — so the art cannot leak information. This is a
  hard rule, not a preference.
- **Water.** Volumetric fog with depth-based desaturation and a fine grain
  (2% monochrome noise, animated at 12 fps). Halation around every light source:
  a wide, low-opacity bloom (32 px radius, 12% opacity) plus a tight core bloom
  (6 px, 45%), both scaling with per-body intensity so a single late organism
  reads as a small sun. This is the single most important material effect —
  without halation the organisms look like stickers.
- **Rock.** Matte basalt, high roughness, no colour, visible only where the
  colony's light reaches it. The vent mouth has an EMBER gradient that never
  moves.
- **UI panels.** "Pressure glass": 8% FOAM fill, 24 px background blur, 1 px
  inner stroke at 20% LUMEN, 2 px outer shadow at 60% ABYSS. Corner radius 16.

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
- There is no fill light and no sun. Nothing is lit that the colony does not
  light. The one thing on screen that emits without being money is the wild-line
  ghost (§4.2, §6.4): it is an unlit overlay at fixed opacity, contributes no
  radiance to `V`, and therefore cannot make a poorer frame brighter than a
  richer one. That exemption is stated here rather than left to the renderer to
  discover, because pillar 1 is a promise about `E(V)` and an emitter outside the
  formula would quietly break it.

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
| HARVEST | Half the bodies brighten to AMBER, detach, spiral to the balance chip, dissolve; survivors close ranks | 600 ms | `cubic-bezier(0.2, 0.0, 0.0, 1)` |
| Settlement ceremony | See §7 | 600–2,400 ms | per tier |

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
30 ([MATH.md §1](MATH.md)) every body is 12 pt and up to 30% overlap with
additive blending is allowed: the colony deliberately reads as a *mass* rather
than a countable set, which is correct, because 16+ is a terminal state that
exists on screen for about 2.4 seconds and the exact count is always printed as a
numeral anyway. There is no layout mode beyond this one and no dynamic re-packing
to design later.

**Wild-line ghosts** (§4.2) use the same spiral with the same `R(n)` for the
wild population, drawn at 22% opacity in PLANKTON with no halation, no specular
and no point light — they contribute nothing to the exposure, because they are
not money.

**Budget.** Target 60 fps on iPhone 12 / Snapdragon 7-series and above: ≤ 30 draw
calls, one full-screen blur pass, ≤ 3 render targets, ≤ 2.5 ms GPU frame at
390 × 844 @ 3x. Low tier (30 fps floor): the volumetric pass is replaced by a
baked depth gradient, halation drops to the tight core bloom only, and grain is
static. Nothing in the low tier changes what is *shown* — only how it is lit.

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

- **Numerals**: a technical grotesque with **tabular lining figures** and a
  monospaced numeric set — Space Grotesk, Basis Grotesque Mono or Suisse Intl
  Mono are all correct choices. Tabular figures are non-negotiable: the
  multiplier counts up and down and must not jitter.
- **UI text**: a humanist sans with a high x-height at small sizes (Inter,
  Söhne).
- **Scale** (390 pt baseline): colony value 56/60 pt, yield line 28/32 pt,
  labels 13 pt uppercase with +8% tracking, body 15/20 pt, legal 11 pt.
- **Rules**: money always shows two decimals; multipliers always show two
  decimals; nothing is ever rounded up in display; a negative delta always shows
  its sign.

### 6.7 Three visual references (described, not reproduced)

1. **ROV floodlight on a deep-sea siphonophore against absolute black.** A chain
   of translucent bells, each with an internal glowing node, drifting with no
   visible background. Take from it: gel translucency, how internal light reads
   through a membrane, and the total absence of environmental context.
2. **Long-exposure photograph of bioluminescent plankton in a breaking wave at
   night.** A cyan smear against near-black water, heavy grain, strong halation
   around the brightest points. Take from it: colour temperature, grain, bloom
   behaviour — not composition.
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
| Frequency | 1 in 22217.97 |
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
| **T0-win** | `1 ≤ X < 2` | Value settles, balance chip counts up in AMBER, signed net result shown in FOAM. 600 ms. No swell, no card |
| T1 | `2 ≤ X < 10` | 800 ms count-up, single soft swell, share card available but not offered |
| T2 | `10 ≤ X < 50` | 250 ms of silence, frame lifts one exposure stop, 1,000 ms count-up, share card offered |
| T3 | `X ≥ 50` | The full treatment: 250 ms silence, frame to full illumination, 1,200 ms count-up, freeze-frame share card. 2,400 ms |

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

### 7.2 FULL BLOOM: the environment reveal, specified

This is the clip the marketing case rests on, so it gets numbers like everything
else in §6. It is unique and stays unique, independent of tier, and it happens
whether the bloom pays 9.89x or 527.35x. What scales with the money is the
ceremony *around* it (§7.1): the silence, the count-up length, and whether a
share card is pushed.

**What actually happens, and why.** It is a physical consequence of §6.3, not a
bespoke effect. Sixteen bodies at generation `t` put `16 * R_ref * c(t)/c(1)`
into the scene; at the smallest possible bloom (generation 3) that is
`E(9.895833x) = 0.406` against the `E(1.00x) = 0.146` of a break-even frame, and
at the largest it is `E(527.355936x) = 1.000`, the top of the curve. Somewhere
around `E ≈ 0.4` is the first time in a round the exposure is high enough for
anything that is not an organism to sit above the black floor. Nothing is
switched on. The environment was always there and was always unlit.

**The reveal, beat by beat** (the whole thing is 1,000 ms and runs *before* the
tier's count-up):

| Beat | ms | What moves |
| --- | --- | --- |
| Threshold | 0 | The sixteenth body finishes its split. Audio drops to the bed alone |
| Bloom rise | 0–420 | Exposure ramps from its pre-bloom value to `E(V)` on `cubic-bezier(0.2, 0.0, 0.0, 1)`. Halation radius scales 32 → 96 px, opacity 12% → 26% |
| Environment | 180–700 | Silt, rock and plankton fade up from 0% to full lit value, staggered by depth: near silt at 180 ms, chimney wall at 300 ms, far rock at 520 ms, drifting plankton last at 700 ms |
| Settle | 700–1,000 | Exposure eases to steady state; the colony's drift resumes at half amplitude |

**Camera and composition.** The camera does not cut, does not shake and does not
zoom. It dollies back **8%** over the full 1,000 ms on the same easing as the
exposure ramp, and that is the only camera move in the game. The colony stays on
the vent-plume centroid at 38% screen height; the widening `R(n)` (§6.4) plus the
dolly keeps the mass at a constant 62% of frame width, so the clip is
compositionally identical whether it blooms at 16 bodies or 30.

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
still happens, because it carries information about the size of the win. On the
low tier the far-rock cards drop to one, plankton drops to 90 sprites and the
shafts are cut; the silt, the chimney and the exposure ramp stay, because they
are the reveal.

**Why it is clippable.** The illumination is one second, needs no context, and
the payoff is visual rather than numeric: the screen literally fills with light
and a world appears. It reads on a muted phone in a feed. The ceremony that
follows is 600 to 2,400 ms depending on the tier, so a big bloom is a
three-second clip and a small one is a short one — which is correct, because they
are not the same win. A bloom at generation 10 pays at least 47.18x and at
generation 18 at least 281.25x, so at the top of the range the biggest clips and
the biggest wins do coincide; they simply are not the same event.

**The near miss.** Reaching 12 to 15 organisms and never blooming happens once in
1,223 rounds. It needs no special handling — the frame is already almost fully
lit and then goes dark. That is affecting because it is real.

**What we do not do.** No fake bloom animation for non-bloom outcomes. No "so
close" overlay. No tier promotion for a near miss.

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
| HARVEST | Granular amber pour, 400 ms, ending in a soft click | The click is the "banked" confirmation |
| FULL BLOOM reveal | Bed only for 180 ms, then a single sub-bass swell (28 Hz, 900 ms) under a wide reverse-reverb bloom | Carries the environment fade (§7.2). No stinger, no fanfare |
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
  between them is whether the game brought it up.
- **Banned copy**, in the UI and in notifications: "break even", "get back to",
  "back to even", "you need", "only N more", "almost there", "one more
  generation", "don't stop now", "your colony can still".
- **No mid-round bets.** Side bets cannot be added after `SEED` (§3), so no bet
  is ever offered to a player who has just watched a bad generation.
- **Nothing escalates as the round goes on.** No copy, sound or animation
  changes because the player has been in the round longer or is further down.
- **Say it plainly in help**, in this order: *"About half of all rounds are worth
  less than your stake after the first generation. Continuing is not a way back:
  every choice you can make has the same expected return. Bank whenever you
  want."*

### 9.3 No misleading numbers

- **Profit rate leads.** Any published or in-client "how often do I win" figure
  is `P(return > stake)`. The `P(return > 0)` hit rate may appear beside it,
  labelled, never instead of it. Banking at the first decision returns something
  93.60% of the time and returns more than the stake 45.60% of the time; quoting
  only the first number would be presenting a 0.396x return as a win.
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
  95% on average. Your choices change how often you win and how much — never how
  much you get back over time."*
- The harvest stepper carries the same disclaimer at the point of use: choosing
  `k` changes the shape of the round, never its expected return.
- Displayed values truncate toward zero, so the credited amount is never below
  what was shown.
- The stake and the current bankable value are both on screen at every decision.
- The offspring probabilities are on screen for the whole round, not buried in a
  paytable.
- The RTP, the max win, the profit rates and the FULL BLOOM frequency and payout
  *range* are in the help screen in plain language, with the same numbers as
  [MATH.md](MATH.md).

### 9.4 DARK VENT is a bet, not a safety net

`DARK VENT` pays when the colony dies early, which is exactly when the base bet
loses, so it will feel protective whether or not it is sold that way. Insurance-
shaped side bets are a recognised responsible-gambling concern — blackjack
insurance is the canonical example — because they increase total stake per round
while feeling like risk reduction. The arithmetic here is honest (two 95% bets
combine to 95%), but honest arithmetic on a larger total stake is still a larger
total stake. So:

- **Presentation.** `DARK VENT` appears only inside the collapsed side-bet
  drawer, before `SEED`, in exactly the same visual treatment as the other two
  bets. It is never pre-selected, never defaulted on, never recommended, never
  paired automatically with a colony stake, and never surfaced at the moment the
  base stake is set.
- **Banned words** anywhere near it: "insurance", "protect", "protection",
  "cover", "covered", "hedge", "safety net", "just in case".
- **Required copy** in its help text: *"A separate bet with its own stake. It
  does not reduce the cost of your colony bet — it adds a second bet at the same
  95%. Placing both means staking more this round."*
- **Total at risk** is displayed before `SEED` whenever any side bet is selected
  (§5, S1), so the larger total is visible at the moment of the decision.

### 9.5 No latency-sensitive money decisions

- Nothing is timed. There is no countdown, no auto-continue, no "decide before
  the vent closes". A player can put the phone down mid-round.
- Because the round only advances on the player's tap, a slow or dropped
  connection cannot cost a payout. Reconnect restores the exact decision state.
- The one server-initiated transition is abandonment reconciliation after 72
  hours ([ENGINE.md §5.4](ENGINE.md)): a forced bank at the exact current value,
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
- The wild-line ghost is distinguished from the colony by opacity, by the absence
  of halation and by a separate screen-reader group, never by hue alone.
- Text contrast ≥ 4.5:1 against ABYSS; controls ≥ 44 pt.
- `prefers-reduced-motion` behaviour is specified in §6.4.
- One-handed portrait play, no gesture required beyond a tap.
- Screen-reader labels announce generation, population, yield, colony value, the
  signed change since the last generation, position relative to the stake, the
  wild-line population for the generation just resolved (and never a later one),
  and each available action with its exact consequence — including, for
  `HARVEST`, the exact credit each `k` on the stepper would pay.

### 9.7 Player protection surfaces

Session timer and net result in the top bar menu, reality check every 30 minutes,
deposit/loss/time limits reachable in two taps, and a visible link to help
resources. No bonus buy, no jackpot teaser, no "almost" messaging.

---

## 10. Open questions for the build

1. **Share card generation.** Client-side capture versus server-rendered card
   with the verification URL baked in.
2. **Auto-play scope.** In-round auto-play is now decided and cut (§4.3).
   Whether a *multi-round* auto-play ships at all is still open, and it is a
   responsible-design decision rather than a technical one; if it ships it is
   fixed-stake, capped in rounds, and cancellable in one tap (§9.1).
3. **Side-bet onboarding.** Off by default is right, and the wild-line ghost
   (§4.2) now gives a live side bet a visible presence for the whole round, which
   was the real gap. What is still open is whether `FIRST LIGHT` deserves a
   one-time explainer on top of that — an onboarding test, not a design
   argument. `DARK VENT` gets no explainer under any circumstances (§9.4).
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
