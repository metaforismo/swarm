# SWARM — product design specification

Deep-sea colony game for Axiom Games, built on Reveal Engine™.
Portrait, one-handed, no timers, 95% RTP on every line.

This document is the build brief: loop, decisions, bets, screen-by-screen UX,
art direction, sound direction, and the rules the game may not break. Numbers
quoted here are the exact ones from [MATH.md](MATH.md); the enumeration in
`tools/enumerate.mjs` is authoritative and the test suite fails if these two
documents disagree with it.

---

## 1. What the game is

You seed three glowing organisms at a hydrothermal vent in absolute darkness.
Every generation each organism independently **dies**, **holds**, or **splits**.
The colony is your money: it is worth its size times a yield that climbs 25%
every generation it survives. You can bank it at any point, or harvest half of
it and let the rest keep growing. If the colony goes extinct, whatever you had
not harvested is gone.

**The pitch in one line:** a crash game where the multiplier is alive, and you
can cash out half of it.

**Three pillars.**

1. **The colony is the number.** No abstract multiplier ticking in a corner:
   the thing that pays you is the thing you are watching, and it is visibly
   growing or dying. Screen brightness is literally proportional to your money,
   because the organisms are the only light source.
2. **Partial exit.** Every crash game is a binary: you are in or you are out.
   SWARM lets you take half off the table and keep the rest running, which is
   how people actually want to manage a position, and no crash title offers it.
3. **Provable indifference.** Bank instantly or ride eighteen generations, the
   return is exactly 95% either way, and we publish the exhaustive proof. The
   game never pretends a decision is worth more than it is.

---

## 2. The loop, step by step

| Step | What happens | Player input | Duration |
| --- | --- | --- | --- |
| 0 | Round opens; server publishes the commitment hash | — | instant |
| 1 | Stake set, side bets set, optional harvest plan set | taps | untimed |
| 2 | **SEED**: three organisms fade in at the vent | tap `SEED` | 700 ms |
| 3 | **Generation 1 resolves** (mandatory, no decision) | — | 900 ms |
| 4 | **Decision panel**: colony value shown | `BANK` / `HARVEST` / `CONTINUE` | **untimed** |
| 5 | If `CONTINUE` or `HARVEST`: next generation resolves | — | 900 ms |
| 6 | Loop 4–5 until extinct, banked, FULL BLOOM, or generation 18 | | |
| 7 | **Settlement**: credits posted, receipt available, seed revealed | tap to verify | untimed |

A generation resolution is always 900 ms and is skippable by tapping: draw flash
(120 ms) → all organisms resolve simultaneously (400 ms) → value count-up
(380 ms). Organisms never resolve one at a time — a 14-organism generation must
not take 14 seconds.

**Round length.** 5.85 generations on average under the never-bank policy;
6.4% of rounds die in generation 1; 35% are extinct by generation 3; 2.2%
survive all 18 generations.

---

## 3. Every decision, its timing, and what it actually changes

The design rule is **zero fake agency**: every control either changes the
distribution of outcomes in a way we can state exactly, or it does not exist.

| Decision | When it is offered | What it changes | What it does not change |
| --- | --- | --- | --- |
| Stake | Before generation 1 | Scales every payout linearly | RTP (95%), the draws |
| Side bets | Before generation 1 | Adds independent lines resolved on the unharvested "wild line" | The colony, the base bet, the draws |
| `SEED` | Before generation 1 | Starts the round; consumes the committed grid | Nothing about the outcome — the grid is already fixed |
| `CONTINUE` | After every resolved generation (`t < 18`) | Colony consumes `n` more draws; value moves up the ladder or to zero | Expected return |
| `HARVEST` | Same, when `n >= 2` | Credits `floor(n/2)` organisms **now** at the current yield; the rest keep climbing. Because a smaller colony consumes fewer draws, this genuinely changes which draws you meet next generation | Expected return |
| `BANK` | Same | Ends the round at the exact current value | Expected return |
| Harvest plan | Before generation 1, cancellable at any decision point | Pre-commits the same three actions so the player can look away | Expected return |

**Information available at a decision.** The player knows: the generation index,
the current population, every past population, every past action, the exact
yield ladder, and the exact offspring probabilities. The player does **not**
know any unrevealed draw. The seed is published only at settlement. This is the
precise assumption the invariance theorem needs ([MATH.md §6](MATH.md)).

**`HARVEST` is disabled at `n = 1`**, because `floor(1/2) = 0` and a button that
does nothing is a lie. The client greys it out and says why.

**What we deliberately do not build.** No "boost", no "lucky vent", no purchased
re-roll, no cosmetic choice dressed as influence, no near-miss animation that is
not a real near-miss (if the screen shows an organism about to split, it split).
Nothing on screen may imply a decision has an edge, because the enumeration
proves none does.

---

## 4. Bet types

### 4.1 COLONY — the base bet

The game itself. Stake range 0.10 to 1,000.00 credits, in integer minor units
(`1 credit = 10^6 units`). RTP exactly 95% under any play pattern. Maximum round
credit 905.77x; declared cap 906x, proven never to bind.

### 4.2 Side bets (optional, off by default)

All three resolve on the **wild line** — the colony as it would have grown had
it never been harvested. The wild line is a function of the committed grid
alone, so no decision can move a side bet, which is exactly why they can be
priced in advance. When a player never harvests, the wild line *is* their
colony.

| Bet | Wins if | Pays | Frequency |
| --- | --- | --- | --- |
| **FIRST LIGHT** | The wild line holds 4+ organisms after generation 1 | `19/4` = 4.75x | 1 in 5 |
| **DARK VENT** | The wild line is extinct by generation 3 | 2.689x | 1 in 2.83 |
| **SWARM** | The wild line reaches 10+ organisms at any point | 248.798x | 1 in 261.89 |

Each is priced at exactly `(19/20) / probability`, so all three carry the same
95% RTP as the base game. `DARK VENT` is an honest hedge against your own colony
dying: pairing it with the base bet is neither an exploit nor a trap, because
two 95% bets combine to 95%.

### 4.3 Harvest plan (not a bet)

Presets that pre-commit a policy so the player can watch instead of tap:
`BANK AT 2x`, `HARVEST HALF EVERY GENERATION`, `HARVEST HALF AT 2x THEN RUN`,
`RIDE TO 18`. The plan can be cancelled at any decision point. It is a
convenience, and the UI must say so: *"A plan changes how your round feels. It
cannot change your expected return."*

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
│  YIELD 0.62x  ·  COLONY 2.47x│
├──────────────────────────────┤  96 pt   action bar (thumb zone)
│   BANK      HARVEST   NEXT   │
└──────────────────────────────┘  ladder chip + generation dots
```

**S1 — Stake & seed.** Vent idle in darkness, stake stepper centred, side-bet
row collapsed by default behind a single `+ SIDE BETS` control. The commitment
hash is shown small at the bottom with a copy button, before anything is
revealed. Primary CTA: `SEED COLONY`.

**S2 — Seeding.** Three organisms fade up from the vent over 700 ms. The
generation-1 probabilities appear as a permanent legend (`DIE 40% · HOLD 40% ·
SPLIT 20%`) — it is never hidden, at any point in the round.

**S3 — Generation resolve.** Draw flash, simultaneous outcomes, value count-up.
The generation dot row at the bottom advances one dot. Tapping skips to the
resolved state.

**S4 — Decision.** The three buttons appear. `BANK` is always the visually
primary action (filled, LUMEN). `HARVEST` is secondary (outlined) and shows
exactly what it will pay: `HARVEST 2 → 1.23`. `NEXT` is tertiary (ghost). No
timer, no countdown ring, no pulsing "hurry" animation. The panel states the
next generation's yield so the trade-off is explicit: *"Next generation: 0.77x
per organism."*

**S5 — Harvest.** Inline, no modal. Half the colony brightens, detaches, spirals
into the balance chip as amber particles; the remaining organisms close ranks;
the balance chip counts up. 600 ms, skippable.

**S6 — Extinction.** The last organism's core dims and collapses; the screen
falls to the vent ember alone. Copy is flat and non-escalating: *"Colony
extinct. Banked this round: 1.23."* The next control is `NEW ROUND` at normal
prominence — never enlarged, never pre-selected, never accompanied by a stake
increase suggestion.

**S7 — FULL BLOOM.** See §7.

**S8 — Settlement.** Receipt sheet: stake, every harvest with its generation and
yield, terminal reason, total credited, exact multiplier, round ID, revealed
seed, commitment hash, and a `VERIFY` button.

**S9 — Verify.** Shows the revealed seed, the derivation rule, the first draws
of the grid with their generation/slot indices, and a re-derived payout that
must match the receipt. Offline-checkable: the sheet includes the exact command
to reproduce it.

**S10 — History & session.** Last 50 rounds with terminal reason and multiplier;
session elapsed time and net result; limits and reality-check settings one tap
from the menu.

**Reconnect.** Dropping mid-round returns you to the exact decision state with
the same frame revision. Nothing resolves while you are away — the round only
advances on your tap.

---

## 6. Art direction

**Concept.** Absolute abyssal black. One warm ember from the vent below. The
only other light in the universe is your colony. As the colony grows the entire
frame gets brighter; when it dies the screen goes almost completely dark. The
light budget of the scene *is* the money.

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
| Rare event tint | MEDUSA | `#B06CFF` | split flash, bloom edges only |
| Banked value | AMBER | `#FFC978` | harvest particles, balance chip, credited amounts |
| Vent thermal | EMBER | `#FF9E6B` | vent glow only, ≤5% of frame, never used for loss |
| Extinguished | ASH | `#8A97A6` | dead organisms, disabled controls |
| Primary text | FOAM | `#E6F4F1` | numbers, labels |
| Secondary text | MIST | `#9FB6BD` | captions, legends |

Rules: **red is not in the palette.** Loss is communicated by darkness and
absence, never by an alarm colour. AMBER means "yours, banked, safe" and appears
nowhere else. MEDUSA appears only on splits and blooms, so violet on screen
always means something good just happened.

### 6.2 Materials

- **Organism.** A translucent gel bell, 40–70 px on a 390 pt screen, with a
  brighter nucleus at ~25% of body radius. Subsurface scattering: the body
  transmits LUMEN outward with a soft quadratic falloff; membrane is a 1.5 px
  Fresnel rim in LUMEN HIGH. Slight background refraction (2–3 px displacement)
  so the water behind it warps. Never a flat sprite; never outlined.
- **Water.** Volumetric fog with depth-based desaturation and a fine grain
  (2% monochrome noise, animated at 12 fps). Halation around every light source:
  a wide, low-opacity bloom (32 px radius, 12% opacity) plus a tight core bloom
  (6 px, 45%). This is the single most important material effect — without
  halation the organisms look like stickers.
- **Rock.** Matte basalt, high roughness, no colour, visible only where the
  colony's light reaches it. The vent mouth has an EMBER gradient that never
  moves.
- **UI panels.** "Pressure glass": 8% FOAM fill, 24 px background blur, 1 px
  inner stroke at 20% LUMEN, 2 px outer shadow at 60% ABYSS. Corner radius 16.

### 6.3 Lighting

- Every organism is a point light: radius 0.6 × body diameter, quadratic
  falloff, colour LUMEN, intensity scaled so that **total scene illuminance is
  proportional to population**. A 12-organism colony is genuinely four times
  brighter than a 3-organism one.
- The vent contributes a fixed 8% EMBER rim light from below, giving every
  silhouette a warm underline.
- Ambient is 2% PLANKTON. There is no fill light and no sun. Nothing is lit that
  the colony does not light.
- Extinction: over 400 ms the scene loses all colony light, leaving vent ember
  and UI. Do not fade to a bright screen; the dark is the point.

### 6.4 Motion language

Organic, weighted, never mechanical. Everything eases; nothing is linear.

| Event | Motion | Timing |
| --- | --- | --- |
| Idle | Perlin drift 0.2–0.4 pt/s, breath pulse at 0.8 Hz, phase offset per organism | continuous |
| Draw flash | Vent pulses once, all bodies contract 4% | 120 ms |
| **SPLIT** | Body elongates, pinches at the waist, two bodies snap apart with 12% elastic overshoot, MEDUSA bloom flash | 400 ms |
| HOLD | One soft brightness pulse, +15% then back | 250 ms |
| DIE | Core dims, membrane collapses inward, remnant drifts down and out | 400 ms |
| Value count-up | Tabular digits roll; never rounds up, always truncates | 380 ms |
| HARVEST | Half the bodies brighten to AMBER, detach, spiral to the balance chip, dissolve; survivors close ranks | 600 ms |
| FULL BLOOM | See §7 | 2,400 ms |

Splits are always the loudest thing on screen. Deaths are quiet: no shake, no
flash, no red, no sound sting. The asymmetry is deliberate and is a responsible
design choice as much as an aesthetic one.

### 6.5 Type direction

- **Numerals**: a technical grotesque with **tabular lining figures** and a
  monospaced numeric set — Space Grotesk, Basis Grotesque Mono or Suisse Intl
  Mono are all correct choices. Tabular figures are non-negotiable: the
  multiplier counts up and must not jitter.
- **UI text**: a humanist sans with a high x-height at small sizes (Inter,
  Söhne).
- **Scale** (390 pt baseline): colony value 56/60 pt, yield line 28/32 pt,
  labels 13 pt uppercase with +8% tracking, body 15/20 pt, legal 11 pt.
- **Rules**: money always shows two decimals; multipliers always show two
  decimals; nothing is ever rounded up in display.

### 6.6 Three visual references (described, not reproduced)

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

## 7. The viral clip: FULL BLOOM

**The moment.** The colony crosses 16 organisms. It auto-settles at full value,
which at generation 10 is 47.18x and at generation 18 is 281.25x. It happens
once in 22,218 rounds.

**The staging.**

1. The generation that crosses the threshold resolves normally for 400 ms — the
   player watches the count pass 16 with no special treatment yet.
2. **All audio cuts to silence for 250 ms.** Total silence, mid-motion.
3. Every organism blooms to LUMEN HIGH over 300 ms; the frame goes from 20%
   illuminated to fully lit; the water itself becomes visible for the first time
   in the round — silt, rock, drifting plankton, all of it, revealed by the
   colony's own light.
4. A single sustained swell comes in under the value count-up, which runs for
   1,200 ms with tabular digits.
5. Freeze frame with the round's share card: multiplier, generation, colony
   count, round ID, verification link.

**Why it is clippable.** Three seconds, no context needed, and the payoff is
visual rather than numeric: the screen literally fills with light. It reads on a
muted phone in a feed. The near-miss version (12–15 organisms, 1 in 1,159) is
the second most shared moment, and it needs no special handling — the frame is
already almost fully lit and then goes dark.

**What we do not do.** No fake bloom animation for non-bloom outcomes. No
"so close" overlay. The near-miss is affecting because it is real.

---

## 8. Sound direction

Underwater, hydrophone-flavoured, everything slightly low-passed. Dark reverb
with a long tail and no early reflections.

| Layer | Sound | Notes |
| --- | --- | --- |
| Bed | 40 Hz vent rumble + band-limited noise, −32 LUFS, 0.05 Hz filter sweep | Static while a decision panel is open — the audio must never push a decision |
| Organism breath | 220 Hz sine blip, 40 ms attack, panned by screen position | Voice-limited to 6; a big colony reads as a chord, not a crowd |
| SPLIT | Wet glass chime, 880 + 1320 Hz partials, 8 ms attack, 600 ms decay | **Pitches up one semitone per consecutive split in the same generation, to +7** — this is the hook |
| HOLD | 30 ms filtered tick, −24 dB | Barely present |
| DIE | 90 Hz thud with fast low-pass, −18 dB | Felt, not heard. No sting, no descending pitch, no "fail" motif |
| HARVEST | Granular amber pour, 400 ms, ending in a soft click | The click is the "banked" confirmation |
| FULL BLOOM | 250 ms of silence, then full-spectrum swell + sustained pad | The silence does the work |
| UI | Soft membrane taps, no clicks | 8 ms attack |

Mix rules: dialogue-free, mono-compatible, fully playable muted (every audio
event has a visual counterpart). A muted phone must lose nothing but pleasure.

---

## 9. Responsible design

These are constraints on the build, not aspirations.

**No loss chasing.**
- No copy anywhere uses "recover", "win it back", "revenge", or "streak".
- After a loss the `NEW ROUND` control keeps the same size, position and
  emphasis it always has, and the stake is never pre-incremented.
- No auto-rebet with escalation. Auto-play, if built, is fixed-stake, capped in
  rounds, and cancellable in one tap.
- Cumulative session result is always available in one tap and is never hidden
  behind a positive-only "wins" view.

**No misleading skill framing.**
- The game never uses the words "skill", "strategy pays", "outplay" or "beat".
- The help screen states plainly: *"Every way of playing SWARM returns the same
  95% on average. Your choices change how often you win and how much — never how
  much you get back over time."*
- The harvest plan carries the same disclaimer at the point of use.

**No latency-sensitive money decisions.**
- Nothing is timed. There is no countdown, no auto-continue, no "decide before
  the vent closes". A player can put the phone down mid-round.
- Because the round only advances on the player's tap, a slow or dropped
  connection cannot cost a payout. Reconnect restores the exact decision state.

**Honest numbers.**
- Displayed values truncate toward zero, so the credited amount is never below
  what was shown.
- The stake and the current bankable value are both on screen at every decision.
- The offspring probabilities are on screen for the whole round, not buried in a
  paytable.
- The RTP, the max win, and the FULL BLOOM frequency are in the help screen in
  plain language, with the same numbers as [MATH.md](MATH.md).

**Accessibility.**
- Colour is never the only channel: dead organisms change shape and opacity as
  well as colour; harvested value is announced as text as well as amber.
- Text contrast ≥ 4.5:1 against ABYSS; controls ≥ 44 pt.
- `prefers-reduced-motion` replaces splits and blooms with cross-fades and
  disables drift; the value count-up becomes an instant set.
- One-handed portrait play, no gesture required beyond a tap.
- Screen-reader labels announce generation, population, yield, colony value and
  each available action with its exact consequence.

**Player protection surfaces.** Session timer and net result in the top bar
menu, reality check every 30 minutes, deposit/loss/time limits reachable in two
taps, and a visible link to help resources. No bonus buy, no jackpot teaser, no
"almost" messaging.

---

## 10. Open questions for the build

1. **Colony choreography above 10 organisms.** The stage holds ~16 bodies at
   readable size in portrait; at 20+ the layout must switch to a tighter
   packing. Needs a layout pass, not a maths change.
2. **Share card generation.** Client-side capture versus server-rendered card
   with the verification URL baked in.
3. **Auto-play scope.** The harvest plan covers most of the need; whether a
   multi-round auto-play ships at all is a responsible-design decision, not a
   technical one.
4. **Side-bet discoverability.** Off by default is right; whether `FIRST LIGHT`
   deserves a one-time explainer is an onboarding test.
5. **Second title reuse.** The `staged-survival` module in
   [ENGINE.md](ENGINE.md) is deliberately generic. A future game changing only
   the offspring vector, the ladder and the thresholds should need no engine
   change — worth validating with a second configuration before the module is
   frozen.
