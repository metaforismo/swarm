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

---

## D6 — The wild line is never printed beside the player's own populations

**Decided.** S8a states how much of the completed wild line the player's round
covered (`generation 1 to 4 of 9`) and lights those bars on the chart. It does
**not** print the player's own population sequence under the wild line's
([DESIGN.md §9.8](DESIGN.md)).

**Rejected.** The first build's `YOUR COLONY 5 → 2 → 3 → 2 → 0` row, one line
below `5 → 4 → 4 → 2 → 0`, in the same type.

**Why.** Every clause of §9.8 permits it — the round is over, the counterfactual
is completed, no live decision is on screen — and it still violates the section's
closing sentence, which is the part that was written to survive a future feature:
the wild line may be shown as the state of a bet, *never as an alternative colony
they could have had*. Containment ([MATH.md §7.3](MATH.md)) proves the player's
row can never be the larger one, so the comparison has exactly one possible
reading. It was the one place in the product where the game itself drew
it, and it was inherited rather than decided.

**What it costs.** A player who wants to compare the two sequences taps once more:
their own populations are on the receipt (S8), where they are their own record
rather than a rival's.

**Reopen if.** Never as a side-by-side. If comprehension testing shows players do
not understand what the wild line resolves on, the answer is copy on S8a or a
better harvest-beat caption, not the row.

---

## D7 — Session limits tighten immediately and loosen only after a cool-off

**Decided.** Setting or lowering a stake budget, loss limit or time limit binds on
the next stake; raising or removing one is scheduled and lands 24 hours later,
with the pending value and its effective moment published
([DESIGN.md §9.9](DESIGN.md)). A tightening cancels a pending loosening.

**Rejected.** Symmetric limits, where a change of any kind applies at once.

**Why.** The moment a limit binds is exactly the moment a player wants it gone, so
a symmetric limit is a limit that is present until it matters. The asymmetry is
the whole mechanism and it costs a player who genuinely wants to raise one a day's
wait — a cost paid entirely by the case the control is not for. It is also the
standard shape of the control wherever it is regulated, so shipping the symmetric
version would be a deliberate weakening rather than a simplification.

**What it costs.** A player who sets a limit too low in error is held to it for a
day. Mitigated by presets rather than free entry, by publishing the pending change
rather than silently dropping it, and by never letting a limit interrupt a round
already staked.

**Reopen if.** The cool-off length is a tuning parameter and is served from
configuration. The asymmetry is not.

---

## D8 — The speed-of-play floors are enforced by the server, as waits

**Decided.** All three floors of D5 are enforced by the round service as well as
by the client, and enforced by **holding** a command until its floor has passed
rather than by refusing it (`src/server/pacing.ts`).

**Rejected.** (a) Client-only floors, which is what the first build shipped: the
documented API could be driven at roughly 26 rounds a second, so §9.7's "a whole
round cannot be chained faster than this" was false of the product and true only
of one client. (b) Refusing an early command with a typed error, which is smaller
and faster and turns every floor into a deadline — the exact thing §9.5 forbids.

**Why.** A floor is a statement about the product. A wait keeps it one: the
command is processed exactly as it would have been, no floor can cost a payout,
and there is no new error a player has to understand. The client keeps its own
copy so the *screen* is paced rather than the network, and both read the same
three numbers from `/api/config`.

**What it costs.** A held connection per early command, which is acceptable at
free-play scale and would need a queue rather than a sleep at real scale. Tests
that play dozens of rounds set the floors to zero through the documented service
option, and the floors themselves are asserted with the defaults and real elapsed
time.

**Amended: a refused command pays no floor.** The first build charged every command
that arrived, accepted or not. Ten malformed opens therefore cost 25 s of held
connections and pushed the next honest stake behind all ten cycle floors — so
arguing with the API was slower than playing it, and a client could buy a held
connection with a piece of garbage. It was also the wrong reading of the rule: a
floor is charged for *cycling a round*, and a rejected payload, a stake a session
limit refused, or a command fenced to a stale frame has not cycled one. A refused
command now hands its slot back (`Admission.release()` in `src/server/pacing.ts`);
one that succeeds keeps it, which is what makes the floor a floor.

**Two things a release must never do, both of which the first release did.** This is
the dangerous half of the mechanism, because a rollback that returns one
millisecond too many turns a floor into something a client can clear on demand by
getting a command refused.

  - *It must restore a round's dead period, not clear it.* A round that is already
    open can be `open`ed again — a retry, a stale fence — so a **refused** open can
    land on a **live** round. Deleting that round's dead period let a client take
    its next decision immediately by getting one command deliberately refused
    first: measured over HTTP at 4 ms against a 350 ms floor.
  - *It must not roll back past a settlement hold.* A release returns the open gate
    to where the released command found it, which is *before* any hold that landed
    while it was waiting. The hold therefore lives on its own monotonic floor that
    no release lowers, or a client with a refused open queued behind a real round
    could settle that round and open the next one inside the 600 ms hold.

Both are pinned by `tests/pacing.test.ts` against an injected clock, and both of
those tests fail against the first release. The general rule the code implements: a
release may only return time the released command itself was holding, and a write
is skipped entirely if anything reserved after it.

**What the release does not fix.** A refusal that arrives while a floor is
*genuinely* running still waits it out, because a single high-water gate cannot
return an out-of-order slot: six refusals fired concurrently inside a live cycle
floor still take 15 s of held connections. That is the conservative direction — it
never admits a command early — and the fix covers the case that actually happens,
a refusal when no floor is in force. Returning out-of-order slots needs the queue
this decision already says real scale needs.

**Reopen if.** Real-scale deployment. The mechanism changes; the property that a
floor is never a refusal does not, and neither does the rule that a release may
never shorten a floor it did not create.

---

## D9 — The fairness surface names two module identities, never one

**Decided.** `/api/config` publishes SWARM's module contract
(`reveal-engine/staged-survival-v1`, owned by [ENGINE.md](ENGINE.md), implemented
in `src/server/`) and the engine's own identities (`reveal-engine/module-v1`, the
shipped `staged-survival` 1.0.0) as separate fields with their owners named, and
the help and verify sheets render both under "Who implements what".

**Rejected.** (a) The first build's single `MODULE reveal-engine/staged-survival-v1`
row directly above `ENGINE @axiom-games/reveal-engine 0.4.0`. Beside an engine
name and version, on the panel where a player evaluates fairness, that reads as a
conformance claim to a module the engine ships — and the module the engine ships
cannot express this game, by its own documentation. The honesty was real but it
lived in README prose a player never sees. (b) Renaming the identifier itself. It
is bound into the adapter fingerprint and therefore into every draw and both
commitments, so changing it would move every frozen vector in the repository to
fix a labelling defect.

**Why.** Provenance is a fairness claim. Where the repository is careful about
what commit-reveal does and does not prove, it has to be equally careful about who
wrote the lifecycle being proved.

**What it costs.** A longer panel, and a player has to read two rows where they
read one. Both rows are true.

**Reopen if.** Reveal Engine ships a branching-population module and SWARM adopts
it. Then there is one identity because there is one implementation.

---

## D10 — The round service keeps one custody boundary

**Decided.** The process-local `RoundService` owns every mutable round book,
wallet total and sealed seed. Public record, book, history and wallet reads are
detached frozen views. Each caller-owned command is copied and validated once,
before a pacing wait or any idempotency decision, and that canonical snapshot is
the only value the command executes. Wallet receipt batches are validated into
locals and committed with one state replacement. Exact retries replay their
recorded result without moving the abandonment clock or consuming another
pacing floor.

Server seeds are generated inside the service in production, normalized, and
kept unique for as long as the owning round remains in the registry. The issued
seed leaves the uniqueness set only when the same round is evicted; a retained
round can therefore never collide, while the set has the same lifetime bound as
the registry it protects. At settlement the verifier replays the seed, client
entropy, action log and receipts and checks every published live-chain value
rather than accepting redundant proof fields as authority. D8's floors are
enforced at this service boundary, so direct callers and HTTP callers obey the
same waits.

**Rejected.** The round-2 build's split authority: returning live `StageBook` and
wallet objects, reading request getters again after validation, posting a receipt
batch incrementally, accepting a caller-provided production seed source, moving
retry deadlines as if a replay were progress, trusting submitted receipt or
chain values because their enclosing commitment matched, and pacing only the
HTTP transport.

**Why.** All of those alternatives let an untrusted boundary participate in a
fact the server later treats as settled: what was requested, what money moved,
which entropy was sealed, what action was logged, or when the round progressed.
One custody boundary makes those facts functions of server-held state and one
canonical command. The verifier then checks the same facts independently instead
of merely checking that a self-consistent claim was signed.

**What it costs.** Public reads allocate copies, verification replays the round,
and receipt posting stages a complete batch before committing it. Deterministic
seed injection is restricted to the test environment. These costs are bounded by
the existing command, transcript and live-round limits; they do not add accounts,
authentication or durable storage to this free-play prototype.

**Reopen if.** The service becomes multi-process or durable. The ownership rule
stays, but the authority moves behind a transactional store and a real seed
custodian rather than process memory.

---

## D11 — Snapshot and restore are absent, so the contract says so

**Decided.** Correct the engine contract to the implementation: SWARM exposes no
`snapshot()` or `restore()` surface, declares no snapshot schema identity, and
makes no cross-process recovery claim ([ENGINE.md §7](ENGINE.md)).

**Rejected.** Implementing a new persistence protocol solely to preserve prose
that described snapshot round-trips and validation checks the repository had
never shipped.

**Why.** This repository is explicitly a process-local free-play prototype.
Inventing a serialized authority boundary is product and protocol work, not a
documentation repair: it would require versioning, migration, integrity,
idempotency and seed-custody decisions beyond the closed scope. A conformance
item for nonexistent code weakens the rest of the conformance list.

**What it costs.** A process restart loses in-memory rounds and there is no
resume-after-restart claim. That limitation is now visible rather than hidden
behind an interface sketch.

**Reopen if.** Durable recovery becomes an explicit product requirement. Add the
implementation, schema and adversarial restore tests together, then version the
contract around the shipped behavior.
