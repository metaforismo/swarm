# SWARM

**Seed three organisms in the dark. Every generation they die, hold, or split.
Bank the colony whenever you like — or harvest half and let the rest keep
growing.**

SWARM is a branching-colony instant game from **Axiom Games**, built on
**Reveal Engine™**. You stake once and seed three bioluminescent organisms at a
deep-sea vent. Each generation every organism independently dies (40%), holds
(40%), or splits in two (20%), at probabilities printed on the screen. Your
colony's value is its size times a yield that climbs 25% every generation it
survives — so unlike a crash multiplier, **this number can go down and come
back**, and you can take half of it off the table at any point. Extinction zeroes
whatever you did not harvest. Nothing in the game is timed, so no decision
depends on your connection. Every strategy, from banking instantly to riding
eighteen generations, returns exactly the same 95%: your choices move the risk,
never the return, and that is proven by exhaustive enumeration rather than
asserted.

---

## Status

| | |
| --- | --- |
| Stage | **Specification — build-ready.** Docs, exact paytable, proofs, fixtures and tests. No game client in this repository yet. |
| Money | Free-play prototype only. No real-money integration exists. |
| Engine | Consumes a Reveal Engine lifecycle module, `staged-survival`, specified in [docs/ENGINE.md](docs/ENGINE.md) and **not yet implemented** in Reveal Engine 0.2. |
| Evidence | `npm run verify` locally. Hosted CI (`.github/workflows/ci.yml`) is configured but has never run: nothing has been pushed to the remote, so the cross-version determinism it exists to prove is currently evidenced on one machine only. |
| Certification | None. Not an RNG certificate, not a fairness certificate, not a laboratory or regulatory approval. See [docs/MATH.md §15](docs/MATH.md). |

```sh
npm install
npm run enumerate        # exact paytable, proofs, exact fractions
npm test                 # re-derives every published number
npm run verify           # fixture + generated docs + tests
npm run simulate         # seeded Monte Carlo cross-check and a worked ticket ledger
```

---

## How a round works

1. **Stake and seed.** You pay one stake and receive a colony of **3
   organisms**. Optional side bets, each with its own stake, are placed now,
   before anything is revealed — and cannot be added later.
2. **Generation 1 resolves automatically.** Each organism consumes one draw:
   `0–7` it dies, `8–15` it holds, `16–19` it splits into two. This first
   generation has no decision — it is where the house edge lives, and after it
   nothing else takes a cut.
3. **Decide.** You see the colony, its exact value, and where that sits against
   your stake. Three actions:
   - **BANK** — take everything, round over.
   - **HARVEST** — credit `floor(n / 2)` organisms immediately and keep the
     rest running.
   - **CONTINUE** — resolve the next generation.
   There is no timer on any of these. The round advances when you tap.
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
| FULL BLOOM | 1 in 22,218 rounds; pays 9.90x to 527.36x, median 37.74x |
| Colony reaches 4+ organisms | 1 in 2.87 rounds |
| Volatility | Player-selected. Proven interval over *every* policy: standard deviation `0.513058` to `7.569363` |
| How often you profit | `P(return > stake)`: 45.60% banking at once, 30.75% harvesting half every generation, 2.24% never banking |
| Round length | 5.85 generations on average, 18 maximum |
| Side bets | FIRST LIGHT `4.75x`, DARK VENT `2.689x`, SWARM `248.798x` — all at 95%, each with its own stake and cap |

Full derivations, exact fractions and the strategy proof: [docs/MATH.md](docs/MATH.md).

---

## Fairness model

- **Commit-reveal.** Before the round the server publishes
  `sha256` over the round's seed, adapter identity and grid shape. The seed is
  revealed at settlement; anyone can recompute the commitment.
- **A committed draw grid.** All 270 draws of a round (18 generations × 15
  slots) are derived from the seed by domain-separated HMAC-SHA256 with exact
  rejection sampling — no modulo bias, no floats. Your decisions choose *which*
  draws your colony consumes; they cannot change what the draws are.
- **Verifiable by re-derivation.** Given the revealed seed and the action log, a
  verifier replays every generation and reproduces the payout of every line
  exactly. `tools/simulate.mjs` is a working reference implementation of the
  derivation, the side-bet resolution and the settlement ledger.
- **No information leaks into a live decision.** Side bets resolve on the
  unharvested "wild line", whose next population contains your own as a partial
  sum — so nothing about it may reach the client before your own round is over.
  That is a protocol rule with a proof behind it
  ([docs/MATH.md §7.3](docs/MATH.md)), not a UI preference.
- **Exact arithmetic end to end.** Probabilities and money are BigInt rationals;
  the only rounding is a single floor at each credit, in integer minor units
  (`1 credit = 10^6 units`), which costs at most 18 units per round — `1.8e-4`
  of the minimum stake, or 0.018 percentage points of RTP.
- **No latency-sensitive decisions.** Nothing in SWARM is timed. A slow
  connection cannot cost you a payout. The one server-initiated transition is a
  forced bank at the exact current value after 72 hours of abandonment, which is
  EV-neutral because every action ties.

---

## Repository map

| Path | What it is |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | Product spec: loop, decisions, bets, portrait UX flow, art and sound direction, responsible-design rules |
| [docs/MATH.md](docs/MATH.md) | Exact model, paytable, RTP justification, volatility bounds, caps, strategy proof |
| [docs/ENGINE.md](docs/ENGINE.md) | The `staged-survival` Reveal Engine module and the adapter surface SWARM expects |
| `tools/enumerate.mjs` | Exhaustive exact enumeration — the proof behind every number |
| `tools/simulate.mjs` | Seeded Monte Carlo cross-check, reference draw derivation and ticket ledger |
| `tools/syncdocs.mjs` | Writes the generated tables into the documents; `--check` fails if any is stale |
| `spec/paytable.v2.json` | Frozen canonical paytable fixture |
| `tests/` | Vitest suite: re-derives the paytable and asserts the documentation matches it |

---

SWARM — Powered by Reveal Engine™ — An Axiom Games original.
Reveal Engine™ is technology, SWARM is a title, Axiom Games is the studio. The ™
symbol is not a registered-trademark claim. This repository is private,
`UNLICENSED` and unpublished.
