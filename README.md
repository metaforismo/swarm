# SWARM

**Seed three organisms in the dark. Every generation they die, hold, or split.
Bank the colony whenever you like — or harvest half and let the rest keep
growing.**

SWARM is a branching-colony instant game from **Axiom Games**, built on
**Reveal Engine™**. You stake once and seed three bioluminescent organisms at a
deep-sea vent. Each generation every organism independently dies (40%), holds
(40%), or splits in two (20%), at probabilities printed on the screen. Your
colony's value is its size times a yield that climbs 25% every generation it
survives. Between generations you can bank everything, or — the mechanic no
crash game has — **harvest half the colony and let the other half keep running**.
Extinction zeroes whatever you did not harvest. Every strategy, from banking
instantly to riding eighteen generations, returns exactly the same 95%: your
choices move the risk, never the return, and that is proven by exhaustive
enumeration rather than asserted.

---

## Status

| | |
| --- | --- |
| Stage | **Specification — build-ready.** Docs, exact paytable, proofs, fixtures and tests. No game client in this repository yet. |
| Money | Free-play prototype only. No real-money integration exists. |
| Engine | Consumes a Reveal Engine lifecycle module, `staged-survival`, specified in [docs/ENGINE.md](docs/ENGINE.md) and **not yet implemented** in Reveal Engine 0.2. |
| Evidence | `npm test` and `npm run enumerate` locally. Hosted CI (`.github/workflows/ci.yml`) is configured but has never run: this repository has no remote. |
| Certification | None. Not an RNG certificate, not a fairness certificate, not a laboratory or regulatory approval. See [docs/MATH.md §14](docs/MATH.md). |

```sh
npm install
npm run enumerate        # exact paytable, proofs, exact fractions
npm test                 # re-derives every published number
npm run simulate         # seeded Monte Carlo cross-check
```

---

## How a round works

1. **Stake and seed.** You pay one stake and receive a colony of **3
   organisms**. Optional side bets are placed now, before anything is revealed.
2. **Generation 1 resolves automatically.** Each organism consumes one draw:
   `0–7` it dies, `8–15` it holds, `16–19` it splits into two. This first
   generation has no decision — it is where the house edge lives, and after it
   nothing else takes a cut.
3. **Decide.** You see the colony and its exact value. Three actions:
   - **BANK** — take everything, round over.
   - **HARVEST** — credit `floor(n / 2)` organisms immediately and keep the
     rest running.
   - **CONTINUE** — resolve the next generation.
   There is no timer on any of these. The round advances when you tap.
4. **Repeat** until you bank, the colony goes extinct, it reaches **FULL
   BLOOM** (16+ organisms, which auto-settles at full value), or generation
   **18** ends the round.

**Value.** One organism is worth `19/48 ≈ 0.3958x` your stake after generation 1,
and **25% more each generation it survives** — `0.49x`, `0.62x`, `0.77x`, … up
to `17.57x` at generation 18. A colony is worth exactly its size times that
yield, which is why half a colony is worth exactly half its value and HARVEST
can be exact rather than approximate.

---

## The numbers

| | |
| --- | --- |
| Theoretical RTP | **95%** exactly (`19/20`) — every bet type, every strategy |
| Max win | **905.77x** the stake; declared cap `906x`, proven never to bind |
| Biggest single settlement | `527.35x` |
| FULL BLOOM | 1 in 22,218 rounds |
| Colony reaches 4+ organisms | 1 in 2.87 rounds |
| Volatility | Player-selected: standard deviation 0.51 (bank at once) to 7.56 (never bank) |
| Round length | 5.85 generations on average, 18 maximum |
| Side bets | FIRST LIGHT `4.75x`, DARK VENT `2.689x`, SWARM `248.798x` — all at 95% |

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
  verifier replays every generation and reproduces the payout exactly.
  `tools/simulate.mjs` is a working reference implementation of the derivation.
- **Exact arithmetic end to end.** Probabilities and money are BigInt rationals;
  the only rounding is a single floor at each credit, in integer minor units
  (`1 credit = 10^6 units`), which costs under `2e-5` of a 1-credit stake per
  round.
- **No latency-sensitive decisions.** Nothing in SWARM is timed. A slow
  connection cannot cost you a payout.

---

## Repository map

| Path | What it is |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | Product spec: loop, decisions, bets, portrait UX flow, art and sound direction, responsible-design rules |
| [docs/MATH.md](docs/MATH.md) | Exact model, paytable, RTP justification, volatility, caps, strategy proof |
| [docs/ENGINE.md](docs/ENGINE.md) | The `staged-survival` Reveal Engine module and the adapter surface SWARM expects |
| `tools/enumerate.mjs` | Exhaustive exact enumeration — the proof behind every number |
| `tools/simulate.mjs` | Seeded Monte Carlo cross-check and reference draw derivation |
| `spec/paytable.v1.json` | Frozen canonical paytable fixture |
| `tests/` | Vitest suite: re-derives the paytable and asserts the documentation matches it |

---

SWARM — Powered by Reveal Engine™ — An Axiom Games original.
Reveal Engine™ is technology, SWARM is a title, Axiom Games is the studio. The ™
symbol is not a registered-trademark claim. This repository is private,
`UNLICENSED` and unpublished.
