# HGSS Story Optimizer — Research Ledger v2

Last audited: 2026-10-09 (KST)

Master Jira: SCRUM-412  
P0-A Jira: SCRUM-413  
P0-B Jira: SCRUM-414

## 1. Purpose

This file is the repo-side source of truth for research lineage and branch disposition.

It exists because the project accumulated several parallel experimental lines where:
- an idea may be documented only in Jira comments,
- code may exist only on an old branch,
- a later branch may have ported only part of it,
- a workflow may encode an experiment without its conclusion being obvious from Git history.

Do not delete, merge, or cherry-pick a historical research branch solely from its branch name.
Use this ledger and the linked Jira issues first.

## 2. Research v2 baseline

Trusted code baseline for Research v2:

- branch: `research/v2-rebase`
- base: `exp/red-frontier-highsample-reprice-v1`
- base head: `dada6f2e2cef797914c705eb64f93718bc306904`

Reason:

- this line contains the completed 100-run Story50 rebuild + Red25/Red50 repricing baseline;
- it predates the still-unresolved moveset/build diagnostic changes;
- it is therefore safer than using `fix/joint-route-build-v1` as the consolidation base.

Current diagnostic line intentionally *not* adopted wholesale:

- `fix/joint-route-build-v1`
- head: `1c3d21b46ca3373b800b21a9a1a17566f5bd1400`
- 5 commits ahead of the trusted high-sample baseline
- touched:
  - `.github/workflows/joint-route-build-ab-v1.yml`
  - `.github/workflows/joint-route-moveset-diagnostic-v2.yml`
  - `hgss_story_sim/src/battle.mjs`
  - `hgss_story_sim/src/cli.mjs`

Disposition: **diagnostic-only until Moveset/Build v2 is settled**.

## 3. Calibrated baseline and P0-B evaluator correction

Historical 100-run rebuild/reprice run: `37755171480`

Pre-parity 100-run Pareto among the tested frontier states:

| State | Team | Story50 | Red25 total | Red50 total |
|---|---|---:|---:|---:|
| idx30 balanced | Typhlosion / Alakazam / Rhyperior / Lapras / Lanturn / Tyranitar | 308 | 1156 | 1476 |
| idx30 saturation | same | 322 | 1040 | 1349 |
| idx200 soft | Typhlosion / Golem / Tyranitar / Forretress / Ampharos / Rhyperior | 895 | 1039 | 1775 |

These numbers remain useful as **historical high-sample comparators**, but the idx30 saturation value `322 / 1040 / 1349` is no longer the current evaluator anchor after P0-B.

P0-B attribution run: `37898662064`

| Smart-AI semantics | Story50 | Red25 total | Red50 total |
|---|---:|---:|---:|
| legacy | 322 | 1040 | 1349 |
| Choice-lock-aware switching only | 322 | 1040 | 1349 |
| HP-aware Eruption/Water Spout only | **400** | **1082** | **1438** |
| both corrected semantics | **400** | **1082** | **1438** |

Attribution conclusion:
- the legacy condition exactly reproduces the old baseline, so there is no baseline drift;
- Choice-lock-aware switching is neutral on this control;
- the full `+78 / +42 / +89` delta is caused by HP-aware Eruption/Water Spout decision power;
- there is no observed interaction between the two fixes on idx30 saturation;
- both fixes remain adopted because they correct battle-state semantics rather than optimize the score.

Therefore the first corrected-evaluator fixed-team anchor is:

- idx30 boss-aware-saturation: **400 / 1082 / 1438**

Do not compare future corrected-evaluator search results directly against the old 322/1040/1349 as if evaluator semantics were unchanged.

Important:
- low-sample 8-run frontier coordinates are screening results only;
- all 10 reused Story50 plans from that frontier failed direct 100-run feasibility;
- future calibrated frontier claims start at ~100-run repair/reprice;
- a new full Pareto across multiple teams/allocators must be rebuilt after Moveset/Build v2 and scheduler changes rather than mechanically repricing every historical point now.

## 4. Branch disposition

### A. Fully absorbed into the trusted/current research lineage

These have no branch-unique commits relative to the audited current lineage and are retained only as historical pointers:

- `design/route-exp-budget-model`
- `exp/deheuristic-bayesian-racing-v1`
- `exp/deheuristic-entry-distribution-v1`
- `exp/deheuristic-retry-family-v1`
- `exp/deheuristic-route-risk-v1`
- `exp/grind-aware-red-frontier-v1`
- `exp/grind-aware-red-frontier-band-v1`
- `exp/progression-safe-screening-v1`
- `exp/red-frontier-highsample-v1`
- `exp/red-frontier-highsample-reprice-v1`
- `exp/route-grind-proxy-v1`
- `exp/route-grind-proxy-v2-search`
- `feature/boss-interaction-matrix`
- `feature/breakpoint-aware-exp`
- `feature/hg-cyndaquil-equal-level-story`
- `infra/staged-route-search-v1`
- `infra/staged-route-search-v2`
- `recovery/red-frontier-band-v1-errors`

Disposition:
- no code recovery needed;
- keep only until v2 consolidation and historical run index are stable;
- old PRs pointing only at absorbed branches can then be closed as superseded.

### B. Important unresolved code — preserve until explicit v2 port/reimplementation

#### `experiment/red-min-grind`
Unique experimental lineage: 60 commits vs the pre-v2 active audit line.

Important research/mechanics commits include:
- `680aab600e` — smart handling of Focus Punch, Choice status, and Eruption
- `53d7c1b803` — Choice-lock-aware smart switching
- `9ed2891f1e` — Choice-lock regression coverage
- `2a65362660` — Red-specific moveset/build optimization
- `e96431b281` — Choice-compatible Red movesets
- `cbcd866c90` — usable backup coverage
- `16858b94a3` — legal abilities + conditional move value
- `8682ad631e` — Gen4 Lightning Rod / Storm Drain behavior
- `08e9ca6fb7` — preserve offensive EV spreads for Choice builds

Current status:
- some reusable pieces were later ported;
- Choice-lock switching, HP-aware Eruption decision, and Focus Punch handling are known parity candidates;
- Red-specific optimizer heuristics are **not** to be ported wholesale.

Disposition: **P0-B source branch; do not close/delete until parity audit is complete**.

#### `experiment/lance-min-grind`
Unique lineage: 80 commits, extending the Red branch.

Additional useful correctness work:
- pre-evolution move inheritance
- capture feasibility/evolution metadata
- held-item inventory/exclusion experiments
- disjoint encounter level ranges
- target-boss/local boundary tooling

Many legality fixes appear to have been ported later; verify only if parity audit finds a gap.

Disposition: **P0-B secondary source branch**.

#### `experiment/red57-vs-lance`
Unique lineage: 91 commits, extending Lance.

Mostly cross-boss validation and exact historical build checks.

Disposition:
- research/control value;
- not a merge target;
- preserve until P0-B and known-control documentation are complete.

#### `exp/d-bench-control`
Five unique commits:
- `b5cecdebaf` — late-sixth slot control workflow
- `870a1c72c1` — broad multi-budget candidate workflow
- `0a3d21df5f` — deferred EXP participation controls
- `4fe4242155` — wire deferred participation into practical grind
- `5ba028cbc4` — sixth-slot participation timing experiment

Recovered result:
- D core5 Story50 = 602
- + late Tyranitar Story50 = 602
- + early Quagsire = 837
- Quagsire benched until Blue = 759
- benched until Red = 723

Interpretation:
- acquisition alone should not imply compulsory EXP participation;
- Research v2 scheduler must model **recipient/bench participation**, not only allocation weights.

Disposition:
- do not cherry-pick the old CLI interface as the final architecture;
- preserve semantics and reimplement as part of EXP Scheduler v1.

### C. Useful diagnostics/workflows, no direct code adoption

- `diag/idx30-movesets-v1`
  - 2 unique commits
  - retained player builds in output and reconstructed idx30 movesets
  - result should be represented by a general diagnostic in v2, not branch-specific code

- `exp/candidate-sweep-v3`
  - 1 unique workflow commit

- `exp/endogenous-rerank-15`
  - 1 unique workflow commit

- `exp/endogenous-rerank-v1`
  - 1 unique workflow commit

- `exp/full-endogenous-rerank-v1`
  - 1 unique workflow commit

- `exp/overnight-candidate-sweep-v2`
- `exp/overnight-candidate-sweep-v3`
- `exp/overnight-endogenous-candidates`
  - historical search/late-slot experiment orchestration
  - `exp/overnight-endogenous-candidates` also carries the deferred-participation implementation that is superseded by the clearer `exp/d-bench-control` endpoint

Disposition:
- record representative run IDs/results;
- archive after the Research v2 run index exists.

### D. Rejected experiment — preserve result, not behavior

#### `exp/deheuristic-progress-adaptive-v1`
Unique commits:
- `656d610745` — checkpoint-aware route-risk dominance
- `ff6ee18c83` — adaptive uncertain challenger resampling
- `71aba69661` — experiment workflow

Outcome:
- using boss checkpoint progress as a high-dimensional hard Pareto vector caused Pareto explosion and poor route-level selection.

Disposition:
- **rejected** as a primary objective/selection rule;
- continuous progress remains potentially useful only as a low-cost screening/surrogate/diagnostic signal.

### E. Repair/recovery-only branches

- `recovery/grind-story-timeouts-v3`
- `recovery/grind-story-summary-v4`

Purpose:
- recover 241 timeout states;
- rebuild/merge the complete 720-state result;
- work around artifact pagination / rate limits.

Disposition:
- no algorithm semantics to port;
- keep run/result references, then archive after v2 ledger/run-index completion.

#### `exp/red-frontier-highsample-repair-v1`
Unique commits:
- seed practical-grind repair from an existing story plan
- high-sample repair workflow

This was an intermediate repair strategy.
The trusted high-sample baseline ultimately rebuilt Story50 from scratch instead.

Disposition:
- utility may be retained for diagnostics/recovery;
- not the v2 baseline algorithm.

### F. Current moveset/build diagnostics — deliberately excluded from v2 baseline

#### `fix/joint-route-build-v1`
Five commits beyond the trusted high-sample baseline.

Experiments:
- alternating route moves/build optimization
- removal of damaging-type-count reward
- standalone-utility lexicographic tie-break
- idx30 A/B and moveset diagnostic workflows

Results:
- alternating build/move optimization alone did **not** change idx30 totals: 322 / 1040 / 1349
- the moveset tie-break changed Typhlosion from
  - Eruption / Focus Punch / Double-Edge / Rollout
  to
  - Eruption / Fire Blast / Flamethrower / Focus Punch
- this exposed a deeper objective-design problem rather than establishing a final optimizer

Disposition:
- **diagnostic only**
- Research v2 must reformulate moveset/build search before adopting these changes.

## 5. Open pull requests

Current open PRs:

| PR | Branch | Disposition |
|---|---|---|
| #1 | `feature/breakpoint-aware-exp` | absorbed; close as superseded after ledger verification |
| #2 | `feature/boss-interaction-matrix` | absorbed; close as superseded after ledger verification |
| #3 | `experiment/red-min-grind` | keep temporarily; P0-B source |
| #4 | `experiment/lance-min-grind` | keep temporarily; P0-B source |
| #5 | `experiment/red57-vs-lance` | keep temporarily; P0-B/control source |
| #6 | `feature/hg-cyndaquil-equal-level-story` | absorbed; close as superseded after ledger verification |

Do not merge #3-#5 wholesale.
Extract/cross-check only validated reusable mechanics.

## 6. Recovered research conclusions that must not be lost again

### 6.1 Fixed EXP allocator is structurally inadequate

1000-run N04 evidence:
- saturation and balanced can dominate soft on aggregate route reliability;
- balanced can massively improve Lance2 while hurting other bosses;
- other teams prefer different allocators.

Therefore allocation is a **team/progression search state**, not a global config choice.

### 6.2 EXP participation is also a search decision

Late-sixth controls show that an early member can harm the route simply by joining EXP competition.
Scheduler v1 must model:
- recipient set / bench state
- allocation
- grind placement

### 6.3 Partial-team pruning has a completion-value blind spot

Completion-aware one-step rollout recovered N04-compatible prefixes that current partial score pruned.
Future global team search must account for achievable completions, not only current prefix quality.

### 6.4 Rare Red wins make binary low-run screening nearly blind

A true ~2% Red team is almost always 0/2.
Use continuous battle progress only as a search/surrogate signal; do not reintroduce high-dimensional progress Pareto.

### 6.5 Low-sample frontier is not calibrated frontier

8-run results discovered useful basins, but 100-run revalidation invalidated every reused Story50 plan.
Use explicit sample tiers.

## 7. Research v2 execution order

1. **P0-A — research ledger / branch inventory**
   - this file
   - historical run index
   - PR disposition
2. **P0-B — battle mechanics parity**
   - Choice lock
   - Eruption/Water Spout HP dependence in player decision model
   - Focus Punch
   - any additional unported Gen4 semantics
3. **Moveset/Build v2**
   - avoid coefficient patch accumulation
   - calibrate search/surrogate against actual battles
4. **EXP Scheduler v1**
   - progression-state allocation + bench/recipient decisions
5. **Completion-aware team search v2**
   - wider/global candidate recovery
6. **100-run candidate validation**
7. **500–1000-run finalist validation**
8. Dense grind/reliability frontier
9. Sequential Elite Four
10. wider HG/SS + starter convergence

## 8. Branch deletion/cleanup rule

No branch deletion during P0-A/P0-B.

After P0-B:
- close absorbed PRs (#1, #2, #6);
- snapshot representative run/artifact IDs for diagnostic/recovery branches;
- archive/remove branches only after their unique semantics/results are represented in this ledger or linked Jira;
- keep Red/Lance historical branches until all parity candidates are explicitly marked ported/rejected.

## 9. Additional P0 search-completeness audit

Jira: **SCRUM-415**

The canonical `trade-aware` evolution policy currently auto-applies only:
- unambiguous `EVO_LEVEL`
- `EVO_TRADE`
- `EVO_TRADE_ITEM`

Friendship, stone/item, move-known, time-conditioned, and other special evolution methods are intentionally kept conservative rather than auto-applied.

This is legally safe but may remove valid terminal forms from the global candidate space and reduce recall.

Important distinction:
- the old Lance branch's disjoint encounter-level-range fix does **not** need direct porting;
- current code already preserves actual encounter-slot level probabilities in `levelDistribution`, which supersedes that representation.

Research v2 must quantify which HGSS-legal terminal forms are currently omitted before the next global search.

Leaf-terminal diagnostic:
- workflow run `37897480281`
- current pool: 144 candidates / 100 families
- **39 leaf terminal candidates** require HGSS legality/timing audit
- 3 additional leaves are known DPPt-only/unavailable location evolutions (Magnezone, Leafeon, Glaceon)
- notable audit targets include Crobat, Espeon/Umbreon, Ambipom, Lickilicky, Mamoswine, Tangrowth, Yanmega, Gliscor, Weavile, Tyrogue branches, stone evolutions, and Togekiss
- current `evolution-access.hgss.json` contains source-backed timing primarily for trade-evolution items; stone/Razor item timing data must be expanded for P0-C

Disposition: **P0-C search completeness**, not a battle-policy fix.

## 10. Next concrete continuation point

P0-B battle mechanics parity is complete.

Immediate Research v2 order:

1. **P0-D / SCRUM-416 — Moveset/Build v2**
   - corrected evaluator is now the baseline;
   - fix Move Relearner / relearn-only `4L1` legality before calibrating movesets;
   - prototype legal 4-move + build search on fixed species/teams;
   - keep old Red-specific optimizer only as diagnostic/reference code.

2. **P1 / SCRUM-417 — EXP Scheduler v1**
   - progression-state allocation;
   - bench/recipient participation;
   - grind placement;
   - pending evolution trigger state.

3. **Finish P0-C residual trigger evolutions inside progression state**
   - Mamoswine;
   - Gliscor;
   - Weavile.

4. **P1 / SCRUM-418 — Completion-aware Global Search v2**
   - only after evaluator, moveset/build, candidate-space completeness, and scheduler state are trustworthy.

Do not resume broad 2-slot/local Pareto search before these foundations are integrated.

## 11. P0-C evolution coverage implementation milestone

Jira: **SCRUM-415**

Research v2 now has validated source-backed support for three additional evolution classes on top of level/trade/trade-item:

1. **Stone evolutions**
   - `EVO_STONE`, `EVO_STONE_MALE`, `EVO_STONE_FEMALE`
   - source-backed stone availability from `evolution-access.hgss.json`
   - route checkpoint gating preserved; same-stage timing is not reduced to a bare numeric stage
   - representative smoke: Bellsprout -> Weepinbell -> Victreebel is blocked at Whitney and legal by Morty
   - Nidoran-F/M -> Nidoqueen/Nidoking special-name paths are explicitly covered

2. **Conditional level branches**
   - Tyrogue stat branches
   - gender branches
   - PID branches
   - Nincada/Ninjask/Shedinja-style conditional level methods represented as explicit variants
   - representative smoke: Tyrogue remains Tyrogue below Lv20 and materializes the selected Hitmon branch at Lv20

3. **Friendship level-up evolutions**
   - `EVO_FRIENDSHIP`, `EVO_FRIENDSHIP_DAY`, `EVO_FRIENDSHIP_NIGHT`
   - friendship-building inconvenience remains outside the current EXP-only objective
   - the required level-up is not skipped
   - trigger level is conservatively at least one level above both the candidate's maximum entry level and any prior level evolution
   - therefore Zubat -> Golbat Lv22 -> Crobat requires Lv23 rather than allowing two evolutions from the same Lv22 trigger
   - friendship -> stone chains such as Togepi -> Togetic -> Togekiss are supported

Coverage progression:

| State | Candidates | Families | HGSS-native unsupported leaf terminals |
|---|---:|---:|---:|
| pre-P0-C | 144 | 100 | 39 |
| + stone | 149 | 100 | 20 |
| + conditional level | 153 | 100 | 12 |
| + friendship | **155** | **100** | **7** |

The remaining seven HGSS-native leaf terminals are now precisely isolated:

- `EVO_HAS_MOVE`: Ambipom, Lickilicky, Mamoswine, Tangrowth, Yanmega
- `EVO_ITEM_NIGHT`: Gliscor, Weavile

These are deliberately **not** modeled as immediate evolutions. They require a level-up after a move/item condition becomes legal, so their correctness depends on progression-state EXP timing. They should be implemented with the scheduler-aware trigger model rather than by another optimistic stage-only shortcut.

Still excluded as HGSS-native impossible:

- Magnezone (`EVO_CORONET`)
- Leafeon (`EVO_ETERNA`)
- Glaceon (`EVO_ROUTE217`)

Validation runs:

- stone smoke: `37899947101` — success
- stone coverage audit: `37900032178` — success
- conditional-level audit: `37900471093` — success after special-name audit normalization
- friendship audit: `37900847377` — success

Disposition: **stone / conditional-level / friendship changes are validated P0-C code.**

### 11.1 Natural move-known follow-up

Four `EVO_HAS_MOVE` leaves can be resolved without progression-history state because their required move is learned naturally at a future level by the pre-evolution species:

- Aipom -> Ambipom: Double Hit at Lv32
- Lickitung -> Lickilicky: Rollout at Lv33
- Tangela -> Tangrowth: Ancient Power at Lv33
- Yanma -> Yanmega: Ancient Power at Lv33

Implementation derives the Gen4 natural level-up source from the pinned `pokemon-showdown` dependency and only accepts a level source strictly above the member's entry/prior-evolution level. This intentionally rejects Piloswine Ancient Power `4L1` as a natural future trigger.

Validation run `37902300498` — SUCCESS:

- candidate count: **155**
- family count: **100**
- Ambipom / Lickilicky / Tangrowth / Yanmega present
- Mamoswine / Gliscor / Weavile remain absent
- DPPt-only Magnezone / Leafeon / Glaceon remain absent
- regression failures: 0

The candidate count does not rise from 155 because these terminal forms replace the conservative unevolved variant rather than adding an additional branch.

HGSS-native unresolved evolution leaves are therefore reduced from **7 to 3**:

- Mamoswine — Ancient Power must become legally available to Piloswine, then a subsequent level-up is required
- Gliscor — Razor Fang + night, then post-item level-up
- Weavile — Razor Claw + night, then post-item level-up

These three require progression-history-aware trigger state and are assigned to the EXP Scheduler / legality integration rather than approximated with static stage-only evolution.

## 12. P0-B battle mechanics parity — final attribution

Jira: **SCRUM-414**

Recovered correctness behaviors:

- Choice-lock-aware voluntary switching
- HP-aware Eruption / Water Spout power in smart player decision estimation

Not adopted:

- old Focus Punch `×0.18 / ×0.08` penalties, because they are hand-tuned policy approximations rather than direct mechanics

Matched 100-run attribution run `37898662064`:

- legacy: **322 / 1040 / 1349**
- choice-only: **322 / 1040 / 1349**
- dynamic-HP-only: **400 / 1082 / 1438**
- both: **400 / 1082 / 1438**

Decision:

- both correctness fixes remain default-on;
- the old high-sample result is retained only as a legacy comparator;
- corrected evaluator anchor is 400 / 1082 / 1438 for idx30 saturation;
- attribution toggles remain for exact regression reproduction;
- battle cache semantics are fingerprinted and default namespace is bumped to `hgss-battle-cache-v3-parity` so legacy/corrected runs cannot cross-hit cached battles.

P0-B parity extraction from the historical Red/Lance branches is complete. The branches may still be retained as research references for Moveset/Build v2, but their PRs no longer need to remain open as merge candidates.


---

## 13. 2026-10-15 Research v2 continuation checkpoint

This section supersedes stale operational status above where branch/PR state has changed since the 2026-10-09 audit.

### 13.1 Current active research line

- active branch: `research/v2-completion-aware-global-search-v2`
- audited head: `a4d8826c19ee8c8bf85219025ab03afffcab250e`
- vs `main`: **652 ahead / 0 behind**
- vs `research/v2-rebase`: **295 ahead / 0 behind**

The active Research v2 line is now the practical continuation point for the completed P0/P1 foundation work.
`research/v2-rebase` remains the historical consolidation base, not the current experimental head.

### 13.2 Jira milestone state

Research v2 child milestones:

| Jira | Topic | Status |
|---|---|---|
| SCRUM-413 | Research Ledger / Branch & PR Inventory | **IN PROGRESS** |
| SCRUM-414 | Battle Mechanics Parity | **DONE** |
| SCRUM-415 | Evolution Coverage | **DONE** |
| SCRUM-416 | Moveset/Build v2 | **DONE** |
| SCRUM-417 | EXP Scheduler v1 | **DONE** |
| SCRUM-418 | Completion-aware Global Search v2 | **DONE** |
| SCRUM-419 | HM Move Deleter / HM-forget legality audit | backlog |

### 13.3 What changed after the original ledger audit

#### Battle/evaluator foundation
- Choice-lock-aware switching and HP-aware Eruption/Water Spout decision semantics were recovered and validated.
- evaluator/policy confounds in moveset experiments were isolated;
- corrected evaluator became the basis for later Research v2 work.

#### Evolution / move legality
- stone, conditional-level, friendship, natural move-known and scheduler-aware trigger coverage were integrated;
- Move Reminder / evolved-form-only `4L1` legality was audited and corrected;
- remaining evolution timing issues were handled through progression-state logic instead of optimistic stage-only shortcuts.

#### Moveset/Build v2
- the project stopped stacking arbitrary score coefficients to suppress strange movesets;
- actual-battle counterfactual/high-sample validation became the calibration boundary;
- representative Typhlosion, Tyranitar, Rhyperior and Alakazam work was completed under corrected semantics.

#### EXP Scheduler v1
- progression-state EXP allocation and active-recipient/bench participation were implemented and validated;
- the old fixed-allocator assumption is no longer the intended global model.

#### Completion-aware Global Search v2
- low-sample rare-wall handling, candidate recall, completion-aware pruning and terminal practical-grind evaluation were integrated;
- canonical-origin leave-one-out tests for Crobat/Zubat, Lapras, Rhyhorn/Rhyperior and Abra/Alakazam all retained viable terminal basins;
- all four ablations repeatedly recovered the same practical fallback:
  `Typhlosion / Politoed / Vespiquen / Wobbuffet / Steelix / Weavile`;
- female Combee acquisition probability is intentionally excluded from the cost objective by research policy; female-only Vespiquen legality remains enforced;
- independent 16-start full-team coordinate search was run for 15 rounds without staged prefix pruning or known-team seeding;
- its best endpoint stabilized at:
  `Typhlosion / Ambipom / Rhyperior / Kingdra / Ditto / Wobbuffet`
  with 100-run retry 181.7818 and grind 1468;
- it did not beat the staged/leave-one-out fallback (100-run retry 144.8487, grind 828), and no new 1000-run challenger was warranted.
- SCRUM-418 was closed after candidate recall + basin robustness + independent-method robustness were sufficiently supported.

### 13.4 Current branch-lineage audit

Already fully contained by the current active branch (no commits missing from these branch tips):
- `research/v2-rebase`
- `research/v2-mechanics-finalize`
- `research/v2-evolution-stone-v1`
- `research/v2-evolution-friendship-v1`
- `research/v2-evolution-natural-move-v1`
- `research/v2-move-relearner-legality-v1`
- `research/v2-moveset-calibration-v1`
- `research/v2-exp-scheduler-v1`

Still diverged / historical-reference branches:
- `fix/joint-route-build-v1`: 5 branch-only commits relative to the current line's merge base
- `exp/d-bench-control`: 5 branch-only commits
- `experiment/red-min-grind`: 60 branch-only commits
- `experiment/lance-min-grind`: 80 branch-only commits
- `experiment/red57-vs-lance`: 91 branch-only commits
- `research/v2-move-legality-v1`: 1 branch-only commit
- `research/v2-evolution-trigger-audit-v1`: 1 branch-only commit

The old Red/Lance and bench branches are now primarily **historical/research-reference sources** because their important semantics have been reimplemented/validated in later v2 work. Their remaining unique commits must still be classified before branch deletion.

### 13.5 Pull-request state

As of this checkpoint, there are **no open pull requests** in the repository.
PRs #1–#10 are all closed; #7–#10 were merged into the v2 rebase line, while the older experimental PRs were closed without wholesale merge.

Therefore the old Section 5 “Current open PRs” is historical only.

### 13.6 Immediate continuation

With SCRUM-414 through SCRUM-418 complete, resume **SCRUM-413** and finish repository consolidation bookkeeping before starting another broad research phase:

1. classify remaining diverged branch-only commits;
2. build/update representative run/artifact index;
3. mark branches as absorbed / historical-result-only / diagnostic-only / recovery-only / safe-to-archive;
4. decide the durable Research v2 consolidation branch/head;
5. then return to SCRUM-412 medium-term roadmap:
   - dense grind/reliability frontier;
   - sequential Elite Four semantics;
   - multi-seed/search robustness;
   - wider HG/SS scope later.

Do not delete historical branches until their unique semantics/results are represented in this ledger or linked Jira.


## 14. Remaining diverged branches — final disposition audit

The current active Research v2 line was compared directly against the remaining diverged branch tips.

### 14.1 Archive-safe historical/diagnostic branches

| Branch | Branch-only commits | Final classification | Reason |
|---|---:|---|---|
| `fix/joint-route-build-v1` | 5 | diagnostic-only / superseded | iterative route-build + moveset tie-break experiments were superseded by SCRUM-416 actual-battle calibration and joint reconciliation |
| `exp/d-bench-control` | 5 | research-result-only / superseded implementation | the important finding (EXP participation/bench state matters) is preserved; its semantics were reimplemented in SCRUM-417 recipient scheduling |
| `research/v2-move-legality-v1` | 1 | diagnostic-only / superseded | branch-only commit is only the workflow that quantified historical level-up move overgrant; Move Reminder/`4L1` legality was subsequently fixed and regression-tested |
| `research/v2-evolution-trigger-audit-v1` | 1 | diagnostic-only / superseded | branch-only commit is only the trigger-source audit workflow; pending move/item -> later level-up evolution state is now implemented in the scheduler/canonical pool |

These branches contain no remaining required production semantics that are absent from the current Research v2 line.

### 14.2 Old Red/Lance line

#### `experiment/red-min-grind` — 60 branch-only commits

Classification: **historical research source; archive-safe after ledger preservation**.

Important old semantics were checked against the current line:

- Gen4 Lightning Rod / Storm Drain behavior is explicitly present in current `battle.mjs`;
- Choice-lock-aware smart switching uses the active request/disabled-move state;
- HP-dependent Eruption / Water Spout decision power has explicit regression coverage;
- Focus Punch conditional execution risk is modeled from HGSS opponent move-choice probabilities rather than the old hand-tuned `×0.18 / ×0.08` penalties;
- Choice-compatible offensive EV/build handling is present in the current build evaluator.

The remaining branch-only commits are mainly:
- Red-only GA/search orchestration;
- cross-level/focused Red workflows;
- old Red-specific moveset/build heuristics;
- performance/cache experiments;
- historical validators.

Those are not intended to be ported wholesale after SCRUM-414/416.

#### `experiment/lance-min-grind` — 80 branch-only commits

Classification: **historical legality/target-boss research source; archive-safe after ledger preservation**.

The extra Lance-line correctness ideas are represented or superseded in current v2:
- disjoint wild encounter levels -> current source-backed `levelDistribution`;
- pre-evolution move retention -> current move-legality smoke/regression;
- friendship/move/item evolution timing -> current canonical evolution + scheduler trigger state;
- held-item timing/inventory -> current route held-item policy;
- target-boss/local-boundary tooling -> diagnostic only, not part of the global objective.

#### `experiment/red57-vs-lance` — 91 branch-only commits

Classification: **historical control/cross-boss diagnostic; archive-safe after ledger preservation**.

Its final 11 commits beyond the Lance line are cross-boss build/availability validators and exact historical Red-team checks. They remain useful as historical evidence but are not merge targets.

### 14.3 Archive policy

“Archive-safe” means:
- no code/commit needs to be cherry-picked before v2 consolidation;
- the branch may be deleted later after the repository owner chooses to perform branch cleanup;
- its scientific result/important semantics must remain represented by this ledger and Jira.

No branches are deleted as part of this audit.

## 15. Representative Research v2 run index

This is intentionally a **representative** reproducibility index, not every exploratory run.

| Milestone | Representative run(s) | Durable conclusion |
|---|---|---|
| SCRUM-414 mechanics attribution | `37898662064` | corrected evaluator anchor; Choice-lock semantics retained; HP-aware Eruption/Water Spout accounts for historical repricing delta |
| SCRUM-415 stone/conditional/friendship coverage | `37899947101`, `37900471093`, `37900847377` | major HGSS evolution classes restored with source-backed timing |
| SCRUM-415 natural move evolution | `37902300498` | Ambipom/Lickilicky/Tangrowth/Yanmega legal natural triggers; residual trigger-state evolutions deferred to scheduler |
| SCRUM-416 corrected smart-policy high sample | `37923263801` | old severe Focus Punch option-cost conclusion shown to be largely confounded |
| SCRUM-416 Typhlosion final local benchmark | `37925824007` | no-Eruption route-risk leader under corrected evaluator |
| SCRUM-416 Tyranitar Red-only 1000 | `37931043228` | sparse-win Red-only local result; progress remains secondary surrogate |
| SCRUM-416 Rhyperior finalist | `37931267780` | local Scary Face route-risk improvement, later tested for joint transfer |
| SCRUM-416 Lapras Bruno2 1000 | `37939929316` | Brine directional rare-wall improvement reproduced |
| SCRUM-416 joint 500 | `37943823029` | local moveset optima are non-separable; joint context reverses Rhyperior local choice |
| SCRUM-416 final Tyranitar reconciliation | `37947375241` | Tyranitar Screech local result rejected in joint context; P0-D signed off |
| SCRUM-417 first 64-run scheduler frontier | `38044502764` | recipient/bench schedules produce a real multi-objective grind frontier |
| SCRUM-417 trigger-state regression | `38048187862` | Mamoswine/Gliscor/Weavile pending-condition -> later level-up semantics validated |
| SCRUM-417 final local-stability screen | `38051695259` | 5-state recipient schedule frontier locally stable; Scheduler v1 exit criteria met |
| SCRUM-418 Crobat-free high sample | `38287910366` | exact fallback team receives reusable 1000-run evidence |
| SCRUM-418 Rhyhorn-free terminal | `38510573312` | third independent core ablation recovers the same practical fallback |
| SCRUM-418 Abra-free full chain | `38527011138` | strongest prefix-basin disruption still reconverges at terminal |
| SCRUM-418 independent coordinate final | `38610537965` | 16-start, 15-round less-correlated search stabilizes without beating staged-search fallback |

Current recurring practical fallback:
`Typhlosion / Politoed / Vespiquen / Wobbuffet / Steelix / Weavile`

Independent coordinate best:
`Typhlosion / Ambipom / Rhyperior / Kingdra / Ditto / Wobbuffet`

The independent result is not a replacement frontier leader; it is robustness evidence that a substantially less-correlated search method did not surface a superior challenger.

## 16. Consolidation decision

At this point:
- SCRUM-414 through SCRUM-418 are complete;
- the current active branch contains the validated v2 foundation;
- remaining diverged branches are historical/diagnostic/research-result sources rather than required unported code.

Therefore create a durable Research v2 consolidation pointer from the current active head.

Durable Research v2 branch created:
- branch: `research/v2-consolidated`
- creation head: `0a4ec14185edc0edc67d3e4f9eea3d7a431d726d`
- purpose: stable continuation pointer after completion of SCRUM-414 through SCRUM-418 and SCRUM-413 branch/run inventory.

The existing `research/v2-completion-aware-global-search-v2` branch remains useful as the historical implementation line for SCRUM-418, but should no longer be the semantic name of the whole Research v2 continuation after consolidation.
