# SWARM

**Seed three organisms in the dark. Every generation they die, hold, or split.
Bank the colony whenever you like — or harvest part of it and let the rest keep
growing.**

SWARM is a branching-colony instant game from **Axiom Games**, built on
**Reveal Engine™**. You stake once and seed three bioluminescent organisms at a
deep-sea vent. Each generation every organism independently dies (40%), holds
(40%), or splits in two (20%), at probabilities printed on the screen. Your
colony's value is its size times a yield that climbs 25% every generation it
survives — so unlike a crash multiplier, **this number can go down and come
back**, and you can take part of it off the table at any point. Extinction zeroes
whatever you did not harvest. Nothing in the game is timed, so no decision
depends on your connection. Every strategy, from banking instantly to riding
eighteen generations, returns exactly the same 95%: your choices move the risk,
never the return, and that is proven by exhaustive enumeration rather than
asserted.

---

## Status

| | |
| --- | --- |
| Stage | **Playable graybox.** A server-authoritative round service, a portrait browser client, and the specification, exact paytable, proofs and tests they are built from. The information architecture, the flows, the money and the fairness are the real ones; the art is placeholder shapes. Final art, motion polish and sound are a later wave. |
| Money | Free-play prototype only. In-memory wallet, no real-money integration, no persistence. |
| Engine | Consumes `@axiom-games/reveal-engine` **0.4** as a package (`vendor/`) for the primitives [docs/ENGINE.md §1](docs/ENGINE.md) requires reused verbatim: exact `Rational` money, `payableWithinCap`, constant-time digest comparison, the error taxonomy, `ENGINE_LIMITS`, and the idempotency and frame-fence discipline. The engine's own `staged-survival` module models a **different** lifecycle — by its own documentation it "cannot express offspring" — so SWARM's branching cohort, ladder, wild line and per-line ledger are implemented in `src/server/` against this repository's contract. [The gap, in full.](#what-the-engine-provides-and-what-it-does-not) |
| Evidence | `npm run verify` locally. Every settlement the server produces is re-verified by the **published reference verifier** in `tools/simulate.mjs` inside the test suite, so the service and the specification are checked against each other rather than against themselves. Hosted CI (`.github/workflows/ci.yml`) is configured but has never run: nothing has been pushed to the remote, so cross-version determinism is currently evidenced on one machine only. |
| Certification | None. Not an RNG certificate, not a fairness certificate, not a laboratory or regulatory approval. See [docs/MATH.md §15](docs/MATH.md). |

```sh
npm install
npm run dev              # the whole game at http://127.0.0.1:8787  (Node >= 22.18)
npm test                 # re-derives every published number, and plays rounds through the API
npm run verify           # fixture + generated docs + typecheck + tests
npm run enumerate        # exact paytable, proofs, exact fractions
npm run simulate         # seeded Monte Carlo cross-check and a worked ticket ledger
```

`npm run dev` runs the TypeScript server directly, which needs Node's native type
stripping (**Node 22.18+, 24 or 25**). Everything else, including the whole test
suite, runs on Node 20.

---

## How a round works

1. **Stake and seed.** The server has already published its sealed seed's hash.
   You pay one stake, set your own client seed, and receive a colony of **3
   organisms**. Optional side bets, each with its own stake, are placed now,
   before anything is revealed — and cannot be added later.
2. **Generation 1 resolves automatically.** Each organism consumes one draw:
   `0–7` it dies, `8–15` it holds, `16–19` it splits into two. This first
   generation has no decision — it is where the house edge lives, and after it
   nothing else takes a cut.
3. **Decide.** You see the colony, its exact value, and where that sits against
   your stake. One decision per generation, on a continuum:
   - **BANK** — take everything, round over.
   - **HARVEST** — credit some organisms immediately and keep the rest running.
     A tap takes `floor(n / 2)`; a press-and-drag takes any number you like.
     Committing it settles this generation's decision; the next tap is `NEXT`.
   - **CONTINUE** — resolve the next generation.
   There is no timer on any of these, and nothing plays the round for you. The
   round advances when you tap.
4. **Repeat** until you bank, the colony goes extinct, it reaches **FULL
   BLOOM** (16+ organisms, which auto-settles at full value), or generation
   **18** ends the round. Side bets resolve at settlement, never before.

**Value.** One organism is worth `19/48 ≈ 0.3958x` your stake after generation 1,
and **25% more each generation it survives** — `0.49x`, `0.62x`, `0.77x`, … up
to `17.57x` at generation 18. A colony is worth exactly its size times that
yield, which is why half a colony is worth exactly half its value and HARVEST
can be exact rather than approximate. It also means the value **falls** whenever
the colony shrinks by more than a fifth: about half of all rounds are worth less
than the stake after that first mandatory generation, which the design has to
answer for rather than hide ([docs/DESIGN.md §9.2](docs/DESIGN.md)).

---

## The numbers

| | |
| --- | --- |
| Theoretical RTP | **95%** exactly (`19/20`) — every bet line, every strategy |
| Max win, COLONY line | **905.77x** its own stake; declared cap `906x`, proven never to bind |
| Biggest single settlement | `527.35x` |
| Cap basis | One per bet line, on that line's own stake. No cap sums lines, so no line is ever short-paid |
| FULL BLOOM | 1 in 22,218 rounds **if you never harvest**; pays 9.89x to 527.35x, median 37.74x. Harvesting lowers it, and halving the colony every generation puts it at exactly zero — the frequency belongs to a play pattern and is always published with one ([docs/MATH.md §8.2](docs/MATH.md)) |
| Colony reaches 4+ organisms | 1 in 2.87 rounds |
| Volatility | Player-selected, and the whole range is selectable. Proven interval over *every* policy: standard deviation `0.513058` (bank at once) to `7.569363` (harvest one organism at 15). The harvest stepper reaches both ends |
| How often you profit | `P(return > stake)`: 45.60% banking at once, 30.75% harvesting half every generation, 2.24% never banking. A side bet on the same ticket moves this a long way in either direction — adding DARK VENT at an equal stake takes 45.60% to 36.09% for the first, and 2.24% to 37.57% for the last ([docs/MATH.md §7.4](docs/MATH.md)) |
| How often you get back less than you staked | 48.00% banking at once, 50.04% harvesting half every generation — the most common outcome class in the game, and the settlement screen says so ([docs/DESIGN.md §7.1](docs/DESIGN.md)) |
| Round length | 5.85 generations on average, 18 maximum |
| Side bets | FIRST LIGHT `4.75x`, DARK VENT `2.689x`, SWARM `248.798x` — all at 95%, each with its own stake and cap |

Full derivations, exact fractions and the strategy proof: [docs/MATH.md](docs/MATH.md).

---

## Fairness model

- **Two-phase commit-reveal.** SWARM's transcript depends on your decisions, so
  one commitment cannot cover it. Before the round the server publishes a **seed
  pre-commitment** — `sha256` over the sealed seed, adapter identity and grid
  shape — which proves the seed predates every decision. At settlement it
  publishes a **settlement body commitment** over the revealed seed, your client
  seed, every resolved population, **the ordered action log** and the whole
  per-line credit ledger. The second phase is what makes the action log evidence
  rather than an assertion: one published round cannot be settled two ways
  without producing two different, publicly distinguishable digests.
- **Your seed too.** You supply 32 bytes of client entropy *after* the server has
  sealed its own, and every draw is a function of both. Neither side can choose
  its half knowing the other's. See the honest limits below.
- **A committed draw grid.** All 270 draws of a round (18 generations × 15
  slots) are derived from the two seeds by domain-separated HMAC-SHA256 with
  exact rejection sampling — no modulo bias, no floats. Your decisions choose
  *which* draws your colony consumes; they cannot change what the draws are.
- **Verifiable by re-derivation.** A verifier replays every generation *from the
  action log*, reproduces the payout of every line exactly, and then re-seals the
  body commitment and compares it — so a log that was not the log fails.
  `tools/simulate.mjs` is a working reference implementation of the derivation,
  both commitment phases, the side-bet resolution, the settlement ledger and the
  verifier; `npm run simulate` prints a forged action log being rejected.
- **No information leaks into a live decision.** Side bets resolve on the
  unharvested "wild line". You can watch it for every generation you have already
  resolved and not one generation further — the boundary is exactly where the
  arithmetic puts it, with the proof in
  [docs/MATH.md §7.3](docs/MATH.md), not where taste would.
- **Exact arithmetic end to end.** Probabilities and money are BigInt rationals;
  the only rounding is a single floor at each credit, in integer minor units
  (`1 credit = 10^6 units`). A round can produce at most **18** such credits on
  the colony line — a number computed by dynamic program over every grid and
  every play pattern, not asserted — so the floor costs at most `1.8e-4` of the
  minimum stake, or 0.018 percentage points of RTP. It is the one quantity that
  depends on how you play, and it is disclosed rather than rounded away
  ([docs/MATH.md §13](docs/MATH.md)).
- **No latency-sensitive decisions.** No decision in SWARM has a deadline. A slow
  connection cannot cost you a payout. There is a *floor* on how fast rounds can
  be chained — a speed-of-play control, not a clock on any decision
  ([docs/DESIGN.md §9.7](docs/DESIGN.md)) — and the one server-initiated
  transition is a forced bank at the exact current value after 72 hours of
  abandonment, which is EV-neutral because every action ties. That covers a round
  that was staked and never advanced: it resolves its one mandatory generation
  and banks what survives.

**What this does not prove.** Commit-reveal shows a seed was fixed before the
round; it does not show *how that seed was chosen*, and an operator could in
principle generate many seeds and publish a convenient one. Client entropy is the
control for that, and it works only if the publication order it depends on is
actually enforced by the operator — which is a storage and process property this
repository cannot demonstrate. The action log is bound to the settlement and to a
live hash chain you are handed during the round, but making it verifiable by a
*third party* requires retaining what you were handed. All three are stated in
full in [docs/MATH.md §15](docs/MATH.md) and [docs/ENGINE.md §8](docs/ENGINE.md)
rather than left for a reader to notice.

---

## The graybox

```sh
npm install
npm run dev            # http://127.0.0.1:8787
```

One command serves the round service on `/api` and the client from `src/client`.
The wallet opens at 1,000 free-play credits (`SWARM_OPENING_CREDITS`), the
abandonment clock is the adapter's 72 hours (`SWARM_ABANDON_TIMEOUT_HOURS`), and
`PORT` moves the port. Nothing is persisted: restarting the server is a new
session.

**What is real.** The round lifecycle of [docs/ENGINE.md §5](docs/ENGINE.md), end
to end: the seed pre-commitment published before a stake exists, client entropy
generated in the browser and never supplied by the server before `open()` — it is
public afterwards, because being chosen second is its whole job — a committed
270-draw grid, server-authoritative frames with a revision fence, idempotent
commands,
per-line receipts in integer minor units, one harvest commitment per stage, the
lagged wild-line disclosure, side bets resolved only at settlement, the
settlement body commitment over the action log, the live action chain, forced
reconciliation after the timeout, and a verifier that re-derives all eight steps
of §4.6 in front of the player.

**What is placeholder.** The organisms are flat discs where the gel bells with
subsurface scattering will go; halation is a box-shadow, not two bloom passes;
the water is a gradient, not a volumetric; there is no sound; the settlement
ceremony is timed and tiered but not choreographed; and the environment reveal
fades rather than dollies. The layout, the type scale, the palette, the beat
timings and every number are the specified ones.

### The API

| Call | What it does |
| --- | --- |
| `GET /api/config` | The adapter identity, the fingerprint, and the whole frozen paytable the client renders its help screen from |
| `POST /api/rounds` | **Phase 1.** Seals a seed and publishes its pre-commitment. No stake, no entropy, no seed-dependent value |
| `POST /api/rounds/:id/open` | Binds the client entropy, derives the grid, debits one line per bet. One `DEBIT` receipt per line and nothing else |
| `POST /api/rounds/:id/advance` | Resolves the next generation. At stage 0 this is the mandatory generation 1 |
| `POST /api/rounds/:id/harvest` | Credits any legal `k`; `k = units` is a BANK and still owes a `settle()` |
| `POST /api/rounds/:id/settle` | Reveals the seed, resolves the side bets, publishes the settlement body |
| `POST /api/rounds/:id/reconcile` | The abandonment rule. `TOO_EARLY` before the timeout |
| `POST /api/verify` | Runs §4.6 against a submitted proof bundle and returns the eight checks |
| `GET /api/session` | Balance, signed session result, and the last 50 rounds |

Every **player** command carries an `idempotencyKey` and the
`expectedFrameRevision` it was fenced to. A retry replays its receipts; a changed
payload under the same key — including a different client seed — is
`IDEMPOTENCY_CONFLICT`; a stale fence is `STALE_FRAME` and mutates nothing.
`reconcile()` is the one exception and it is the specified one: it is
server-initiated, so it takes the round's current revision from the book and a
reserved key derived from the round id, which is what stops it racing a player
command ([docs/ENGINE.md §5.5](docs/ENGINE.md)).

### What the engine provides, and what it does not

Reveal Engine 0.4 ships a lifecycle module called `staged-survival`, and it is
not the one [docs/ENGINE.md](docs/ENGINE.md) specifies. Its own documentation
says why: it resolves a shrinking subset of a fixed entity set and "cannot
express offspring", which is the whole of SWARM's cohort. So the split is:

| From the engine, imported | Built here, against docs/ENGINE.md |
| --- | --- |
| Exact `Rational` arithmetic, `payable` / `payableWithinCap` | The branching cohort, the ladder, the wild line |
| Constant-time digest comparison, seed normalization, SHA-256 | Both commitment phases and the live action chain |
| `RevealEngineError`, `ERROR_CODES`, `ENGINE_LIMITS` | The per-line ledger and the per-line cap bases |
| `commandFingerprint`, `assertIdempotencyKey` | The `StageBook` lifecycle and the abandonment rule |
| `assertClientEntropy`, `SURVIVAL_LIMITS` from the module | Side-bet pricing and the §4.6 verifier |

`src/server/engine.ts` is that list in code, with the two deviations named: the
engine does not export `encodeFields` from any subpath, so `src/server/canonical.ts`
carries a byte-identical port pinned against the reference encoder; and the
engine's sampler payload has no client-entropy field, so the 11-field payload of
§4.1 is built here. Both are checked rather than asserted — the tests reproduce
the frozen adapter fingerprint, the frozen seed pre-commitment and the reference
implementation's settlement bodies byte for byte.

---

## Repository map

| Path | What it is |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | Product spec: loop, decisions, bets, portrait UX flow, art and sound direction, responsible-design rules |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The design decisions behind the rules above: what was rejected, what it would have cost, and how to reopen it |
| [docs/MATH.md](docs/MATH.md) | Exact model, paytable, RTP justification, volatility bounds, caps, strategy proof |
| [docs/ENGINE.md](docs/ENGINE.md) | The `staged-survival` Reveal Engine module and the adapter surface SWARM expects |
| `src/server/` | The round service: adapter, derivation, commitments, `StageBook`, per-line ledger, verifier, HTTP surface |
| `src/client/` | The portrait client: stage, value strip, action bar, ceremony, receipt, verify and help sheets |
| `vendor/` | The Reveal Engine package this repository depends on, exactly as `npm pack` produced it (`npm run engine:pack`) |
| `tools/enumerate.mjs` | Exhaustive exact enumeration — the proof behind every number |
| `tools/simulate.mjs` | Reference draw derivation, two-phase commitment, ticket ledger, verifier and seeded Monte Carlo cross-check |
| `tools/lib/presentation.mjs` | Feedback contracts derived from the model: verdict bands, the chord ladder and its reachability proof, settlement classes, colony layout |
| `tools/syncdocs.mjs` | Writes the generated tables into the documents; `--check` fails if any is stale |
| `spec/paytable.v3.json` | Frozen canonical paytable fixture |
| `tests/` | Vitest suite: re-derives the paytable, asserts the documentation matches it, and plays whole rounds through the API |

---

SWARM — Powered by Reveal Engine™ — An Axiom Games original.
Reveal Engine™ is technology, SWARM is a title, Axiom Games is the studio. The ™
symbol is not a registered-trademark claim. This repository is private,
`UNLICENSED` and unpublished.
