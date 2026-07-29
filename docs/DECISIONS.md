# SWARM — design decisions

Short records of the decisions that shaped the specification, written when the
alternative was real and the reasoning is not obvious from the rule. Each one
states what was decided, what it rejected, what the rejection costs, and what
would reopen it. They are not a changelog: [ENGINE.md §2](ENGINE.md) carries the
adapter changelog and the version rules.

The order is chronological. Nothing here overrides the documents; where a
decision is load-bearing, the rule lives in `MATH.md`, `ENGINE.md` or
`DESIGN.md` and this file says why it reads the way it does.

---

## D1 — A stage accepts one harvest commitment

**Decided.** The decision at a generation is a single choice of `k` in `[0, n]`,
and committing it closes that generation's decision
([ENGINE.md §5.3](ENGINE.md), [MATH.md §1.1](MATH.md)).

**Rejected.** Letting a stage accept an unbounded sequence of harvests, which is
what round 3's command surface allowed while every consumer of the action log
assumed otherwise.

**Why.** Three things depended on one action per stage and none of them said so:
the published verifier replays one logged action per generation, so a player who
tapped HARVEST twice in one generation got `DERIVATION_FAILED` on an honest
round; the invariance proof is written against a model that consults the player
once per generation; and the floor-rounding bound of 18 credit events was false
under repeated harvests, where the true maximum is 117
([MATH.md §13](MATH.md)). Generalising instead — a verifier that accepts
multiple entries per stage, a longer transcript bound, a restated model, a
published bound of 117 — was the other coherent option and buys the player
nothing: `c(t)k₁ + c(t)k₂ = c(t)(k₁ + k₂)`, so a split harvest reaches the same
outcomes, and `floor(x) + floor(y) <= floor(x + y)` makes it pay weakly less.
The rule is therefore the option that is better for the player and smaller in
the protocol.

**What it costs.** A player who commits a partial harvest cannot then bank the
remainder at the same generation; they advance, or they wait. Nothing is hidden
from them at that moment — no new draw has resolved — so it is a regret cost, not
an information cost, and the client answers it by collapsing the action bar to
`NEXT` so a control that would be refused is never on screen
([DESIGN.md §4.3, §5](DESIGN.md)).

**Reopen if.** A build test shows players routinely tapping HARVEST intending
BANK. The fix would be a confirmation step or a longer commit gesture, not a
second commitment.

---

## D2 — A round abandoned at stage 0 is advanced once and banked

**Decided.** Reconciliation of a round that was staked and never advanced
performs the round's only legal command — the mandatory generation 1 — and then
forces the bank at stage 1 ([ENGINE.md §5.5](ENGINE.md)).

**Rejected.** Two alternatives, both defensible on their face.

*Settle at `c(0) = 19/60` per organism.* [MATH.md §5](MATH.md) defines that
value, and it is deliberately outside the ladder: paying it would be paying a
`0.95x` settlement on a round in which nothing was revealed, and would require a
ladder value at a stage the ladder does not cover.

*Void and return the stake.* Clean, and standard for a bet that never started —
§5.5's own objection to a void ("it would unwind a resolved generation") does not
apply at stage 0, because nothing has resolved. It was rejected because it pays
`1.00x` on a round worth `19/20`: it would make walking away before generation 1
the only action in the game that beats the house edge, and the game's central
claim is that no action does. The exploit is not profitable — the player gets
their stake back and nothing more — but "the only positive-EV move is to abandon"
is a sentence this specification should not have to write.

**Why the chosen rule is not a forced decision.** §5.5 refuses a forced advance
everywhere else because it exposes an absent player to extinction *instead of* an
action they might have preferred. At stage 0 there is no such preference:
`advance()` is the only legal command, `harvest()` is refused there, and
generation 1 is mandatory for every round ever played. The server performs the
player's only move, not a choice between their moves — and the transcript it
produces is identical to a returning player's, so nothing new had to be defined
for it.

**What it costs.** An absent player takes the generation-1 distribution, which
zeroes them 6.4% of the time. That is the same distribution every present player
takes, and it is EV-neutral (`19/20` either way).

**Reopen if.** A jurisdiction requires a bet that never started to be voidable.
The rule is then a per-jurisdiction lifecycle policy, and the transcript already
distinguishes the two: `settlementMode` is sealed in the body commitment.

---

## D3 — The environment reveal is keyed to colony value, not to FULL BLOOM

**Decided.** The environment rises above the black floor when the colony is worth
at least `475/48 = 9.895833x`, the smallest value a bloom can have
([DESIGN.md §7.2](DESIGN.md)).

**Rejected.** Keeping the reveal as a bloom effect. It cannot be both a
consequence of the exposure curve and a population event: §6.3's tone map is
strictly increasing in value, so it cannot distinguish sixteen organisms at
generation 3 from three organisms at generation 18 except by saying the second is
brighter.

**What it costs.** The reveal is no longer unique to the marquee moment: it fires
on one round in 13.71 under never-harvest play against one in 22,217.97 for a
bloom, so the picture is about 1,620 times more common than the event it used to
belong to ([MATH.md §8.2](MATH.md)). That is the honest version, and it is also a
better product: the clip the marketing case rests on is now reachable by a real
player, and the thing that makes a bloom special is what it *is* — a force-settle
— rather than a light show it did not earn.

**Reopen if.** Playtesting shows the reveal at 7% of never-harvest rounds is too
frequent to carry weight. The parameter to move is the threshold, which is a
value and is enumerated; it is not the keying, which is fixed by §6.5 R1.

---

## D4 — The persistent wild-line ghost is cut

**Decided.** The wild line appears as a per-bet chip, as a 400 ms teaching beat
at the harvest, and as the completed line after the round — never as a
continuously drawn colony behind the player's own
([DESIGN.md §4.2, §9.8](DESIGN.md)).

**Rejected.** Round 3's live ghost, drawn for the whole round whenever a side bet
was live.

**Why.** Containment ([MATH.md §7.3](MATH.md)) makes the wild line never smaller
than the player's colony and strictly larger after any harvest, so a permanent
ghost is a standing monument to the position the player gave up — which is what
§9.2 ("show where you stand; never show the way back") and §7.2 ("no near-miss
promotion") exist to prevent. It was also, by construction, the richest visual in
the game and available only behind a second stake.

**What it costs.** Less in-round texture for a side bet, and a player who
harvests sees the counterfactual for 400 ms rather than continuously. §4.2's
original argument — that a `248.798x` bet needs in-round feedback — is met by the
chip, which carries the same information as a number.

**Reopen if.** Testing shows players still believe harvesting can lose them a
side bet. The next thing to try is copy and chip design, not a bigger drawing of
the colony they did not keep.

---

## D5 — Speed of play has floors, and skipping does not shorten them

**Decided.** A 2,500 ms round cycle, a 350 ms dead period between a resolved
state and the action bar, and a 600 ms settlement hold, none of which vary with
anything the round did ([DESIGN.md §9.7](DESIGN.md)).

**Rejected.** Leaving "nothing is timed" to cover both directions. It does not:
it bounds decision time from below at zero and says nothing about the cycle, and
with every beat skippable a `BANK_FIRST` round is under a second end to end.

**Why.** Tap-to-skip that shortens the cycle is functionally slam-stop, and §4.3
already refuses in-round autoplay by name for the same reason. SWARM is not a
slot and the 2.5 s spin-cycle rule does not bind a free-play prototype, so this
is a choice rather than a compliance step — which is exactly why it is written
down.

**What it costs.** A player who wants to move fast waits 2.5 seconds a round. The
dead period also does double duty as the input guard that stops the second tap of
a double-tap landing on a money control.

**Reopen if.** The floors are tuned; the rule that they do not vary with the sign
of the position or the size of the win is not a tuning parameter.
