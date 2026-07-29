# SWARM — exact mathematics

Every number in this document is produced by `tools/enumerate.mjs` using exact
BigInt rational arithmetic over the complete outcome space. No number here comes
from a simulation, a float, or a fit. The tables between
`<!-- generated:... -->` markers are compared byte for byte against the
enumeration by `tests/docs-match-enumeration.test.mjs`, so this document cannot
drift from the model.

Reproduce everything with:

```sh
npm run enumerate            # full report
npm run paytable:check       # byte-compare the frozen fixture
npm test                     # re-derive and assert every published number
```

- **Adapter identity** `swarm-colony-v1 @ 1.0.0`
- **Paytable schema** `swarm/paytable-v1`
- **Frozen fixture** `spec/paytable.v1.json`, sha256
  `93ecb5400066fa964e9c5c2836cb7f283b18762b9571880aa3f6d529cdaefb4d`

---

## 0. Headline

<!-- generated:headline -->
| Quantity | Exact value |
| --- | --- |
| Target RTP, every bet type | `19/20` = 95.0000% |
| Total probability mass | `1/1` |
| Terminal states enumerated | 267 |
| Decision states proven | 255 |
| Actions proven to tie | 2295 |
| Largest single settlement | `72479248046875/137438953472` = 527.355936x |
| Probability of that settlement | 4.46239e-17 |
| Largest total one round can credit | `373466920422265/412316860416` = 905.776494x |
| Declared max-win multiple | 906x (never binds) |
| FULL BLOOM frequency | 1 in 22217.97 |
| Expected generations per RUN round | 5.85032978 |
| Draw grid per round | 270 draws |
<!-- /generated:headline -->

---

## 1. The state space

A round is a truncated Galton-Watson branching process with a player-controlled
stopping and thinning rule.

**Colony.** `N(t)` is the number of organisms alive immediately after generation
`t` resolves. The round starts with `N(0) = 3` seeded organisms.

**Generations.** A round resolves at most `G = 18` generations. Generation 1 is
mandatory: the player has no decision before it.

**FULL BLOOM.** If a generation produces `N(t) >= 16`, the round force-settles
immediately at the colony's exact value. 16 is therefore a *stopping* threshold,
not a clip: no organism and no value is ever discarded.

**Populations.** A decision state has `1 <= n <= 15`. Because each organism
produces at most 2 offspring, a resolved generation can hold at most
`2 * 15 = 30` organisms, so `30` bounds the state space exactly.

**Terminal states.** `EXTINCT` (`n = 0`), `BLOOM` (`n >= 16`), `FINAL`
(`t = 18`). Enumeration finds 267 of them and their probabilities sum to exactly
`1/1`.

**Draw grid.** The round consumes at most `18 x 15 = 270` draws, one per
organism per generation, each uniform on `{0, ..., 19}`. The grid is fixed by
the committed seed before the round starts (docs/ENGINE.md).

**Decision states.** `17 generations x 15 populations = 255`. At a decision
state with `n` organisms there are `n + 1` legal actions (harvest
`k = 0 ... n`), which is `2295` actions in total. Every one of them is proven to
have identical exact value in section 6.

### 1.1 Formal round rules

```
t := 0 ; n := 3 ; banked := 0
loop t := t + 1 :
    n := sum over slots j = 1..n of children(draw(t, j))        # resolve
    if n = 0                      -> settle EXTINCT, pay banked
    if n >= 16                    -> banked += c(t) * n ; settle BLOOM
    if t = 18                     -> banked += c(t) * n ; settle FINAL
    k := player action in {0..n}                                # decide
    banked += c(t) * k ; n := n - k
    if n = 0                      -> settle BANKED
```

`children(d) = 0` for `d <= 7`, `1` for `8 <= d <= 15`, `2` for `d >= 16`.
`HARVEST` in the client is `k = floor(n / 2)`; `BANK` is `k = n`; `CONTINUE` is
`k = 0`. The protocol accepts every `k` in range and the proof covers every `k`,
so a future client button (`HARVEST ONE`, `HARVEST TWO THIRDS`) needs no new
mathematics.

**Slot discipline.** After each resolution the colony is compacted into slots
`1 ... n`, and a harvest removes the highest-numbered slots. The consequence is
that the future depends only on the *count* of organisms, never on which
organisms were harvested — which is what keeps the state space `(t, n)` exact
and the paytable finite.

---

## 2. The offspring model

Each organism, independently, consumes exactly one draw:

<!-- generated:offspring -->
| Outcome | Children | Draw band | Probability | Percent |
| --- | --- | --- | --- | --- |
| **DIE** | 0 | `0-7` | `2/5` | 40.00% |
| **HOLD** | 1 | `8-15` | `2/5` | 40.00% |
| **SPLIT** | 2 | `16-19` | `1/5` | 20.00% |
<!-- /generated:offspring -->

- Mean offspring `mu = E[X] = 2/5 + 2 * 1/5 = 4/5`.
- `E[X^2] = 2/5 + 4/5 = 6/5`, so `Var(X) = 6/5 - 16/25 = 14/25 = 0.56`.
- The colony is **subcritical** (`mu < 1`): it shrinks in expectation. That is
  deliberate, and section 4 shows it is exactly what makes the multiplier climb.

**A structural fact worth stating plainly.** With three outcomes and mean `mu`,
the death probability satisfies

```
P(DIE) = (1 - mu) + P(SPLIT)
```

so splits can never be more common than deaths in any subcritical configuration.
The design cannot promise a colony that usually grows; it can only promise that
growth, when it happens, is worth a lot. Section 9 turns that into an RTP.

---

## 3. Lemma 1 — partial harvest forces a linear multiplier

Let `m(n)` be the value, in stake units, of a colony of `n` organisms at a fixed
generation. HARVEST splits a colony of `n` into a credited part `k` and a
surviving part `n - k`.

**Claim.** If harvesting is value-conserving — the credited amount plus the
value of what remains equals the value of what you had — then `m(n) = c * n`.

**Proof.** Conservation says `m(n) = m(k) + m(n - k)` for all `0 <= k <= n`,
with `m(0) = 0`. Taking `k = 1` and inducting on `n` gives
`m(n) = m(n - 1) + m(1) = n * m(1)`. Set `c = m(1)`. ∎

If value were not conserved at a harvest, one of two things would be true: either
harvesting in two steps pays more than harvesting in one step (a strategy that
beats the RTP), or the game silently confiscates value when a player uses its
signature mechanic. Linearity is not a modelling convenience here; it is forced
by the mechanic.

---

## 4. Lemma 2 — the ladder step is exactly `1 / mu`

Write the colony value at generation `t` as `V(t) = c(t) * N(t)`.

**Claim.** `V` is a martingale across a generation if and only if
`c(t + 1) * mu = c(t)`, i.e. `c(t) = c(1) * (1/mu)^(t - 1)`.

**Proof.** Given `N(t) = n`, the next population is a sum of `n` i.i.d. offspring
variables, so `E[N(t + 1) | N(t) = n] = mu * n`. Then
`E[V(t + 1) | N(t) = n] = c(t + 1) * mu * n`, which equals `c(t) * n` for all `n`
exactly when `c(t + 1) * mu = c(t)`. ∎

With `mu = 4/5` the ladder step is `5/4`: **every organism is worth exactly 25%
more each generation it survives.** The colony shrinks at exactly the rate the
per-organism value grows, and the two cancel to the last bit.

<!-- generated:ladder -->
| Generation | Organism value `c(t)` (exact) | Decimal | Colony of 3 | Colony of 16 |
| --- | --- | --- | --- | --- |
| 1 | `19/48` | 0.395833 | 1.187500 | 6.333333 |
| 2 | `95/192` | 0.494791 | 1.484375 | 7.916666 |
| 3 | `475/768` | 0.618489 | 1.855468 | 9.895833 |
| 4 | `2375/3072` | 0.773111 | 2.319335 | 12.369791 |
| 5 | `11875/12288` | 0.966389 | 2.899169 | 15.462239 |
| 6 | `59375/49152` | 1.207987 | 3.623962 | 19.327799 |
| 7 | `296875/196608` | 1.509984 | 4.529953 | 24.159749 |
| 8 | `1484375/786432` | 1.887480 | 5.662441 | 30.199686 |
| 9 | `7421875/3145728` | 2.359350 | 7.078051 | 37.749608 |
| 10 | `37109375/12582912` | 2.949188 | 8.847564 | 47.187010 |
| 11 | `185546875/50331648` | 3.686485 | 11.059455 | 58.983763 |
| 12 | `927734375/201326592` | 4.608106 | 13.824319 | 73.729703 |
| 13 | `4638671875/805306368` | 5.760133 | 17.280399 | 92.162129 |
| 14 | `23193359375/3221225472` | 7.200166 | 21.600499 | 115.202662 |
| 15 | `115966796875/12884901888` | 9.000207 | 27.000623 | 144.003327 |
| 16 | `579833984375/51539607552` | 11.250259 | 33.750779 | 180.004159 |
| 17 | `2899169921875/206158430208` | 14.062824 | 42.188474 | 225.005199 |
| 18 | `14495849609375/824633720832` | 17.578531 | 52.735593 | 281.256499 |
<!-- /generated:ladder -->

The last column is the FULL BLOOM floor: the smallest payout a bloom can produce
at that generation.

---

## 5. The entry price is the entire house edge

Extend the ladder backwards by one step to the moment of purchase:

```
c(0) = c(1) * mu = (19/48) * (4/5) = 19/60
V(0) = 3 * c(0) = 3 * 19/60 = 19/20
```

**You pay 1 stake for a colony worth exactly `19/20` of a stake.** After that
single transaction, nothing takes another cut: every generation, every harvest
and every settlement is exactly value-conserving. `c(1) = 19/48` is not a free
parameter, it is `RTP / (3 * mu)`.

Generation 1 is mandatory and resolves without any decision, which makes the
statement above operational: the player's first decision happens *after* the
edge has already been taken, so no decision can be blamed for it and no decision
can recover it.

<!-- generated:generation-one -->
| Population | Probability (exact) | Percent | Colony multiplier (exact) | Decimal |
| --- | --- | --- | --- | --- |
| 0 | `8/125` | 6.4000% | `0/1` | 0.000000 |
| 1 | `24/125` | 19.2000% | `19/48` | 0.395833 |
| 2 | `36/125` | 28.8000% | `19/24` | 0.791666 |
| 3 | `32/125` | 25.6000% | `19/16` | 1.187500 |
| 4 | `18/125` | 14.4000% | `19/12` | 1.583333 |
| 5 | `6/125` | 4.8000% | `95/48` | 1.979166 |
| 6 | `1/125` | 0.8000% | `19/8` | 2.375000 |
<!-- /generated:generation-one -->

Check: `sum p * multiplier = (19/48) * E[N(1)] = (19/48) * (12/5) = 19/20`.

---

## 6. The invariance theorem

**Theorem.** Let `pi` be any decision policy: any function, deterministic or
randomized, of everything the player has observed so far (generation index,
current and past populations, its own past harvests, wall-clock time, mood).
Then the expected total credit of a round played under `pi` is exactly `19/20`
per unit staked.

**Proof.** Define the wealth process `W(t) = banked(t) + c(t) * N(t)`.

1. `W(0) = 0 + 3 * c(0) = 19/20`.
2. A harvest of `k` moves `c(t) * k` from the colony term into the banked term
   and changes nothing else (Lemma 1): `W` is unchanged, pathwise.
3. A generation transition satisfies `E[W(t + 1) | F(t)] = W(t)` (Lemma 2),
   because the draws of generation `t + 1` are independent of `F(t)`, the
   information the policy is allowed to use.
4. Every terminal rule pays exactly the colony term: `EXTINCT` pays `c(t) * 0`,
   `BLOOM` and `FINAL` pay `c(t) * N(t)`. No terminal rule truncates.
5. The round stops by generation 18 and `0 <= W <= 906`, so optional stopping
   applies to any stopping time and any adapted thinning rule.

Therefore `E[total credit] = W(0) = 19/20`. ∎

**Machine check.** The theorem is also verified by exhaustive backward induction
in `proveStrategyInvariance()`: for every one of the **255** decision states the
tool computes the exact value of every one of the **2295** legal actions and
asserts (a) each action's value equals `c(t) * n` exactly, (b) the maximum over
actions equals `c(t) * n` exactly, and (c) the continuation value of `j`
organisms equals `c(t) * j` exactly. Mismatches found: **0**. Optimal-play RTP:
`19/20`.

Eight materially different policies are then evaluated independently by exact
backward induction — including one that banks immediately, one that never banks,
one that harvests half every generation, and two threshold rules — and all eight
return exactly `19/20`:

<!-- generated:policies -->
| Policy | Exact RTP | Standard deviation | Hit rate | Description |
| --- | --- | --- | --- | --- |
| `BANK_FIRST` | `19/20` | 0.513058 | 0.9360000000 | Bank at generation 1 |
| `RUN` | `19/20` | 7.569291 | 0.0224631637 | Never harvest, ride to the end |
| `HALF_EVERY` | `19/20` | 1.453021 | 0.8080000219 | Harvest half every generation |
| `STOP_AT_2X` | `19/20` | 1.350584 | 0.3430951770 | Bank everything at 2.00x or better |
| `STOP_AT_10X` | `19/20` | 3.453276 | 0.0729125643 | Bank everything at 10.00x or better |
| `HALF_AT_2X` | `19/20` | 2.350899 | 0.3402336255 | Harvest half whenever value is 2.00x or better |
| `BANK_AT_GEN_5` | `19/20` | 1.469801 | 0.4165582060 | Bank everything at generation 5 |
| `PANIC` | `19/20` | 2.711665 | 0.8902420631 | Bank whenever the colony shrank below 3, else run |
<!-- /generated:policies -->

Standard deviations are truncated decimals of the exact variance (a square root
is generally irrational; the variance itself is published exactly in the
fixture). Hit rate is `1 - P(total credit = 0)`.

### 6.1 What the theorem does not say

- **It does not say choices are meaningless.** Harvesting changes how many draws
  the colony consumes, so it changes what actually happens next, and it changes
  the entire shape of the payout distribution — standard deviation ranges from
  0.51 to 7.56 across the policies above, a factor of 14. Choices move risk, not
  return. That is the design goal, stated precisely.
- **It does not survive a leaked seed.** A player who could read the committed
  grid before deciding would beat 19/20 trivially. The theorem assumes the
  policy is adapted to the revealed history only; the commit-reveal scheme in
  docs/ENGINE.md is what makes that assumption true in practice, and the seed
  must never be released before settlement.
- **It does not cover a clipping cap.** It requires the declared max-win
  multiple to sit above every reachable total. Section 11 proves it does.

---

## 7. Bet types

### 7.1 COLONY — the base bet

Stake `S` buys the colony described above. Credits are `floor(S * c(t) * k)` at
each harvest and at settlement, in integer minor units (section 12). Theoretical
RTP: exactly `19/20`, for every policy, by section 6.

### 7.2 Side bets

Side bets are optional, resolve on the **wild line** — the colony as it would
have grown had it never been harvested — and are therefore completely
independent of the player's decisions. The wild line is a deterministic function
of the committed draw grid alone, so a side bet cannot be moved by play, and it
equals the player's own colony exactly whenever they never harvest.

Each side bet is priced at exactly the target RTP by construction:
`multiplier = (19/20) / probability`. Multipliers are therefore exact rationals,
not rounded decimals; a client displays the value truncated toward zero, so the
credited amount is never below the displayed multiplier times the stake.

<!-- generated:sidebets -->
| Bet | Resolves on | Probability | One in | Multiplier (exact) | Multiplier | RTP |
| --- | --- | --- | --- | --- | --- | --- |
| **FIRST LIGHT** | The wild line holds 4 or more organisms after generation 1. | `1/5` | 5.00 | `19/4` | 4.750000x | `19/20` |
| **DARK VENT** | The wild line is extinct at or before generation 3. | `168434389083176/476837158203125` | 2.83 | `1811981201171875/673737556332704` | 2.689446x | `19/20` |
| **SWARM** | The wild line reaches 10 or more organisms during the round. | sha256 `d7ef65f76db5ecfc` | 261.89 | sha256 `c0b3977dacfceed6` | 248.798505x | `19/20` |
<!-- /generated:sidebets -->

Exact values longer than 44 characters are published as the SHA-256 of their
canonical `numerator/denominator` string; the full 200-digit fractions are in
`spec/paytable.v1.json`. `FIRST LIGHT` is exactly `1/5` and pays exactly `19/4`,
which is a coincidence of the chosen weights and a useful sanity anchor.

`DARK VENT` is a hedge on your own colony dying early. It is priced at the same
RTP as everything else, so covering the base bet with it is neither clever nor
punished: two 95% bets combine to a 95% return.

---

## 8. The shape of the distribution

Survival of the colony under RUN (no harvesting):

<!-- generated:survival -->
| After generation | P(colony alive) |
| --- | --- |
| 1 | 0.9360000000 |
| 2 | 0.7925253120 |
| 3 | 0.6467674840 |
| 4 | 0.5205090154 |
| 5 | 0.4165567777 |
| 6 | 0.3326275761 |
| 7 | 0.2654111063 |
| 8 | 0.2117576654 |
| 9 | 0.1689812877 |
| 10 | 0.1348843188 |
| 11 | 0.1077000060 |
| 12 | 0.0860187757 |
| 13 | 0.0687194206 |
| 14 | 0.0549108631 |
| 15 | 0.0438848016 |
| 16 | 0.0350778765 |
| 17 | 0.0280416713 |
| 18 | 0.0224189887 |
<!-- /generated:survival -->

How rounds end under RUN:

<!-- generated:categories -->
| Terminal | Probability | Meaning |
| --- | --- | --- |
| EXTINCT | 0.9775368362 | Every organism died; unharvested value is zero |
| BLOOM | 0.000045008608 (1 in 22217.97) | Population reached the FULL BLOOM threshold and force-settled |
| FINAL | 0.0224181551 | Colony survived to the last generation and force-settled |
<!-- /generated:categories -->

Payout tail under RUN. RUN is the extreme end of the risk curve: it pays nothing
97.75% of the time and pays at least 17.57x whenever it pays at all, because the
smallest surviving colony at generation 18 is one organism worth `c(18)`.

<!-- generated:tail -->
| Payout at least | Probability | One in |
| --- | --- | --- |
| 1x | 2.24631e-02 | 44.51 |
| 2x | 2.24631e-02 | 44.51 |
| 5x | 2.24631e-02 | 44.51 |
| 10x | 2.24630e-02 | 44.51 |
| 25x | 1.46397e-02 | 68.30 |
| 50x | 7.92072e-03 | 126.25 |
| 100x | 1.18260e-03 | 845.58 |
| 250x | 2.09336e-06 | 477699.99 |
| 500x | 1.38334e-15 | 722887390391809.47 |
<!-- /generated:tail -->

How often the colony grows to a given size at any point in the round:

<!-- generated:reach -->
| Peak population at least | Probability | One in |
| --- | --- | --- |
| 4 | 3.47528e-01 | 2.87 |
| 6 | 7.87652e-02 | 12.69 |
| 8 | 1.71319e-02 | 58.37 |
| 10 | 3.81835e-03 | 261.89 |
| 12 | 8.62437e-04 | 1159.50 |
| 14 | 1.96449e-04 | 5090.36 |
| 16 | 4.50086e-05 | 22217.97 |
<!-- /generated:reach -->

One round in three grows to 4 organisms; one in 12 reaches 6; one in 22,218
blooms. Those frequencies are not tuned by taste — with an exactly fair value
process, the probability of reaching a size is pinned by what that size is
worth.

---

## 9. Why 95%

- **Band.** 94–97% is the working band for instant/crash-style titles; 95% sits
  mid-band, leaving 5% operator margin.
- **Exactness.** `19/20` keeps the entry price `c(1) = 19/48` and every
  generation-1 probability a short rational (`8/125`, `24/125`, ...), which is
  why this document can print exact fractions instead of rounded decimals.
- **No skill gap.** The usual regulatory concern with a decision game is that
  the advertised RTP assumes optimal play while the average player does worse.
  Here the enumeration proves optimal-play RTP and worst-play RTP are the *same
  number*. 95% is the return for the best player, the worst player, and the
  player who taps at random. There is no "theoretical vs practical" gap to
  disclose because there is no gap.
- **Rounding.** Floor rounding at the credit boundary costs at most one minor
  unit per credit event; with 10^6 minor units per credit and at most 18 credit
  events, payable RTP is below theoretical RTP by less than `1.8e-5` credits per
  round, i.e. under `2e-5` of a 1-credit stake (section 12).

---

## 10. Volatility profile

The base bet is a *volatility dial*, not a fixed profile. From the policy table:

| Style | Policy | SD | Hit rate | Feel |
| --- | --- | --- | --- | --- |
| Low | `BANK_FIRST` | 0.51 | 93.6% | Grinding, near-flat, one decision |
| Medium | `HALF_EVERY` | 1.45 | 80.8% | Frequent small credits, long tail kept alive |
| Medium-high | `HALF_AT_2X` | 2.35 | 34.0% | Locks a profit, rides the rest |
| High | `STOP_AT_10X` | 3.45 | 7.3% | Rare, chunky wins |
| Extreme | `RUN` | 7.56 | 2.2% | Lottery: nothing, or 17.57x and up |

For reference, a standard-volatility slot sits near SD 3–6 per spin; `RUN` is
above that band and `BANK_FIRST` far below it. The important property is that
the RTP column is constant at `19/20` across all of them: the player chooses
variance, never expectation.

Expected round length under RUN is `5.85032978` generations; policies that bank
early are shorter, which matters for session pacing (docs/DESIGN.md).

---

## 11. Caps, and why the cap never binds

Three different maxima matter, and conflating them is a classic way to publish a
wrong max-win number.

1. **Largest single settlement** — `72479248046875/137438953472 = 527.355936x`,
   at generation 18 with 30 organisms, probability `4.46239e-17`.
2. **Largest total one round can credit** —
   `373466920422265/412316860416 = 905.776494x`. This is *larger* than the
   largest settlement, because a player who harvests the overflow to keep the
   colony just under the FULL BLOOM threshold can farm the ladder for many
   generations instead of force-settling once. It is computed by an exact
   deterministic dynamic program (`maximumRoundPayout()`) that maximizes over
   every harvest policy and every draw grid simultaneously.
3. **Declared max-win multiple** — `906x`, the smallest integer strictly above
   (2), applied to the cumulative credit of a round.

Because `906 > 905.776494...` and credits are floored, the cap provably never
truncates a payout. That is the point: a cap that can bite would break the
invariance theorem (it would make late continuation worth less than its fair
value and hand the player a reason to stop that the paytable does not price).
`assertRiskPolicy()` re-derives this from the model on every test run, so any
future change to the offspring weights, the ladder, the generation count or the
bloom threshold that would push a reachable total over the cap fails the build.

The largest side-bet payout is `248.798505x`, comfortably inside the same cap.

**Design note.** Fact (2) is also the most interesting strategic property of the
game: partial harvest is the only way to reach the highest totals, because it is
the only way to keep a colony alive under the bloom threshold while the ladder
climbs. It still does not change the expectation — it changes which tail you are
buying.

---

## 12. The payable boundary

- Money is integer **minor units**; the reference configuration uses
  `1 credit = 1,000,000 units`. Stakes are bounded to
  `[100,000, 1,000,000,000]` units (0.1 to 1,000 credits).
- Every credit event pays `floor(exact rational)` units, so
  `0 <= theoretical - credited < 1` unit at each event, and the round total is
  short of theoretical by less than the number of credit events (at most 18
  units = `1.8e-5` credits).
- The cap is applied with the original stake as the basis and the already
  credited amount subtracted, exactly as `payableWithinCap()` does in the
  engine. It never binds (section 11), but it is applied anyway so that a
  configuration error cannot silently overpay.
- Nothing in the payable path uses a float. `payableUnits()` in
  `tools/lib/model.mjs` is the reference implementation and is tested against
  hostile inputs (zero and negative stakes, non-BigInt stakes, absurd
  multipliers).

---

## 13. Reproducing every number

| Claim | Command |
| --- | --- |
| Total mass is exactly 1, RTP exactly 19/20 | `npm run enumerate` (section 5 of the report) |
| Every action at every state ties | `npm run enumerate` (section 9 of the report) |
| Eight policies all return 19/20 | `npm run enumerate` (section 8 of the report) |
| Published tables equal the model | `npm test` |
| Frozen fixture is byte-identical | `npm run paytable:check` |
| Simulation agrees with enumeration | `npm run simulate` |
| Every terminal state and its probability | `npm run enumerate:terminals` |

The Monte Carlo simulator exists only as a cross-check on the written rules; it
never sources a published number. At 50,000 deterministic rounds under RUN it
returns an empirical RTP of 0.965665 against the exact 0.95 (0.46 standard
errors) and a mean round length of 5.8415 against the exact 5.85032978.

---

## 14. What is not claimed

This is engineering evidence for a free-play prototype specification, not a
certification. No RNG certification, no laboratory approval, no jurisdictional
analysis, and no production RTP measurement exists for SWARM. The exactness
claims in this document are claims about *this model and this code*: that the
published paytable is the enumerated paytable, that the arithmetic is exact, and
that the strategy proof is exhaustive over the declared state space. Deploying
this game for real money would require independent RNG and seed-custody review,
an operator wallet and idempotency audit, jurisdictional review, and whatever
laboratory process applies — none of which this repository performs or replaces.
