# SWARM — exact mathematics

Every number in this document is produced by `tools/enumerate.mjs` using exact
BigInt rational arithmetic over the complete outcome space. No number here comes
from a simulation, a float, or a fit. The tables between
`<!-- generated:... -->` markers are written by `tools/syncdocs.mjs` and compared
byte for byte against the enumeration by `tests/docs-match-enumeration.test.mjs`,
so this document cannot drift from the model.

Reproduce everything with:

```sh
npm run enumerate            # full report
npm run paytable:check       # byte-compare the frozen fixture
npm run docs:check           # every generated table in every document is current
npm test                     # re-derive and assert every published number
```

<!-- generated:identity -->
| Identity | Value |
| --- | --- |
| Adapter | `swarm-colony-v1` @ `1.3.0` |
| Paytable schema | `swarm/paytable-v3` |
| Frozen fixture | `spec/paytable.v3.json` |
| Fixture sha256 | `d1f494ffb707067a779bd7c05470dfe955599f20b2bb51647ca62d9d416dbbfe` |
<!-- /generated:identity -->

---

## 0. Headline

<!-- generated:headline -->
| Quantity | Exact value |
| --- | --- |
| Theoretical target RTP before payable floors, every bet type | `19/20` = 95.0000% |
| Total probability mass | `1/1` |
| Terminal states enumerated | 267 |
| Decision states proven | 255 |
| Actions proven to tie | 2295 |
| Largest single settlement | `72479248046875/137438953472` = 527.355936x |
| Probability of that settlement | 4.46239e-17 |
| Largest total the COLONY line can credit | `373466920422265/412316860416` = 905.776494x |
| Declared COLONY cap, on the colony stake | 906x (proven never to bind) |
| Worst-case ticket liability at the stake bounds | 931,700 credits, admitted below 1,000,000 |
| FULL BLOOM frequency, never-harvest play (`RUN`) | 1 in 22217.97 |
| FULL BLOOM frequency, the one-tap default harvest (`HALF_EVERY`) | **never** — halving the colony caps it below the threshold |
| FULL BLOOM payout range | 9.895833x to 527.355936x, median 37.749608x |
| Standard deviation, proven interval over every policy | 0.513058 to 7.569363 |
| Rounds left below the stake by the mandatory generation 1 | `68/125` = 54.40% |
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
`CONTINUE` is `k = 0`, `BANK` is `k = n`, and `HARVEST` is any `k` strictly
between them — the client's one-tap default is `floor(n / 2)` and its stepper
reaches every other value (`docs/DESIGN.md` §4.3). The protocol accepts every
`k` in range, the proof covers every `k`, and section 11's published volatility
maximum is attained at `k = 1`, so the client has to be able to express it.

**One `k` per generation, and why that is a rule rather than a modelling
convenience.** The line `k := player action in {0..n}` is consulted exactly once
per resolved generation: the decision at a generation is a single choice of `k`
on the continuum from `CONTINUE` to `BANK`, and committing it closes that
generation's decision (`docs/ENGINE.md` §5.3). Round 3 wrote this model and let
the command surface accept a second harvest at the same generation, which cost
nothing in expectation — `c(t)k₁ + c(t)k₂ = c(t)(k₁ + k₂)` — and broke two other
things: the transcript stopped being one entry per generation, which the
published verifier assumes, and section 13's rounding bound stopped being true.
Section 13 states the rule, proves it never costs the player anything, and
prices the alternative exactly.

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
growth, when it happens, is worth a lot. Section 10 turns that into an RTP.

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
harvesting in two steps pays more than harvesting in one step (a decision rule
that beats the RTP), or the game silently confiscates value when a player uses
its signature mechanic. Linearity is not a modelling convenience here; it is
forced by the mechanic.

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

**A martingale is not a monotone process.** `V` is fair in expectation across a
generation and still falls about half the time — the value rises exactly when
`5 * N(t+1) > 4 * N(t)`, so a colony that shrinks by more than 20% is worth less
than it was, however many organisms split on the way. Section 9 enumerates that
and turns it into two binding design constraints.

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
Then the expected total *theoretical* payout of a round played under `pi` is
exactly `19/20` per unit staked.

"Theoretical" is doing precise work here, not hedging: the theorem is a
statement about the exact rational value the paytable owes. What a wallet
actually credits is that value floored to integer minor units at each credit
event, which is below it by less than one unit per event — section 13 bounds the
gap, and it is the only quantity in this document that is not policy-invariant.

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

Therefore `E[total theoretical payout] = W(0) = 19/20`. ∎

**Machine check.** The theorem is also verified by exhaustive backward induction
in `proveStrategyInvariance()`: for every one of the **255** decision states the
tool computes the exact value of every one of the **2295** legal actions and
asserts (a) each action's value equals `c(t) * n` exactly, (b) the maximum over
actions equals `c(t) * n` exactly, and (c) the continuation value of `j`
organisms equals `c(t) * j` exactly. Mismatches found: **0**. Optimal-play
theoretical RTP before payable floors: `19/20`.

Eight materially different policies are then evaluated independently by exact
backward induction — including one that banks immediately, one that never banks,
one that harvests half every generation, and two threshold rules — and all eight
return exactly `19/20` in theoretical rational value before §13's payable floors:

<!-- generated:policies -->
| Policy | Exact theoretical RTP | Standard deviation | Profit rate `P(>stake)` | Hit rate `P(>0)` | Description |
| --- | --- | --- | --- | --- | --- |
| `BANK_FIRST` | `19/20` | 0.513058 | 0.4560000000 | 0.9360000000 | Bank at generation 1 |
| `RUN` | `19/20` | 7.569291 | 0.0224631637 | 0.0224631637 | Never harvest, ride to the end |
| `HALF_EVERY` | `19/20` | 1.453021 | 0.3075713875 | 0.8080000219 | Harvest half every generation |
| `STOP_AT_2X` | `19/20` | 1.350584 | 0.3430951770 | 0.3430951770 | Bank everything at 2.00x or better |
| `STOP_AT_10X` | `19/20` | 3.453276 | 0.0729125643 | 0.0729125643 | Bank everything at 10.00x or better |
| `HALF_AT_2X` | `19/20` | 2.350899 | 0.2861157144 | 0.3402336255 | Harvest half whenever value is 2.00x or better |
| `BANK_AT_GEN_5` | `19/20` | 1.469801 | 0.2710879003 | 0.4165582060 | Bank everything at generation 5 |
| `PANIC` | `19/20` | 2.711665 | 0.1712991168 | 0.8902420631 | Bank whenever the colony shrank below 3, else run |
<!-- /generated:policies -->

Standard deviations are truncated decimals of the exact variance (a square root
is generally irrational; the variance itself is published exactly in the
fixture).

**Two different questions, two different columns.** The *hit rate* is
`P(total credit > 0)` and the *profit rate* is `P(total credit > stake)`. They
are not the same number and the gap is not small: `BANK_FIRST` returns something
93.60% of the time and returns more than the stake 45.60% of the time, because
populations of 1 and 2 pay `0.3958x` and `0.7916x`. A returned fraction of a
stake is a loss. Wherever this repository ranks a policy it leads with the
profit rate, and any published "hit rate" must appear next to it, never instead
of it.

### 6.1 What the theorem does not say

- **It does not say choices are meaningless.** Harvesting changes how many draws
  the colony consumes, so it changes what actually happens next, and it changes
  the entire shape of the payout distribution — the proven standard-deviation
  interval spans a factor of 14 (section 11). Choices move risk, not return.
  That is the design goal, stated precisely.
- **It does not survive a leaked seed, and side-bet display is part of that.**
  The theorem assumes the policy is adapted to the revealed history only. Section
  7.3 shows that revealing the side bets' wild line ahead of the player's own
  colony leaks future draws and hands the player a strictly winning move, so the
  reveal rule there is a condition of this theorem, not a UI preference.
- **It does not cover a clipping cap.** It requires each line's declared max-win
  multiple to sit above every total that line can reach. Section 12 proves that,
  per line, and explains why a single cap shared across the ticket would break
  the theorem instead of protecting it.

---

## 7. Bet types

A ticket is one **COLONY** bet plus zero to three optional side bets. Every bet
on the ticket carries **its own stake, its own cap basis and its own 95%
theoretical RTP before payable floors**; no
bet's payout is charged against another bet's ceiling. The engine surface for
this is `docs/ENGINE.md` §5.

### 7.1 COLONY — the base bet

Stake `S` buys the colony described above. Credits are `floor(S * c(t) * k)` at
each harvest and at settlement, in integer minor units (section 13). Theoretical
Theoretical RTP before payable floors: exactly `19/20`, for every policy, by
section 6.

### 7.2 Side bets

Side bets are optional, resolve on the **wild line** — the colony as it would
have grown had it never been harvested — and are therefore completely
independent of the player's decisions. The wild line is a deterministic function
of the committed draw grid alone, so a side bet cannot be moved by play, and it
equals the player's own colony exactly whenever they never harvest.

Each side bet is priced at exactly the theoretical target RTP before payable
flooring, by construction:
`multiplier = (19/20) / probability`. Multipliers are therefore exact rationals,
not rounded decimals; a client displays the value truncated toward zero, so the
credited amount is never below the displayed multiplier times the stake.

<!-- generated:sidebets -->
| Bet | Resolves on | Probability | One in | Multiplier (exact) | Multiplier | Own cap | Theoretical RTP before payable floors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **FIRST LIGHT** | The wild line holds 4 or more organisms after generation 1. | `1/5` | 5.00 | `19/4` | 4.750000x | 5x | `19/20` |
| **DARK VENT** | The wild line is extinct at or before generation 3. | `168434389083176/476837158203125` | 2.83 | `1811981201171875/673737556332704` | 2.689446x | 3x | `19/20` |
| **SWARM** | The wild line reaches 10 or more organisms during the round. | sha256 `d7ef65f76db5ecfc` | 261.89 | sha256 `c0b3977dacfceed6` | 248.798505x | 249x | `19/20` |
<!-- /generated:sidebets -->

Exact values longer than 44 characters are published as the SHA-256 of their
canonical `numerator/denominator` string; the full 200-digit fractions are in
`spec/paytable.v3.json`, under `sideBets[].probability` and
`sideBets[].multiplier`. `FIRST LIGHT` is exactly `1/5` and pays exactly `19/4`,
which is a coincidence of the chosen weights and a useful sanity anchor.

Each side bet credits at most once, so the largest amount its line can ever owe
is its own multiplier, and its own cap sits strictly above that (section 12).
Side-bet stakes are bounded on their own line, in `[0.10, 100.00]` credits, and
are independent of the colony stake: because caps are per line, a large side bet
next to a small colony bet is priced and paid exactly, with no interaction.

`DARK VENT` pays when your own colony is most likely to have died, which makes
it *feel* like insurance. It is not sold as insurance and must not be presented
as one: it is an independent bet at the same 95% theoretical RTP before payable
floors, so pairing it with the base bet neither hedges the theoretical house edge
away nor adds one — two such 95% lines combine to 95% theoretical RTP of the
total staked, on a larger total. See `docs/DESIGN.md` §9.4 for the copy rules this
forces.

### 7.3 Exactly when a side bet may be revealed

There is a real leak here and there is a precise boundary to it, and the two are
one generation apart. Getting the boundary right matters in both directions: a
rule one generation too loose breaks the invariance theorem, and a rule one
generation too tight — which is what round 2 shipped — costs a player holding a
`248.798x` bet every scrap of feedback for an entire round.

**Setup.** Write `D(t, s)` for the draw at row `t`, slot `s`. The 270 draws are
independent uniforms, domain-separated in the sampler payload by their counter
(`docs/ENGINE.md` §4.1). `N(t)` is the player's population after generation `t`
and `W(t)` the wild line's; because the wild line never harvests and the player's
organisms occupy a *prefix* of its slots, `N(t) <= W(t)` for every `t`, by
induction on the slot discipline in §1.1.

**Lemma (what is safe).** Fix `t`. `W(t)` is a function of row `t` alone:
`W(t) = sum over s = 1 .. W(t-1) of children(D(t, s))`. The player's future from
a decision at generation `t` consumes rows `t+1 ... 18`, a disjoint set of draws.
Rows are independent, so for any adapted policy `pi`

```
E[ future payout | F(t) , W(1..t) ]  =  E[ future payout | F(t) ]
```

and conditioning on the wild line **through the generation the player has already
resolved** changes nothing the theorem in §6 depends on. Disclosing `W(1..t)` at
a decision at generation `t` is therefore exactly free.

**Lemma (what is not).** `W(t+1)` is a sum over slots `1 ... W(t)` of row `t+1`,
and the player's own `N(t+1)` is a partial sum of *those same draws*, over slots
`1 ... N(t)` with `N(t) <= W(t)`. So:

> If a client shows that the wild line goes from 10 organisms to 0 at generation
> `t + 1` while the player still owes a decision at generation `t`, the player
> has learned that all 10 of those slots produced no children — including the
> slots their own colony occupies. Their colony is certainly extinct next
> generation, `BANK` is now a strictly winning move, and the round no longer
> has a `19/20` theoretical return before payable floors.

**Rule, binding on the protocol and not only the UI:** a response may carry
wild-line state for generation `t` and every earlier generation once the player's
own generation `t` has resolved, and may never carry — or vary its timing with —
wild-line state for a generation the player has not resolved. Side bets are
*resolved and credited* only at settlement, after the base round has reached a
terminal state; what a live frame may carry is the wild population it is already
safe to show (`docs/ENGINE.md` §5.2).

One consequence is worth stating because it reads like a leak and is not. `SWARM`
pays on the wild line's **peak**, and a peak is monotone, so the moment
`W(t) >= 10` the bet is decided and the client may say so. That reveals a
property of rows `1 ... t` only, which the lemma above has already established is
free. The opposite direction — "SWARM cannot win any more" — is *not* knowable
early and the client must not imply it, because it would require knowing that no
later row will reach 10.

### 7.4 What a ticket does, as opposed to what a line does

Theoretical RTP is linear, so it survives being added up: before payable floors,
every line returns exactly `19/20` of its own stake, and therefore any ticket
returns exactly `19/20` of the total staked, at any stake ratio, under any policy.
Section 13 quantifies the strictly downward payable shortfall. That is the whole
of what the RTP argument establishes, and it is the argument
`docs/DESIGN.md` §9.4 uses to defend pairing `DARK VENT` with the base bet.

**The profit rate is not linear, and it is the figure the design makes binding.**
`docs/DESIGN.md` §9.3 rules that any published "how often do I win" number is
`P(return > stake)`. No such number existed for a ticket with more than one line,
and the two lines are anything but independent: side bets resolve on the wild
line, the player's organisms occupy a *prefix* of the wild line's slots (§7.3),
and the two are drawn from the same rows. The joint law is therefore enumerated
exactly — `ticketProfile()` walks `(player population, wild population, banked)`
with that containment as its kernel — for the COLONY bet plus one side bet at
**equal stakes**:

<!-- generated:ticket-pairings -->
| Policy | Ticket | Ticket profit rate | COLONY alone | Change | Ticket returns nothing |
| --- | --- | --- | --- | --- | --- |
| `BANK_FIRST` | COLONY + FIRST LIGHT | 0.2000000000 | 0.4560000000 | -0.2560000000 | 0.0640000000 |
| `BANK_FIRST` | COLONY + DARK VENT | 0.3608881499 | 0.4560000000 | -0.0951118500 | 0.0000000000 |
| `BANK_FIRST` | COLONY + SWARM | 0.0115337091 | 0.4560000000 | -0.4444662908 | 0.0640000000 |
| `HALF_EVERY` | COLONY + FIRST LIGHT | 0.2586550945 | 0.3075713875 | -0.0489162930 | 0.1919999780 |
| `HALF_EVERY` | COLONY + DARK VENT | 0.4568749671 | 0.3075713875 | +0.1493035795 | 0.0204799780 |
| `HALF_EVERY` | COLONY + SWARM | 0.1049361326 | 0.3075713875 | -0.2026352549 | 0.1919999780 |
| `RUN` | COLONY + FIRST LIGHT | 0.2144200454 | 0.0224631637 | +0.1919568816 | 0.7855799545 |
| `RUN` | COLONY + DARK VENT | 0.3756956796 | 0.0224631637 | +0.3532325159 | 0.6243043203 |
| `RUN` | COLONY + SWARM | 0.0248304304 | 0.0224631637 | +0.0023672667 | 0.9751695695 |
<!-- /generated:ticket-pairings -->

Read the `BANK_FIRST` / `DARK VENT` row, because it is the pairing §9.4 flags:
the ticket has `19/20` theoretical RTP before payable floors like everything
else, it can never return nothing, and
it cuts the chance of finishing the round ahead from `0.4560000000` to
`0.3608881499` — 9.5 percentage points — while doubling the amount staked. Under
`RUN` the same pairing moves the same number the other way, from `0.0224631637`
to `0.3756956796`. Both are large, both were invisible, and neither is an RTP.

Three consequences, binding on the client rather than editorial:

- A ticket's profit rate depends on the **stake ratio**, so there is no single
  honest number for an arbitrary one. The table is the equal-stake case;
  `docs/DESIGN.md` §9.3 forbids a combined figure for a ticket whose stakes are
  not equal and requires the per-line profit rates instead.
- It depends on the **policy**, like every other number here that depends on how
  the round is played, so it is published per policy and never as one number.
- A won side bet is a profitable ticket in every row above only because each of
  the three multipliers exceeds a two-line ticket stake. That is checked
  mechanically rather than assumed: `ticketProfile()` refuses to answer at all if
  a future price breaks it.

The boundary is unambiguous here for the same reason it is for a single line:
§13.1 shows no round total can equal a whole number of stakes, so "more than the
ticket stake" and "at least the ticket stake" are the same set on every row.

---

## 8. The shape of the distribution

Survival of the colony under RUN (no harvesting). A colony that has already
force-settled at FULL BLOOM stops being counted as alive in later generations;
the total mass removed that way is `4.50086e-05`, so the curve is a survival
curve and a round-still-open curve to within that figure:

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

How often the **wild line** grows to a given size at any point in the round —
that is, the colony under `RUN`, which is also what every side bet resolves on.
A player who harvests holds a smaller colony than this by construction (§7.3),
so these are frequencies for the grid and for never-harvest play, not for
everybody; §8.2 is the per-policy version:

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

One wild line in three grows to 4 organisms; one in 12 reaches 6; one in 22,218
reaches the FULL BLOOM threshold. Those frequencies are not tuned by taste —
with an exactly fair value process, the probability of reaching a size is pinned
by what that size is worth. What they are *not* is a promise to a player who
harvests: §8.2 enumerates the same event per policy, and the one-tap default puts
it at zero.

**Reach is not a band.** `reach(12)` counts every round that ever holds 12
organisms, including the ones that go on to bloom. The near-miss band — reaches
12 to 15 and never blooms — is `reach(12) - reach(16)`, which is `1 in 1223.34`,
not the `1 in 1159.50` of the reach table. Both numbers are in the fixture and
the design document quotes the band.

### 8.1 What a FULL BLOOM actually pays

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

FULL BLOOM is a *population* event, not a size-of-win event. It can pay less
than one tenth of what its own name suggests: the smallest bloom is 16 organisms
at generation 3, worth `9.895833x`, and 10.36% of all blooms pay less than the
smallest payout a surviving generation-18 colony can produce. Any presentation
that treats every bloom as the game's biggest moment is misrepresenting the
61.60% of them that pay under 50x; `docs/DESIGN.md` §7 scales the celebration to
the settled multiplier instead.

### 8.2 The bloom frequency belongs to a policy, and one of them is zero

Every frequency above is the wild line's — the colony that is never harvested —
and the wild line is a property of the grid. **The player's own colony is not.**
FULL BLOOM is a terminal of the colony the player is actually holding, and
harvesting changes how often that colony reaches 16 organisms.

The one-tap default takes it to exactly zero, and the argument is two lines. With
`j` survivors a generation resolves to at most `2j`; harvesting `floor(m / 2)`
leaves `ceil(m / 2) <= j`. So under `HALF_EVERY` the survivor count never grows
from its generation-1 value of at most 3, the resolved population never exceeds
6, and 16 is unreachable — not rare, unreachable. Enumerated over all eight
published policies, next to how often each one lights the environment reveal
(`docs/DESIGN.md` §7.2), which is keyed to colony *value* and therefore fires on
a bloom and on any frame worth as much:

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

Four of the eight never bloom. The headline `1 in 22217.97` belongs to `RUN`, the
policy that never harvests at all, and `RUN` returns anything whatsoever on only
2.24% of rounds. Publishing that figure unqualified shows a jackpot frequency to
a player for whom the event has probability exactly zero, which is the class of
error `docs/DESIGN.md` §9.3 exists to prevent — so every publication of it in
this repository names the policy it belongs to, and §9.3 requires the client to
do the same.

This is not a defect in the mechanic. Harvesting trades the tail for the middle:
that is what the volatility interval in section 11 *is*, and a player who halves
the colony every generation has chosen a standard deviation of `1.453021` instead
of `7.569291`. What was a defect was publishing the tail's frequency as though it
belonged to everybody.

---

## 9. The value process is not monotone

This section exists because a crash-game mental model — a number that only ever
rises until it dies — is wrong for SWARM, and the difference has consequences
the design has to absorb rather than hide.

### 9.1 A generation can lose money while organisms split

Colony value is `N(t) * c(t)` and `c(t)` climbs exactly 25%, so

```
value rises  <=>  5 * N(t+1) > 4 * N(t)
```

A generation with several splits still loses value if enough organisms died in
the same generation. Exactly how often, by exhaustive enumeration over the
multinomial:

<!-- generated:feedback -->
| Population `n` | P(value falls) | P(falls **and** at least one split) | P(falls **and** two or more splits) | P(at least one split \| value falls) |
| --- | --- | --- | --- | --- |
| 3 | 54.40% | 9.60% | 0.00% | 17.64% |
| 5 | 39.42% | 12.80% | 0.00% | 32.46% |
| 8 | 52.69% | 36.50% | 10.55% | 69.27% |
| 12 | 49.14% | 42.40% | 24.12% | 86.28% |
| 15 | 43.76% | 40.31% | 28.30% | 92.10% |
<!-- /generated:feedback -->

Read the `n = 8` row: 52.69% of generations lose value, and 36.50% of *all*
generations both lose value and contain at least one split. Conditional on the
value falling, at least one split fires 69.27% of the time at `n = 8` and 86.28%
at `n = 12`.

**Consequence, binding on the build.** Feedback intensity may not be keyed to
the event type, because "a split happened" is close to uncorrelated with "you
made money this generation". It must be keyed to the sign and size of the value
change. `docs/DESIGN.md` §6.5 is that rule, and it is derived from this table.

### 9.2 Half of all rounds are underwater before the first decision

Generation 1 is mandatory. It leaves the player below their stake with
probability exactly `68/125 = 54.40%`: `8/125` extinct outright plus `12/25`
alive but worth `0.3958x` or `0.7916x`.

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

From an underwater state, `BANK` crystallises a loss and `CONTINUE` is the only
action that can reach the stake again. That is the canonical loss-chasing
configuration, and roughly half of all rounds are placed in it by a resolution
the player had no decision over.

The mathematics cannot remove this: it is the direct consequence of a subcritical
process with an honest entry price, and every alternative (a supercritical
process, a higher seed count, a shallower ladder) trades it for a worse property.
What the mathematics *can* do is state it exactly, so the product spec has to
answer for it. `docs/DESIGN.md` §9.2 is that answer.

### 9.3 A feedback band has to be reachable, and a ratio band is not

`docs/DESIGN.md` §6.5 keys the verdict beat to `D`, the **signed change in colony
value measured in stake multiples**, and not to the ratio `V(t+1) / V(t)`. That
is not a taste decision. A ratio band above `+50%` is structurally unreachable in
the largest colonies, and round 2 of this specification shipped one that was.

**Why the ratio fails.** A verdict beat exists only where a generation resolves
*without* ending the round: `1 <= m <= 15`, and `t < 18`. Extinction, FULL BLOOM
and generation 18 go to a terminal screen and skip the beat. A ratio above
`+50%` means `5m / 4n > 3/2`, i.e. `m > 1.2n`; at `n = 13` that needs `m >= 16`,
which is FULL BLOOM. So the top ratio band has probability exactly `0.00%` at
`n = 13`, `14` and `15` — silent in exactly the colonies whose gains are largest
— while at `n = 1` it fires on `20.00%` of generations, because tripling a
`0.3958x` position clears the same bar as tripling a `5x` one.

**Why `D` does not.** `D = c(t+1)m - c(t)n = c(t)(5m/4 - n)`, and `c(t)` climbs
25% per generation, so a large absolute gain is reachable from every live
population. The largest gain each population can carry as a verdict beat, and the
first generation at which the large-gain band opens there:

<!-- generated:verdict-reach -->
| Population `n` | Largest non-terminal offspring `m` | Largest `D` a verdict beat can carry | First generation that can reach `D >= 1.00x` |
| --- | --- | --- | --- |
| 1 | 2 | 16.875389x | 5 |
| 2 | 4 | 33.750779x | 2 |
| 3 | 6 | 50.626169x | 2 |
| 4 | 8 | 67.501559x | 2 |
| 5 | 10 | 84.376949x | 2 |
| 6 | 12 | 101.252339x | 2 |
| 7 | 14 | 118.127729x | 2 |
| 8 | 15 | 120.940294x | 2 |
| 9 | 15 | 109.690034x | 2 |
| 10 | 15 | 98.439774x | 2 |
| 11 | 15 | 87.189514x | 2 |
| 12 | 15 | 75.939254x | 2 |
| 13 | 15 | 64.688994x | 2 |
| 14 | 15 | 53.438734x | 2 |
| 15 | 15 | 42.188474x | 2 |
<!-- /generated:verdict-reach -->

Every row reaches the `+1.00x` band, which is what the ratio bands could not
manage, and the enumeration **fails the build** if any row ever stops doing so.

**The chord ladder.** The verdict chord climbs one semitone per `3/2` of gain,
from `+0` at a one-stake gain to `+7` at `(3/2)^7 = 2187/128 = 17.0859375`
stakes. Each note's exact frequency, over the wild-line occupancy — so this
answers "how often does a player hear it", not "how many cells of the state space
contain it":

<!-- generated:chord-ladder -->
| Note | `D` at least | Share of verdict beats | One in | Per round | Reachable from |
| --- | --- | --- | --- | --- | --- |
| +0 | `1/1` = 1.0000000x | 19.39% | 5.15 | 0.94066875 | generation 2, 237 states |
| +1 | `3/2` = 1.5000000x | 12.08% | 8.27 | 0.58628803 | generation 2, 232 states |
| +2 | `9/4` = 2.2500000x | 8.11% | 12.32 | 0.39352677 | generation 2, 226 states |
| +3 | `27/8` = 3.3750000x | 4.84% | 20.62 | 0.23518390 | generation 2, 209 states |
| +4 | `81/16` = 5.0625000x | 2.86% | 34.85 | 0.13917601 | generation 3, 182 states |
| +5 | `243/32` = 7.5937500x | 1.53% | 65.31 | 0.07426139 | generation 5, 152 states |
| +6 | `729/64` = 11.3906250x | 0.76% | 130.48 | 0.03717082 | generation 7, 124 states |
| +7 | `2187/128` = 17.0859375x | 0.29% | 333.88 | 0.01452676 | generation 9, 99 states |
<!-- /generated:chord-ladder -->

A RUN round contains `4.85032978` verdict beats on average — the expected round
length minus its one terminal generation — so a player hears the top note about
once every 69 rounds (`1 / 0.01452676`, an expected count rather than a
probability, though at this frequency the two barely differ). Every step is asserted to have strictly positive probability and at
least one reachable state; `chordLadder()` in `tools/lib/presentation.mjs` throws
`INVALID_PRESENTATION` otherwise, which is the check that was missing when the
old top band went silent.

---

## 10. Why 95%

- **Band.** 94–97% is the working band for instant/crash-style titles; 95% sits
  mid-band, leaving 5% operator margin.
- **Exactness.** `19/20` keeps the entry price `c(1) = 19/48` and every
  generation-1 probability a short rational (`8/125`, `24/125`, ...), which is
  why this document can print exact fractions instead of rounded decimals.
- **No skill gap in the theoretical return.** The usual regulatory concern with
  a decision game is that the advertised RTP assumes optimal play while the
  average player does worse. Here the enumeration proves optimal-play and
  worst-play theoretical RTP are the *same* exact number, `19/20`, for the best
  player, the worst player, and the player who taps at random.
- **The one gap, disclosed.** Payable RTP is theoretical RTP minus floor
  rounding, and the number of credit events depends on how the player plays: a
  single bank rounds once, harvesting at every generation rounds up to 18 times
  (section 13 computes that bound rather than asserting it). At the minimum stake
  of `0.10` credits that is worth less than `1.80000e-04` of the stake, i.e.
  **less than 0.018 percentage points**, so `HALF_EVERY` is less than 0.018 pp behind
  `BANK_FIRST` in payable terms. It is negligible; it is not zero; it means
  harvesting is very slightly the worse policy in payable terms, which is worth
  saying out loud in a game whose signature beat rewards harvesting
  (`docs/DESIGN.md` §6.5 R6). Section 13 states the bound; §9.3's client copy
  carries the qualifier rather than claiming the gap away.

---

## 11. Volatility profile

The base bet is a *volatility dial*, not a fixed profile:

<!-- generated:volatility -->
| Style | Policy | SD | Profit rate | Hit rate | Feel |
| --- | --- | --- | --- | --- | --- |
| Low | `BANK_FIRST` | 0.51 | 45.60% | 93.60% | Grinding, near-flat, one decision |
| Medium | `HALF_EVERY` | 1.45 | 30.75% | 80.80% | Frequent small credits, long tail kept alive |
| Medium-high | `HALF_AT_2X` | 2.35 | 28.61% | 34.02% | Locks a profit, rides the rest |
| High | `STOP_AT_10X` | 3.45 | 7.29% | 7.29% | Rare, chunky wins |
| Extreme | `RUN` | 7.56 | 2.24% | 2.24% | Nothing, or 17.57x and up |
<!-- /generated:volatility -->

Every row returns exactly `19/20` in theoretical rational value before §13's
payable floors: the player chooses variance, never theoretical expectation. Note
how far the profit rate and the hit rate can diverge —
`BANK_FIRST` returns something 93.60% of the time and profits 45.60% of the
time, while `RUN`'s two numbers coincide because its smallest non-zero payout is
already above the stake.

**The published range is a proven interval, not a sample.** Maximising the
variance is a maximisation of the second moment, and because the expected
continuation value of `j` organisms is `c(t) * j` for every policy, the
accumulated bank cancels out of the comparison between actions at a state. The
optimal action therefore depends only on `(t, n)` and an exact backward induction
over the 255 decision states gives the true extremum over *all* adapted policies,
including history-dependent and randomized ones:

<!-- generated:volatility-bounds -->
| Bound over every adapted policy | Standard deviation | Attained by |
| --- | --- | --- |
| Minimum | 0.513058 | Banking the whole colony at the first decision (`BANK_FIRST`) |
| Maximum | 7.569363 | Harvesting exactly one organism at population 15 to stay under FULL BLOOM (13 states) |
<!-- /generated:volatility-bounds -->

`RUN` is close to the maximum but is not the maximum: the maximum-variance policy
harvests exactly one organism whenever the colony reaches 15, which dodges the
FULL BLOOM force-settle and keeps the round alive for a heavier tail. Its
theoretical RTP before payable floors is `19/20`, like everything else.

**The client can reach both ends of that interval.** `HARVEST ONE` is not a
hypothetical button: `thinning.clientQuantum` is `any`, and `docs/DESIGN.md` §4.3
puts a stepper on the harvest control that reaches every legal `k`. A published
range whose maximum no player could select would be an honest sentence about a
product that does not exist, which is why the adapter changed rather than the
sentence.

Expected round length under RUN is `5.85032978` generations; policies that bank
early are shorter, which matters for session pacing (docs/DESIGN.md).

---

## 12. Caps: one basis per bet line

Three different maxima matter for the COLONY line, and conflating them is a
classic way to publish a wrong max-win number.

1. **Largest single settlement** — `72479248046875/137438953472 = 527.355936x`,
   at generation 18 with 30 organisms, probability `4.46239e-17`.
2. **Largest total the line can credit in one round** —
   `373466920422265/412316860416 = 905.776494x`. This is *larger* than the
   largest settlement, because a player who harvests the overflow to keep the
   colony just under the FULL BLOOM threshold can farm the ladder for many
   generations instead of force-settling once. It is computed by an exact
   deterministic dynamic program (`maximumRoundPayout()`) that maximizes over
   every harvest policy and every draw grid simultaneously.
3. **Declared cap for the line** — `906x`, the smallest integer strictly above
   (2), applied to the cumulative credit of the COLONY line on the COLONY stake.

Each side bet credits at most once, so its own maximum is simply its multiplier
and its declared cap is the next integer above it:

<!-- generated:risk -->
| Bet line | Cap basis | Largest credit the line can owe | Declared cap | Headroom |
| --- | --- | --- | --- | --- |
| `COLONY` | colony stake | 905.776494x | 906x | 0.223505x |
| `FIRST_LIGHT` | FIRST_LIGHT stake | 4.750000x | 5x | 0.250000x |
| `DARK_VENT` | DARK_VENT stake | 2.689446x | 3x | 0.310553x |
| `SWARM` | SWARM stake | 248.798505x | 249x | 0.201494x |
<!-- /generated:risk -->

Because every headroom above is strictly positive and credits are floored, no
cap can ever truncate a payout. That is the point: a cap that can bite would
break the invariance theorem (it would make late continuation worth less than its
fair value and hand the player a reason to stop that the paytable does not
price). `assertRiskPolicy()` re-derives every row from the model on every test
run, so any future change to the offspring weights, the ladder, the generation
count, the bloom threshold or a side-bet definition that would push a reachable
total over its cap fails the build.

### 12.1 Why the cap basis is per line and not per ticket

A single round-level ceiling applied to the sum of all credits would be the
obvious design and it is wrong. Exactly how wrong, and exactly how often:

<!-- generated:shared-cap -->
| Quantity, under one shared ticket ceiling of 906x on equal stakes | Exact value |
| --- | --- |
| Combined maximum the four lines can owe | 1162.014446x |
| Short-pay if a single 906x ceiling were applied to that sum | 256.014446x |
| COLONY credit needed before the shared ceiling binds at all | 649.762047x |
| Largest total `RUN` can produce (so `RUN` can never bind it) | 527.355936x |
| Largest total attainable without ever holding this many organisms | 638.035863x below a peak of 14 |
| Upper bound on P(bind), over every adapted policy | 1.96449e-04 (1 in 5090.36) |
<!-- /generated:shared-cap -->

Read that carefully, because the round-2 text got the frequency wrong and it is
worth being precise about which number belongs to which scenario.

**On equal stakes** a shared ceiling is a real short-pay but a rare one. The four
lines can jointly owe `1162.014446x`, so a single `906x` ceiling would truncate
`256.014446x`. But binding requires the COLONY line *alone* to credit more than
`649.762047x`, and that is a tail event twice over: `RUN` cannot produce it at
all, because `RUN`'s largest possible total is the largest single settlement,
`527.355936x`; and no policy can produce it without the colony reaching 14
organisms, because the largest total attainable while never holding 14 is
`638.035863x`. The player's population never exceeds the wild line's (§7.3), so
`P(bind | equal stakes) <= P(peak >= 14) = 1.96449e-04`, one round in 5,090. The
round-2 text attached `1 in 261.89` to this event; that is `P(SWARM wins)`, which
belongs to the **unequal**-stake case below and is correct only there.

**On unequal stakes it is not rare at all, and that is the real argument.**
Nothing relates a side-bet stake to the colony stake, so a shared basis makes the
payout of one bet depend on the size of a different bet: a `0.10` credit colony
bet next to a `100.00` credit SWARM bet would have a ceiling of `90.6` credits
against a `24,879.85` credit obligation, and would pay 0.4% of what SWARM owes —
on a `1 in 261.89` event, which is emphatically not a tail. A design whose
failure mode is "the small bet you placed silently caps the large bet you placed"
is not a risk control, it is a bug with a ceiling in front of it.

Per-line bases remove both cases. Each line's cap is proven above that line's own
maximum, so:

- no credit is ever truncated, on any line, at any stake ratio;
- the invariance theorem's no-clipping precondition holds for the COLONY line and
  each side bet independently;
- each line's theoretical RTP before rounding is exactly `19/20`, so any ticket,
  being a sum of lines, has theoretical return exactly `19/20` of the *total*
  staked; §13's independently floored payable credits are strictly no higher.

### 12.2 Ticket liability, disclosed and admitted rather than clipped

Operators still need a bound on what one ticket can cost. That bound is a
**disclosure and an open-time admission check**, never a settlement-time
truncation:

```
ticket exposure = colonyStake * 906
                + sum over selected side bets of (that bet's stake * that bet's cap)
```

At the declared stake bounds the worst ticket is `931,700` credits against an
admission limit of `1,000,000` credits, so the check cannot refuse a legal ticket
today. It exists so that a future change to the stake bounds fails the build
instead of silently creating a ticket the operator has not underwritten, and so
that a refusal — if the bounds ever change — happens before money moves rather
than after a win.

---

## 13. The payable boundary

- Money is integer **minor units**; the reference configuration uses
  `1 credit = 1,000,000 units`. The colony stake is bounded to
  `[100,000, 1,000,000,000]` units (0.10 to 1,000 credits) and each side-bet
  stake to `[100,000, 100,000,000]` units (0.10 to 100 credits).
- Every credit event pays `floor(exact rational)` units, so
  `0 <= theoretical - credited < 1` unit at each event. The round total is
  therefore short of theoretical by strictly less than **the number of credit
  events**, and the whole of this section is a bound on that count.
- The cap is applied per line with that line's own stake as the basis and the
  already-credited units on that line subtracted, exactly as
  `payableWithinCap()` does in the engine. It never binds (section 12), but it is
  applied anyway so that a configuration error cannot silently overpay.
- Nothing in the payable path uses a float. `payableUnits()` in
  `tools/lib/model.mjs` is the reference implementation and is tested against
  hostile inputs (zero and negative stakes, non-BigInt stakes, non-BigInt cap
  multiples, absurd multipliers).

<!-- generated:rounding-bound -->
| Quantity | Value |
| --- | --- |
| Harvest commitments a stage accepts | 1 |
| Maximum COLONY credit events in a round, over every grid and every policy | 18 |
| The same bound if a stage accepted repeated harvests (rejected) | 117 |
| Maximum credit events on each selected side-bet line | 1 |
| Absolute floor loss on the COLONY line, whatever the stake | < 18 units = < 0.00001800 credits |
| Relative, at the minimum stake | < 1.80000e-04 = < 0.018000 percentage points |
| Relative, at the maximum stake | < 1.80000e-08 |
<!-- /generated:rounding-bound -->

**The count is computed, not asserted.** `maximumCreditEvents()` in
`tools/lib/model.mjs` is a deterministic dynamic program over every draw grid and
every policy simultaneously — the same shape as `maximumRoundPayout()` — and the
fixture freezes what it returns. Round 3 published this bound as the generation
count, by hand, and it was wrong for a reason no test could see: it is true only
if a generation accepts one harvest, and the command surface accepted more.

**Why 18 under the shipped protocol.** A generation credits the COLONY line at
most once, because a generation accepts one harvest commitment (§1.1,
`docs/ENGINE.md` §5.3). Generations 1 to 17 can each carry a harvest; generation
18 force-settles and carries no decision; a settlement credits once. So the count
is at most `17 + 1 = 18`, and 18 is attained — hold two organisms, harvest one at
every generation, settle the last one.

**Why 117 if a generation accepted repeated harvests.** Shedding organisms one at
a time multiplies the events by the number shed. The maximiser climbs to 6, trims
to 7 survivors, sheds 7 one at a time for fourteen generations and banks the last
14 one at a time: `5 + 14x7 + 14 = 117`. At the minimum stake that is `0.117`
percentage points of RTP rather than `0.018` — still small, and 6.5 times the
number this document was willing to publish. A false bound on a money path is
worse than no bound.

**Lemma — splitting a harvest never pays more.** For any stake `S`, ladder value
`c(t)` and split `k = k₁ + k₂`,

```
floor(S c(t) k₁) + floor(S c(t) k₂)  <=  floor(S c(t) k)
```

because `floor(x) + floor(y) <= floor(x + y)`. The one-commit rule therefore
costs the player nothing at any state and is strictly better than the
alternative at most of them; `tests/model.test.mjs` checks the inequality over
every generation and every split rather than trusting the algebra.

**Per line, not per ticket.** The 18 events are the COLONY line's. Each selected
side bet credits at most once, on its own stake, so the worst case for a
four-line ticket is `18 + 3 = 21` floor events across four independent bases —
and the relative figures above are per line, at that line's own stake.

**It is the only quantity in this document that depends on how the player plays
and is still about the *return*.** Section 10 discloses it as a gap rather than
rounding it away, and `docs/DESIGN.md` §9.3's copy carries the qualifier instead
of claiming every way of playing returns identically. Three other published
quantities depend on how the round is played and are published per policy for
exactly the same reason: the standard deviation (§11), the FULL BLOOM frequency
(§8.2) and a ticket's profit rate (§7.4). What none of them touch is the
theoretical return, which is `19/20` for every policy by section 6.

### 13.1 Lemma — a round can never settle at exactly one stake

The settlement ceremony has to tell a player whether they finished up or down
(`docs/DESIGN.md` §7.1), so the boundary between the two had better not be a
value a round can land on.

**Claim.** No reachable round total equals exactly `1` stake.

**Proof.** Every credit is `c(t) * k` for some generation `t` and some
`1 <= k <= 30`, and

```
c(t) * k = 19 * 5^(t-1) * k / (3 * 2^(2t + 2))
```

The denominator is a product of `2`s and a `3`, so the factor `19` in the
numerator can never cancel: every single credit, in lowest terms, has a numerator
divisible by `19` and a denominator coprime to it. A round total is a sum of such
values over a common denominator that is still a product of `2`s and a `3`, so it
is `19a / b` with `19` not dividing `b`. Setting `19a / b = 1` would require
`19a = b`, and `19` does not divide `b`. ∎

`stakeBoundaryIsUnreachable()` in `tools/lib/model.mjs` checks the invariant
mechanically over all 540 reachable single credits rather than trusting the
argument, so a future ladder that lost the property would fail the build. The
consequence for the product: `P(total <= 1 stake)` and `P(total < 1 stake)` are
the same number, and the settlement ceremony's loss/win split has no ambiguous
case to design for.

**Corollary — nor at `L` stakes, for any integer `L` that 19 does not divide.**
The same argument: `19a / b = L` requires `19a = Lb`, so `19` would have to
divide `Lb`, and it divides neither factor. A ticket has at most four lines, so
its stake in colony-stake units is `L <= 4 < 19` and §7.4's boundary inherits the
property: "returns more than the ticket stake" has no tie case either.

---

## 14. Reproducing every number

| Claim | Command |
| --- | --- |
| Total mass is exactly 1, theoretical RTP exactly 19/20 before payable floors | `npm run enumerate` (section 5 of the report) |
| Every action at every state ties | `npm run enumerate` (section 9 of the report) |
| Eight policies all have theoretical RTP 19/20 before payable floors, with profit rates | `npm run enumerate` (section 8 of the report) |
| How often each policy blooms, and which never do | `npm run enumerate` (section 8 of the report) |
| What a second bet line does to the profit rate | `npm run enumerate` (section 10 of the report) |
| The floor-rounding bound, and the alternative it rejects | `npm run enumerate` (section 11 of the report) |
| Every cap sits above its own line's maximum | `npm run enumerate` (section 11 of the report) |
| Split celebration would fire on losing generations | `npm run enumerate` (section 12 of the report) |
| What FULL BLOOM actually pays | `npm run enumerate` (section 13 of the report) |
| Every note of the audio hook is reachable | `npm run enumerate` (section 14 of the report) |
| How often a round settles below the stake | `npm run enumerate` (section 15 of the report) |
| A shared ticket ceiling would short-pay, and how rarely | `npm run enumerate` (section 16 of the report) |
| The colony layout contract | `npm run enumerate` (section 17 of the report) |
| Published tables equal the model | `npm test` |
| Generated tables in the docs are current | `npm run docs:check` |
| Frozen fixture is byte-identical | `npm run paytable:check` |
| Simulation agrees with enumeration, and a forged action log is rejected | `npm run simulate` |
| Every terminal state and its probability | `npm run enumerate:terminals` |

The Monte Carlo simulator exists only as a cross-check on the written rules; it
never sources a published number. At 50,000 deterministic rounds under RUN it
returns an empirical RTP of 0.960842 against the exact theoretical 0.95 before
payable floors (0.32 standard
errors, on a policy whose standard deviation is 7.57) and a mean round length of
5.8636 against the exact 5.85032978. The same run settles one ticket end to end,
publishes both commitment phases, re-publishes it under a forged action log so
the verifier can be seen refusing it, refuses a transcript that commits one stage
twice, and reconciles a round abandoned at stage 0 — the state §5.5 of
`docs/ENGINE.md` previously left undefined — so that path is executable evidence
rather than a paragraph.

A second cross-check runs in `tests/derivation.test.mjs`: the ticket profit rates
in §7.4 come from a joint enumeration, and 20,000 simulated rounds resolve the
same pairing off the real grid and the real wild line and land inside the
5-standard-error band. Two independent code paths, one number.

---

## 15. What is not claimed

This is engineering evidence for a free-play prototype specification, not a
certification. No RNG certification, no laboratory approval, no jurisdictional
analysis, and no production RTP measurement exists for SWARM. The exactness
claims in this document are claims about *this model and this code*: that the
published paytable is the enumerated paytable, that the arithmetic is exact, and
that the strategy proof is exhaustive over the declared state space.

Four fairness controls sit outside those claims and are named here rather than
left to be inferred:

- **Seed selection.** Commit-reveal proves a seed was fixed before the round; it
  does not prove *how that seed was chosen*. An operator can generate many seeds,
  inspect the grid each one produces and publish the convenient one — and SWARM's
  exposure to that is structurally worse than a generic round, because the entire
  270-draw grid is a pure function of one seed and one grind target
  (`P = (2/5)^3 = 0.064`, about 16 attempts) zeroes the colony, loses FIRST LIGHT
  and loses SWARM at the same time. Client entropy (`docs/ENGINE.md` §4.5) is the
  control, and it works only if the publication order it depends on is actually
  enforced by the operator's storage. Reveal Engine's own threat model marks seed
  grinding "not closed here"; this repository inherits that and does not paper
  over it. Seed **custody** — who can read a sealed seed before reveal — is a
  separate and equally unaudited control.
- **The action log against a third party.** The two-phase commitment makes two
  settlements of one round publicly distinguishable, and the live action chain
  gives a player pre-reveal evidence of their own decisions. Neither produces a
  log a third party can verify without the player retaining what they were handed
  (`docs/ENGINE.md` §8).
- **Everything the client does with all this.** A client exists in `src/client`,
  but no claim here certifies its presentation, rendering or interaction
  behaviour.
- **Operator infrastructure.** Deploying this game for real money would require
  independent RNG and seed-custody review, an operator wallet and idempotency
  audit, jurisdictional review, and whatever laboratory process applies — none of
  which this repository performs or replaces.

The market claims in `docs/DESIGN.md` §1.1 are desk observation of publicly
described competitor behaviour, not a commissioned competitive audit, and are
labelled as such there.
