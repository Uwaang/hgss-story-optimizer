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

## 3. Trusted current performance baseline

100-run rebuild/reprice run: `37755171480`

Current 100-run Pareto among the tested frontier states:

| State | Team | Story50 | Red25 total | Red50 total |
|---|---|---:|---:|---:|
| idx30 balanced | Typhlosion / Alakazam / Rhyperior / Lapras / Lanturn / Tyranitar | 308 | 1156 | 1476 |
| idx30 saturation | same | 322 | 1040 | 1349 |
| idx200 soft | Typhlosion / Golem / Tyranitar / Forretress / Ampharos / Rhyperior | 895 | 1039 | 1775 |

Important:
- low-sample 8-run frontier coordinates are screening results only;
- all 10 reused Story50 plans from that frontier failed direct 100-run feasibility;
- future calibrated frontier claims start at ~100-run repair/reprice.

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

Disposition: **P0-C search completeness**, not a battle-policy fix.

## 10. Next concrete continuation point

Proceed in SCRUM-414:

1. diff `680aab600e`, `53d7c1b803`, related tests against `research/v2-rebase`;
2. classify each behavior as:
   - already equivalent,
   - missing correctness behavior,
   - old experimental heuristic;
3. port only missing correctness behavior in isolated commits;
4. run focused smoke tests;
5. re-run idx30 fixed-plan/baseline A/B before touching global search.
