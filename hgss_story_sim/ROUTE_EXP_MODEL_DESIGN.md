# Route EXP Budget Model Design

Status: design proposal  
Branch: `design/route-exp-budget-model`  
Scope: Pokémon HeartGold fixed-team story optimization  
Relationship to current work: complements, rather than replaces, the equal-level benchmark

## 1. Why this model is needed

The current equal-level benchmark asks a useful but narrower question:

> If every currently available member of a candidate final team is set to the same common level N, how well does that team perform across the story, and how much catch-up EXP is required to bring each member from its source-backed capture level to N?

This isolates team composition and late-game battle strength well. It is also convenient for search because every available member is compared at one common level.

However, it is not a simulation of natural story progression.

At common level 63, for example, Falkner is fought by all candidate members available at that checkpoint at level 63. A member that joins later is absent before its acquisition point, but immediately appears at level 63 after joining. The cost model then charges only the EXP needed from its source-backed capture level to 63.

That creates three important blind spots:

1. Early bosses become saturated because the player's available Pokémon are vastly overleveled relative to the story.
2. A late high-level catch is represented only through lower catch-up EXP, not through its actual level relative to the rest of the team at the moment it joins.
3. EXP earned before a late member joins is not conserved as a time-ordered resource. The model does not represent the trade-off between investing early EXP in existing members and saving later training effort for a new catch.

The route EXP model is intended to answer the broader question:

> Given the EXP that could actually have been earned by each point in the story, the source-backed level at which each Pokémon joins, and the requirement that EXP already spent cannot be reassigned, what level distribution and team composition best complete the story?

No arbitrary bonus or penalty should be attached to early or late availability. Its value should emerge from the resource flow itself.

---

## 2. Design principles

### 2.1 EXP conservation, not availability heuristics

Do not assign scores such as:

- +X for being available before Gym 2
- -Y for joining after the Elite Four
- +Z for having a high capture level

Instead, model:

- when the member becomes available;
- the level/EXP state at which it enters;
- how much route EXP has been earned by that checkpoint;
- how much of that EXP has already been allocated;
- what additional optional grinding is required.

A late level-45 Pupitar can therefore be good or bad for principled reasons. It may save training because it arrives at level 45, while the five earlier members benefited from all pre-capture route EXP. It may also be bad if it arrives too late to contribute to many difficult battles or requires too much post-capture investment.

### 2.2 Individual levels are first-class state

There is no team "average level" used for battle.

A checkpoint may legitimately look like:

```
Typhlosion 43
Golem      41
Magneton   40
Slowbro    39
Heracross  42
Pupitar    45   <- newly caught
```

Those exact individual levels are materialized into the battle simulator.

### 2.3 Keep equal-level as a separate benchmark

The equal-level benchmark remains useful for:

- composition screening;
- late-game power analysis;
- controlled A/B comparisons;
- finding level breakpoints;
- generating search seeds.

The route EXP model should not silently change its semantics. It should be a separate evaluation/search mode so both answers remain available.

Suggested names:

- `equal-level-story-search`
- `route-exp-story-search`

### 2.4 Source-backed inputs only

Capture level, availability, evolution timing, move timing, and EXP supply should be derived from source-backed game data where possible.

When exact data is unavailable, the model should expose the approximation explicitly instead of hiding it inside a score.

### 2.5 Start with a resource envelope; add micro-mechanics later

A fully exact Gen IV EXP simulation would require battle participation, switching, Exp. Share ownership/use, fainted Pokémon rules, traded-Pokémon multipliers, and potentially wild grinding choices.

That is a much larger problem.

The first implementation should therefore model a route EXP **envelope**: the total EXP earned by each checkpoint is conserved and may be allocated among members available at that time.

A later precision layer can restrict this allocation according to exact battle participation and Exp. Share mechanics.

---

## 3. Terminology

### Checkpoint

A point in story order at which state is evaluated.

Initially, use the existing boss route as the checkpoint sequence:

```
Falkner -> Bugsy -> Whitney -> ... -> Lance -> Kanto -> Blue -> E4 rematch -> Red
```

The route may later include finer-grained checkpoints between bosses when acquisition/evolution/resource events require them.

### Natural route EXP

EXP earned from the configured set of non-optional or expected story battles before a checkpoint.

It must be cumulative and monotonic.

### Optional grind EXP

Additional EXP intentionally earned beyond the natural route supply.

This is a cost, not free budget.

### Member EXP state

For member i at checkpoint t:

```
xp[i,t]
level[i,t] = levelFromExp(growthRate[i], xp[i,t])
```

EXP is the canonical state. Level is derived.

### Capture endowment

When a member joins at source-backed capture level L:

```
xp[i,join] >= expAtLevel(growthRate[i], L)
```

This capture EXP is not charged against route EXP. It is the state at which the caught Pokémon enters the party.

---

## 4. Core state model

For a fixed final-six candidate team, define at checkpoint t:

```js
{
  checkpoint,
  cumulativeNaturalExp,
  cumulativeOptionalGrindExp,
  members: {
    candidateKey: {
      available,
      captured,
      captureSource,
      captureLevel,
      exp,
      level,
      speciesAtCheckpoint,
      evolutionState
    }
  }
}
```

Important invariants:

### Availability

A member may not exist before its legal acquisition checkpoint.

```
captured[i,t] = false  if t < availableFrom[i]
```

### Capture floor

At its chosen legal source:

```
xp[i,t_join] >= captureExp[i]
```

### Monotonic member EXP

```
xp[i,t+1] >= xp[i,t]
```

### No retroactive allocation

EXP earned before a member joins cannot be transferred into that member.

If member i joins at checkpoint k:

```
routeAllocatedTo[i,t] = 0 for all t < k
```

### Global EXP conservation

For each interval t -> t+1:

```
sum_i deltaRouteXp[i,t]
  <= naturalExpEarned[t] + optionalGrindExp[t]
```

Only members available during that interval may receive that interval's allocation.

### Optional grind is explicit

```
optionalGrindExp[t] >= 0
```

Total grinding becomes a Pareto/resource objective rather than being hidden.

---

## 5. EXP supply model

The route model requires a time-ordered EXP supply table.

Proposed schema:

```json
{
  "segments": [
    {
      "from": "START",
      "to": "Falkner",
      "mandatoryTrainerExp": 1234,
      "expectedRouteExp": 1234,
      "optionalWildGrind": true
    },
    {
      "from": "Falkner",
      "to": "Bugsy",
      "mandatoryTrainerExp": 5678,
      "expectedRouteExp": 6900,
      "optionalWildGrind": true
    }
  ]
}
```

Three possible supply profiles should be kept conceptually separate:

1. **mandatory-only**  
   EXP from battles that the route necessarily requires.

2. **expected-story**  
   Mandatory battles plus a documented expected set of ordinary route/trainer encounters.

3. **grind-allowed**  
   The natural profile plus explicit optional grind EXP chosen by the optimizer.

Do not mix optional grinding into natural EXP.

### What counts as capture EXP?

In HGSS/Gen IV, merely catching a wild Pokémon does not grant catch EXP. The new Pokémon nevertheless enters at its capture level, so its existing EXP implied by that level is treated as an acquisition endowment.

---

## 6. Allocation model v1: route EXP envelope

For each route segment, the optimizer decides how to distribute the newly earned EXP among currently available members.

Example:

```
Before segment:
Typhlosion 31
Golem      29
Magneton   28
Heracross  30

Segment natural EXP: 18,000

Possible allocation:
Typhlosion +4,000
Golem      +6,000
Magneton   +2,000
Heracross  +6,000
```

The objective is not equal leveling. The optimizer may concentrate EXP if that creates a better next-checkpoint team.

When a late member arrives:

```
existing:
43 / 41 / 40 / 39 / 42

capture:
Pupitar Lv45

new state:
43 / 41 / 40 / 39 / 42 / 45
```

Nothing is averaged or normalized.

### Why this is principled

Early availability has both benefit and cost:

- benefit: the member can contribute earlier;
- cost: keeping it competitive may consume earlier EXP.

Late availability also has both benefit and cost:

- benefit: it may arrive at a high level without consuming prior route EXP;
- cost: it contributes to fewer checkpoints and has less time to receive route EXP.

The optimization determines the net effect.

---

## 7. Allocation constraints: v1 versus v2

### v1: flexible allocation envelope

v1 may allocate segment EXP to any Pokémon available in that segment.

This assumes the player can deliberately train chosen members through switching/participation and therefore models the upper envelope of sensible EXP management.

Advantages:

- substantially simpler;
- deterministic;
- suitable for optimization;
- no arbitrary availability penalty;
- captures time ordering and late-catch effects.

Limitation:

- allocation is more flexible than exact Gen IV mechanics.

### v2: battle-participation constrained allocation

Later, use actual trainer battles and party participation.

Possible constraints include:

- EXP only to participants and/or Exp. Share holder;
- per-foe EXP amounts;
- switch splitting;
- trainer battle multiplier;
- traded Pokémon multiplier if relevant;
- fainted recipient rules;
- Exp. Share availability timing.

v2 should be implemented only after v1 establishes that route-aware leveling materially changes team selection.

---

## 8. Battle evaluation

At checkpoint t:

1. Determine which final-team members have been legally acquired.
2. Read each available member's individual EXP.
3. Convert EXP to individual level.
4. Resolve species/evolution state at that exact level and checkpoint.
5. Resolve legal moves, TMs, tutors, held items, and abilities using existing timing rules.
6. Materialize the team with `levelsByCandidate`.
7. Run the existing Pokémon Showdown Gen IV battle engine.

This already fits the lower-level battle API because `materializeCandidateTeam()` accepts per-candidate levels.

No "average level" parameter should be introduced.

---

## 9. Evolution and move timing

Evolution must depend on both:

- story/checkpoint access; and
- individual level.

Examples:

- Quilava cannot become Typhlosion until its actual member level meets the evolution requirement.
- Rhyhorn may become Rhydon based on level, but Rhyperior must also wait for Protector access and allowed trade evolution timing.
- Gengar/Alakazam/Golem may evolve once their pure trade policy allows them.
- A move learned at level 42 is unavailable to a member currently level 40 even if another member is level 45.

This is a major improvement over any team-average model.

---

## 10. Capture-source choice

A family may have multiple legal capture sources.

The optimizer must not automatically choose only the highest-level source without considering timing.

A later high-level source can reduce training cost but forfeits earlier contributions.

Therefore candidate identity may eventually need to include a **capture-source policy**, or the route optimizer must choose among source options.

For each source s:

```
sourceOption = {
  availableFrom,
  minLevel,
  maxLevel,
  location,
  encounter conditions
}
```

The optimization compares alternatives such as:

- catch early at level 18 and train throughout the story;
- wait and catch the same family at level 35 later.

This should emerge as a resource/performance trade-off.

---

## 11. Objective and Pareto dimensions

Do not collapse the route problem immediately into one scalar.

Recommended Pareto axes:

- story clear coverage;
- bottom-K boss performance;
- geometric story performance;
- Red / late-game performance as descriptive metrics;
- total optional grind EXP;
- possibly total natural EXP consumed by the final six;
- optional money/resource burden where already modeled.

The main cost axis should be:

```
totalOptionalGrindExp
```

Natural route EXP is not itself a penalty because it is earned during progression. However, how it is allocated determines the reachable levels.

A secondary diagnostic may report:

```
unusedNaturalExp
```

if the envelope contains more EXP than the six-member team can use meaningfully.

---

## 12. Search architecture

A full joint optimization over:

- six-member team;
- capture source;
- EXP allocation at every checkpoint;
- move/resource plan;
- battle outcome

is too expensive to brute-force.

Use layers.

### Layer A: candidate-team generation

Reuse the current equal-level search as a proposal generator.

Keep multiple Pareto/diverse candidates rather than only the top team.

### Layer B: route EXP allocation

For each proposed fixed six, optimize the individual EXP trajectory.

Possible initial methods:

- beam search over checkpoint level states;
- dynamic programming with EXP quanta;
- marginal-utility greedy allocation with local improvement;
- mixed integer formulation later if state size permits.

### Layer C: exact battle validation

For promising allocation trajectories, run real Showdown battles at each checkpoint.

### Layer D: local allocation refinement

Near difficult bosses, test reallocations around the current plan:

```
+delta EXP to member A
-delta EXP from member B
```

provided conservation and timing constraints remain legal.

---

## 13. Recommended v1 allocator

A pragmatic first implementation:

### EXP quantum

Represent allocatable EXP in chunks rather than single points.

Examples:

- 250 EXP early;
- 1,000 EXP midgame;
- 2,500 or 5,000 EXP late.

Alternatively use level-boundary deltas so only allocations that reach a new level are considered.

Level-boundary allocation is preferable because EXP that does not change a level has no battle effect.

### Per-segment expansion

At checkpoint t:

1. Add newly captured members at their source-backed capture EXP.
2. Add natural EXP from the preceding segment to the allocatable pool.
3. Generate allocations that push one or more members to reachable next level boundaries.
4. Materialize candidate states.
5. Evaluate upcoming boss proxy or a small real-battle screen.
6. Preserve a diverse beam based on:
   - next-boss performance;
   - lower-tail route performance;
   - remaining/unspent EXP;
   - individual level-distribution diversity.

Do not penalize uneven levels. If `45/42/40/39/38/50` is optimal, preserve it.

### Optional grind

After natural EXP allocation, allow extra grind only when useful.

Treat each extra level boundary as having an explicit EXP cost.

This naturally generates a performance-vs-grind Pareto frontier.

---

## 14. Important anti-bias rule

Do not use a heuristic such as "team average must be near boss ace level."

That would recreate the problem in another form.

Boss-relative levels should matter only through actual battle performance or a clearly documented proxy used to save compute.

The optimizer must be allowed to discover strategies such as:

- one overleveled carry;
- two high-level specialists plus underleveled support;
- broadly even leveling;
- a newly caught high-level late member.

---

## 15. Relationship to current EXP code

The repository already contains useful pieces:

- growth-rate based `expAtLevel()`;
- per-candidate source-backed capture levels;
- `levelsByCandidate` support in team materialization;
- route-ordered bosses;
- acquisition timing;
- evolution timing;
- machine/resource planning;
- existing EXP scheduling/allocator experiments elsewhere in the codebase.

The route model should reuse those primitives rather than duplicate them.

The main semantic change is that `levelsByBattle` becomes a genuine time-varying result instead of:

```js
routeBosses.map(() => ({ ...commonLevelForEveryCandidate }))
```

---

## 16. Output schema

A route-aware evaluation should expose enough state to audit the result.

Example:

```json
{
  "team": ["Cyndaquil", "Geodude", "..."],
  "naturalExpProfile": "expected-story-v1",
  "optionalGrindExp": 84200,
  "checkpoints": [
    {
      "boss": "Falkner",
      "naturalExpEarnedThisSegment": 3200,
      "optionalGrindThisSegment": 0,
      "members": [
        {
          "candidateKey": "...",
          "species": "Cyndaquil",
          "level": 13,
          "exp": 2197,
          "captured": true
        }
      ],
      "winRate": 0.78
    }
  ],
  "finalLevels": {
    "Typhlosion": 67,
    "Golem": 64
  }
}
```

A result should make it possible to answer:

- When was this member caught?
- At what level?
- How much natural EXP did it receive?
- How much grind EXP did it receive?
- What level was it for every boss?
- Which evolution was active?
- Where did the optimizer spend EXP and why?

---

## 17. Validation plan

Before searching the entire Pokémon pool, validate semantics with controlled cases.

### Test A: late high-level catch

Construct:

- five early members around level N;
- one late source at N+M.

Expected:

- the new member joins at N+M;
- the other five keep their own levels;
- no averaging occurs;
- no earlier route EXP is allocated retroactively to the late member.

### Test B: early versus late source for same family

Compare:

- early low-level catch;
- later high-level catch.

Expected:

- early source can contribute to more bosses;
- late source starts with more embedded EXP;
- no handcrafted preference decides the winner.

### Test C: EXP conservation

For every checkpoint:

```
allocatedNaturalExp <= cumulativeNaturalExpAvailable
```

and member EXP never decreases.

### Test D: no free catch-up

If a level-20 member is caught and later appears at level 40, the EXP difference must come from post-capture natural EXP and/or explicit grind.

### Test E: evolution legality

A Pokémon cannot use a level-triggered evolution before its actual member level reaches the threshold, and cannot use an item/trade evolution before the item/checkpoint is legal.

### Test F: equal-level limiting comparison

Feed enough optional grind to make every available member exactly the same common level.

The resulting battle materialization should approximately reproduce the current equal-level benchmark for the same team and timing policy. This provides a cross-model sanity check.

---

## 18. Implementation stages

### Stage 0 — data audit

Inventory:

- trainer EXP data already extractable;
- route ordering;
- mandatory versus optional trainers;
- wild encounter source levels;
- growth curves;
- existing EXP allocator utilities.

Produce an explicit coverage report before implementing the optimizer.

### Stage 1 — route EXP ledger

Implement:

- segment EXP supply;
- capture endowments;
- cumulative EXP conservation;
- per-member EXP/level state;
- diagnostic CLI only.

No team search yet.

### Stage 2 — fixed-team allocator

Given a hard-coded six-member team:

- choose source options;
- allocate natural EXP across checkpoints;
- allow optional grind;
- emit levels by boss.

Validate against controlled tests.

### Stage 3 — battle-coupled allocation

Use boss battle proxy / small actual runs to choose among allocation states.

Produce a fixed-team performance-vs-grind Pareto frontier.

### Stage 4 — integrate team search

Use equal-level search and/or wider candidate generation to propose teams, then route-evaluate them.

Do not immediately run route allocation for every combinatorial team.

### Stage 5 — dynamic roster, optional

Only after fixed-six route optimization is stable, allow temporary members and replacements.

EXP invested in a retired temporary member remains spent, naturally creating opportunity cost.

---

## 19. Dynamic roster extension

The eventual state may allow more than six families to be used over the whole story while only six are active at any time.

Example:

```
early:  A B C D
mid:    A B C D E
late:   A B C E F G
```

If D consumed 40,000 route EXP before being dropped, that EXP remains consumed.

This makes temporary utility measurable without arbitrary replacement penalties.

This feature is explicitly out of scope for route EXP v1.

---

## 20. Decisions proposed for v1

Recommended choices:

- fixed final six only;
- individual EXP states;
- source-backed capture level/endowment;
- source-backed availability;
- natural route EXP envelope;
- flexible allocation among currently available members;
- optional grind as explicit cost;
- actual individual levels in Showdown battles;
- existing move/evolution/item timing reused;
- current equal-level benchmark kept unchanged;
- no early/late availability bonus;
- no average-level normalization;
- no dynamic roster yet;
- no exact Exp. Share/participation mechanics yet.

This is the smallest model that fixes the major semantic blind spot without replacing it with a different heuristic.

---

## 21. Main open data question

The most important prerequisite is not the optimizer. It is the EXP ledger.

Before implementation, verify how much of the following is already source-backed in the repository:

- every mandatory trainer's party and levels;
- base EXP yield for defeated species;
- Gen IV trainer EXP formula;
- story ordering of mandatory/optional trainer fights;
- wild grinding encounter tables;
- capture source level ranges;
- growth-rate curves;
- Exp. Share acquisition timing if v2 is pursued.

If mandatory-route EXP cannot be reconstructed reliably, the model should expose multiple named route profiles rather than pretending there is one exact "natural EXP" number.

---

## 22. Interpretation after this model exists

The project would then have two intentionally different outputs.

### Equal-level benchmark

> At common level N, which legal final-six compositions provide the strongest and most EXP-efficient battle performance?

Useful for controlled team-power analysis and late-game breakpoints.

### Route EXP benchmark

> From the start of HGSS to Red, under a conserved source-backed EXP budget, what individual level trajectory and final-six composition gives the best story performance for the least optional grinding?

This second question is much closer to the original "best story team" goal.


## 23. Implementation audit findings

A Stage-0 implementation audit found that the repository already contains much of the route-aware EXP infrastructure in `src/exp-budget.mjs` and the non-equal-level story evaluator:

- Gen IV growth curves and EXP-to-level conversion;
- trainer battle EXP calculation from source-backed species EXP yields;
- wild-grind yield estimates;
- map trainer extraction from pinned pret/pokeheartgold zone-event data;
- route timing windows;
- per-member EXP states and `levelsBefore` snapshots;
- multiple EXP allocators;
- battle materialization through `levelsByCandidate`.

Therefore the route EXP work should extend and validate this infrastructure rather than build a second allocator from scratch.

### 23.1 Trade-aware EXP key mismatch fixed

The old EXP scheduler keyed member state by `familyId`, while battle materialization keys trade-aware evolution variants by `searchKey`.

This could cause a trade-aware member's route level to be missed and silently fall back to the boss ace level.

The design branch aligns EXP state keys with battle keys:

```js
candidate.searchKey || candidate.familyId || candidate.species
```

Any future route-aware code must preserve this identity rule.

### 23.2 Map-level access is not sufficient for trainer EXP

The first data audit exposed a separate source-granularity issue.

The existing EXP world interprets:

> map becomes accessible -> every trainer object in that map's zone-event file becomes EXP-accessible

This is not always true.

Concrete examples:

- Route 46 is partially reachable from Route 29 before Falkner, but the three trainer objects in the northern section are reached from Route 45 much later.
- Union Cave B1F/B2F were previously assigned to the pre-Bugsy map stage even though their Lv23-28 trainer content belongs to the Surf-accessible lower-cave route.

Thus route EXP requires two kinds of timing correction:

1. **whole-map access correction** when the entire map/subfloor is unavailable;
2. **trainer-window correction** when a map is partially accessible but specific trainer objects are gated.

The model must never solve these mistakes by capping levels or deleting EXP based on battle difficulty. Access timing should be corrected from map/trainer provenance.

### 23.3 Current corrections on the design branch

- Union Cave B1F/B2F are deferred from stage 1 to stage 4, after Surf is usable.
- Route 46 northern trainers are removed from the early map bucket and assigned to an explicit stage-7 trainer window before Clair.
- The EXP audit command reports every map, trainer key, party, EXP yield and timing window so additional access mismatches can be reviewed.

### 23.4 First semantics check

Before access corrections, a fixed-team route evaluation already demonstrated the intended individual-level semantics:

```
Falkner:
Geodude   Lv12
Cyndaquil Lv11
Zubat     Lv11
```

rather than the equal-level benchmark's common Lv50-70 values.

Those exact levels are not yet considered the final natural-route truth because the same audit found early EXP overcounting. The purpose of Stage 0 is to make the ledger trustworthy before any full team search is attempted.

### 23.5 EXP profile interpretation

For now, distinguish these meanings explicitly:

- `major`: scored major battles only; useful as a conservative lower EXP envelope but incomplete as a normal playthrough.
- `normal-route`: trainer rewards on curated normal-route access windows; this is the intended basis for route optimization once access timing is audited.
- `all-accessible`: a wider accessible-map envelope and should not be interpreted as mandatory EXP.
- optional wild grinding remains an explicit cost rather than silently increasing natural EXP.

A future `mandatory-only` profile may be added if every unavoidable trainer battle can be source-backed confidently.


## 24. Fixed-team allocator A/B findings

Validated by GitHub Actions `route-exp-allocator-ab #3` (run `36515186885`) using:

- HeartGold / Cyndaquil;
- trade-aware evolution;
- fixed team families: Cyndaquil, Magnemite, Geodude, Abra, direct-capture Quagsire, Rhyhorn;
- `normal-route` EXP;
- maximum source-backed entry level;
- map-order joining;
- no optional grind;
- equal resource policy;
- 64 simulated runs per scored boss.

All three allocators received the same natural EXP ledger:

```
totalNaturalExp   620,487
totalMapExp       447,356
totalMajorExp     173,131
totalGrindExp           0
```

### 24.1 Aggregate result

| allocator | mean win rate | bottom-5 | geometric | coverage |
| --- | ---: | ---: | ---: | ---: |
| balanced | 0.5870 | 0.0031 | 0.2944 | 0.6781 |
| boss-aware | 0.6125 | 0.0125 | 0.3579 | 0.7333 |
| breakpoint-aware | 0.5896 | 0.0031 | 0.3218 | 0.7042 |

All three still have at least one 0% checkpoint and 0/64 against Red with zero optional grinding.

### 24.2 Balanced keeps a real six-member roster

At Red, balanced produces:

```
Quagsire   48
Magneton   48
Golem      48
Rhyperior  48
Alakazam   49
Typhlosion 48
```

Pre-Red route EXP allocated after each member's capture:

```
Abra line       109,363
Cyndaquil line  103,010
Geodude line    102,714
Magnemite line  106,496
Rhyhorn line     84,647
Quagsire line    94,967
```

This is broad and interpretable, but it is inefficient at several hard checkpoints:
Morty 7.8%, Clair 0%, Lance 0%, Red 0%.

### 24.3 Boss-aware improves route score by collapsing onto carries

At Red, boss-aware produces:

```
Magneton 65
Quagsire 51
Golem    58
Rhyhorn  35
Quilava  28
Abra     12
```

Pre-Red route EXP allocation:

```
Abra line           413
Cyndaquil line   17,107
Geodude line    189,238
Magnemite line  270,529
Rhyhorn line          0
Quagsire line   123,910
```

Thus roughly three families consume nearly the entire route budget while three final-team families are effectively abandoned.

This is not an implementation bug. It follows from the greedy immediate-boss utility objective.

The concentration produces large gains at some checkpoints:

- Clair: 0% -> 68.8%
- Will: 1.6% -> 45.3%
- Sabrina: 0% -> 56.3%
- Misty: 3.1% -> 75.0%

but loses substantial performance elsewhere, for example:

- Chuck: 89.1% -> 57.8%
- Silver at Victory Road: 64.1% -> 1.6%
- Karen: 31.3% -> 0%
- Erika: 39.1% -> 4.7%

The higher aggregate score therefore does not mean the allocation is globally satisfactory.

### 24.4 Breakpoint-aware does not solve the carry collapse

Breakpoint-aware ends with exactly the same pre-Red EXP totals and final levels as boss-aware:

```
Magneton 65 / Quagsire 51 / Golem 58 /
Rhyhorn 35 / Quilava 28 / Abra 12
```

It changes some intermediate allocations, but aggregate performance is lower than boss-aware.

The current breakpoint implementation:

- uses only the next few bosses (default horizon 4);
- looks ahead only a limited number of levels (default 12);
- bounds breakpoint bonus relative to immediate boss utility;
- amortizes distant breakpoints over their full EXP cost.

These safeguards prevent pathological long-range jumps, but they also make the foresight too weak to rescue families whose useful evolution is several levels away or whose immediate matchup utility is poor.

Examples exposed by this run:

- Abra remains below Lv16, so Kadabra/Alakazam is never reached.
- Cyndaquil line stops at Quilava Lv28, so Typhlosion is never reached.
- Rhyhorn remains Lv35, so Rhydon and therefore Protector-based Rhyperior are never reached.

This is an important semantic result of route-aware leveling: a legal terminal evolution path does not imply the optimizer actually reaches its prerequisite levels.

### 24.5 Consequence for the next allocator iteration

Do not simply choose boss-aware as the route allocator because it has the highest mean score in this single fixed-team run.

Before optional-grind Pareto or full team search, compare the existing anti-collapse variants:

- `boss-aware-soft`
- `boss-aware-depth`
- `boss-aware-saturation`

The desired behavior is not enforced equal leveling. It is an allocator that preserves concentrated investment when useful while avoiding irreversible starvation of strategically valuable future members.

The follow-up should therefore measure:

- aggregate route performance;
- lower-tail boss performance;
- final evolution state;
- EXP concentration by member;
- number of members that receive negligible post-capture EXP;
- Red progress even when win rate remains zero.

Only after selecting a stable allocator should optional-grind Pareto experiments be treated as meaningful.


## 25. Anti-collapse allocator comparison

Validated by GitHub Actions `route-exp-allocator-ab #5` (run `36516031134`) using the same fixed trade-aware team and natural-EXP-only conditions as section 24, but with 128 simulated runs per boss.

Compared allocators:

- `balanced`
- `boss-aware`
- `boss-aware-soft`
- `boss-aware-depth`
- `boss-aware-saturation`

### 25.1 Aggregate result

| allocator | mean win rate | bottom-5 | geometric | coverage | Red avg opponent faints | top-3 EXP share | HHI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| balanced | 0.5875 | 0.0031 | 0.2606 | 0.6781 | 1.125 | 53.0% | 0.168 |
| boss-aware | 0.6164 | 0.0141 | 0.3478 | 0.7375 | 1.383 | 97.1% | 0.345 |
| boss-aware-soft | **0.6195** | 0.0094 | 0.3093 | 0.6979 | 1.102 | **60.4%** | **0.176** |
| boss-aware-depth | 0.6138 | 0.0016 | 0.2827 | 0.7083 | **1.625** | 86.1% | 0.274 |
| boss-aware-saturation | 0.6161 | 0.0031 | 0.2637 | 0.6776 | 1.203 | 66.0% | 0.190 |

All allocators use the full natural EXP ledger and zero optional grind in this run.

### 25.2 Boss-aware-soft is the best current compromise

At Red, `boss-aware-soft` reaches:

```
Magneton   51
Golem      51
Quagsire   50
Alakazam   47
Rhyperior  46
Typhlosion 43
```

All six families reach their intended terminal evolution.

Route EXP allocated by Red:

```
Magnemite line  128,555
Geodude line    125,030
Quagsire        109,375
Abra line        95,452
Cyndaquil line   74,708
Rhyhorn line     68,077
```

The top three consume about 60.4% of allocated route EXP, close to balanced's 53.0% and far below boss-aware's 97.1%.

No member receives zero EXP or less than 1% of the allocated route EXP.

This is exactly the intended anti-collapse behavior: permit unequal investment without abandoning future members.

### 25.3 Saturation is more concentrated and misses Typhlosion

At Red:

```
Magneton  53
Golem     52
Quagsire  51
Alakazam  47
Rhyperior 47
Quilava   34
```

Top-three EXP share is 66.0%.

It preserves five useful final forms but leaves the starter below the Lv36 Typhlosion breakpoint. Aggregate performance is similar to boss-aware but its coverage and geometric score are lower than boss-aware-soft.

### 25.4 Depth improves Red progress but still starves members

At Red:

```
Magneton 60
Golem    58
Quagsire 50
Alakazam 42
Rhyhorn  35
Quilava  28
```

It achieves the best Red progress of this comparison at 1.625 average opponent faints despite 0/128 wins.

However:

- Rhyhorn receives zero route EXP;
- the starter receives very little;
- top-three EXP share remains 86.1%;
- Rhyperior and Typhlosion are never reached.

Thus depth is useful evidence that concentration can improve a specific terminal battle, but it is not a satisfactory whole-route allocator.

### 25.5 Boss-aware-soft boss profile

Compared with balanced, boss-aware-soft materially improves several difficult route fights:

- Morty: 3.9% -> 10.9%
- Chuck: 88.3% -> 94.5%
- Pryce: 75.0% -> 85.2%
- Goldenrod Underground Silver: 40.6% -> 76.6%
- Victory Road Silver: 60.2% -> 80.5%
- Blue: 31.3% -> 51.6%

It still performs poorly on several hard matchups:

- Clair: 1.6%
- Will: 10.2%
- Bruno: 0.8%
- Lance: 0%
- Red: 0%

Therefore the next problem is no longer primarily allocation collapse. It is insufficient natural EXP / matchup strength at hard checkpoints.

### 25.6 Recommended next use

Do not make `boss-aware-soft` an unconditional repository-wide default from this one fixed team.

For the next route-EXP experiment, use it as the **leading allocator candidate** and compare optional-grind Pareto curves against balanced as a control.

Recommended next experiment:

```
allocator: boss-aware-soft vs balanced
optional grind budgets:
0 / 25k / 50k / 100k / 150k / 200k / 300k
```

Report:

- where the grind EXP is spent;
- level/evolution state at every key boss;
- coverage and bottom-tail performance;
- Lance / Blue / Red progress;
- total optional grind required to cross meaningful clear-rate thresholds.

This will test the project's main route question directly: how much additional training is required, and where should it be invested, to turn a naturally leveled team into a reliable story-clearing team?
