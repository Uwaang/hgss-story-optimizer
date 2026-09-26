# HGSS story simulator

A source-backed HeartGold/SoulSilver story-party optimizer using pinned `pret/pokeheartgold` data and Pokémon Showdown's Gen 4 headless battle engine.

## What is modeled

### Story battles

The acquisition stage stays badge-oriented (`0..12`) even when multiple battles occur inside one stage.

For a party with a fixed starter, the current scoring route has **21 major battles**:

- 8 Johto Gym Leaders
- 4 Team Rocket executive singles with explicit source-script evidence
- 4 starter-matched Silver battles
- Elite Four
- Champion Lance

Silver variants are selected from the player's starter, so all three rival variants are never counted together. Candidate screening without a starter uses the 17 common battles only.

Currently deferred:

- the opening Silver fight, because it occurs before normal catching access;
- the Mahogany Ariana + Grunt MultiBattle with Lance, because treating it as a 1v1 would distort difficulty;
- event-trainer Proton/Ariana encounters whose mandatory-route status still needs reachability verification.

### Trainer fidelity

- rosters, levels, explicit moves and held items come from pinned HGSS trainer data;
- NPC IVs reproduce `floor(difficulty * 31 / 255)`;
- trainer class/gender plus the HGSS LCRNG reproduce deterministic personality, nature and ability slot;
- the player AI uses deterministic move scoring plus bounded voluntary switching;
- voluntary switches use a 3-turn cooldown and a maximum of 6 per battle;
- NPCs remain attack-focused rather than being given invented aggressive switching.

Battle levels now have four explicit modes. The legacy `ace` profile keeps the old free ace-level normalization only for regression. `major`, `normal-route`, and `all-accessible` derive each party member's actual level from source-backed EXP supply, acquisition timing, and its Gen 4 growth curve.

### Acquisition and evolution

The canonical pool is generated from game data rather than a handwritten tier list.

- wild, Surf, fishing and Rock Smash data: `gs_enc_data.json`
- Headbutt species and encounter levels: `files/arc/headbutt.json`
- gifts/statics/manual exceptions: audited config entries with source notes
- unambiguous level evolution: `evo.json`
- species growth rate: `personal.json`
- HeartGold/SoulSilver version differences are preserved
- starter exclusivity and duplicate evolution-family constraints are enforced

Current conservative canonical pool: **98 acquisition candidates per version**.

### Move access and resource costs

Move selection is story-stage aware. Under EXP-aware profiles, one-use and purchasable TM ownership is also planned against each member's actual EXP-derived level/evolution state rather than the opponent's ace level.

- Gen 4 level-up moves
- reusable Johto HMs
- reusable Ilex Forest Headbutt tutor
- single-use story TMs with persistent ownership
- Goldenrod Department Store repeatable TMs with money cost
- Goldenrod Game Corner repeatable TMs with coin cost
- Gen 4 compatibility checks before a move is offered

Examples of modeled repeatable resources include Fire Blast / Blizzard / Thunder from the Department Store and Flamethrower / Ice Beam / Thunderbolt from the Game Corner.

### EXP budget and grinding

EXP is now modeled from the HGSS source instead of assigning free levels.

Source inputs:

- trainer species/levels: `trainers.json`
- species EXP yield and growth rate: `personal.json`
- Lv1-100 cumulative EXP: `growtbl.csv`
- trainer-map placement: `zone_event/*.json`
- wild species/levels: `gs_enc_data.json`
- Gen 4 EXP rule from `battle_command.c`: `floor(expYield * level / 7)`, then the trainer-battle 1.5× bonus

EXP supply profiles:

- `ace`: legacy regression mode; free normalization to each opponent's ace level
- `major`: lower bound using only the 21 scored major battles
- `normal-route`: canonical-route map envelope plus the 21 major battles; this intentionally excludes the extra Gym/Rocket maps used only by the upper envelope
- `all-accessible`: accessible-trainer upper envelope using source-backed field/Gym/Rocket maps plus the 21 major battles

Late-joining Pokémon never receive EXP from earlier stages. Same-stage timing now defaults to **boss-windowed map order**. `config/exp-timing.json` assigns route/Gym/Rocket maps to the scored boss they occur before, then those maps are processed in route order inside that window. A source-mapped Pokémon joins when its acquisition map is reached, so it can receive trainer EXP from that point forward without inheriting earlier same-stage EXP. Manual gifts/statics can provide a conservative `beforeBoss` hint; anything still unresolved falls back to the final scored boss of that stage.

Natural EXP supports three deterministic allocation policies:

- `balanced` (default): lowest-level-first, then lowest progress within the current level;
- `boss-aware-soft`: uses the same next-boss utility signal but smoothly penalizes concentrating more levels onto a member that is already ahead of the lowest-level active teammate;
- `boss-aware`: unrestricted specialization toward the next level with the best next-boss matchup utility per EXP-to-next-level, including type matchups, level-up move breakpoints and level-based evolutions.

The boss-aware score is intentionally a cheap training heuristic rather than a nested battle simulation, so search cost stays tractable. The soft policy uses a level-gap penalty scale of 8 by default; `--soft-level-scale=N` can adjust how quickly specialization is penalized. Use `--exp-allocator=balanced|boss-aware-soft|boss-aware` to compare sensitivity.

Wild encounter entry levels now default to the midpoint of the source-backed min/max encounter range instead of assuming the highest possible encounter level. Fixed gifts/statics are unchanged. For sensitivity checks, the CLI exposes `--entry-level=min|midpoint|max` and `--same-stage-join=map-order|after-map-exp|before-map-exp`. `after-map-exp` is the conservative stage-level fallback; `before-map-exp` restores the previous optimistic same-stage behavior.

Grind policies for non-`ace` EXP profiles:

- `none`: fight with the naturally reached levels
- `ace-paid`: raise the current team to the next opponent ace level, but record the exact extra EXP and an expected wild-battle count instead of granting those levels for free

Wild-grind estimates use the original Gen 4 slot weights (land 20/20/10/10/10/10/5/5/4/4/1/1, Surf 60/30/5/4/1, rods 40/30/15/10/5, Rock Smash 80/20) and the best currently accessible source by expected EXP per battle.

The exact late-game levels and EXP totals are policy-dependent now: the default uses midpoint encounter levels and conservative same-stage joins. Use `exp-envelope` to compare the lower, canonical-route, accessible, and paid-grind envelopes on the same fixed party rather than relying on a single hard-coded total.

The optimizer reports:

- mean battle win rate
- `worstBossWinRate`
- `bottom5BossWinRate`, the mean of the five weakest scored bosses
- `storyClearCoverageScore`, which rewards getting every scored boss toward at least a 50% simulated win rate instead of only maximizing easy-battle wins
- effective EXP burden (`totalGrindExp` in the new EXP profiles; legacy `catchUpExp` only in `ace`)
- expected grind battles
- `purchaseCosts.money`
- `purchaseCosts.coins`

Pareto and beam-search dominance use the effective EXP burden, so legacy `catchUpExp` is no longer double-counted in natural-EXP searches.

Search ranking defaults to mean win rate. `--objective=story-clear` instead ranks first by 50%-threshold boss coverage, then by the bottom-five boss mean, worst-boss rate, and finally overall mean. This keeps a team that can meaningfully contest more mandatory fights ahead of a team that only farms already-easy battles.

Capture-search cost is a separate Pareto axis. Standard wild encounters use source slot probabilities, fixed/gift encounters have zero search cost, and Headbutt remains an explicitly labeled lower bound conditional on selecting the correct tree group.


### Resource profiles

Purchased move **availability** and actual **spending policy** are separate.

Resource availability profiles:

- `core`: level-up moves + reusable HMs/tutors + free single-use story TMs; no Department Store or Game Corner purchases
- `money`: permits both the `core` plan and repeatable money-purchased Department Store TMs
- `all`: permits `core`, `money`, and Game Corner coin-TM plans

Higher profiles are optional supersets rather than forced spending. For each candidate team, `money` keeps the better of core/money simulations and `all` keeps the better of core/money/all simulations (ties prefer the cheaper profile). CI enforces `all >= money >= core` on a real short-route simulation.

Spending policies:

- `unbounded`: legacy comparison mode; any unlocked purchasable TM can be bought.
- `natural`: the optimizer may use all unlocked sources, but Goldenrod purchases are globally selected by battle-utility-per-cost and capped by the source-backed natural-money envelope available before Whitney.

HGSS source scripts exchange 1,000 money for 50 Game Corner coins and 10,000 for 500, so the optimizer uses **20 money per coin** as a direct-purchase-equivalent resource cost. Trainer prize money is derived from the original class multiplier table and last-party-member level, and the source-backed initial wallet is 3,000.

This makes `resources=all --spend-policy=natural` mean “all move sources are allowed, but purchases must fit the natural story cash envelope,” rather than “infinite Game Corner/TM resources.”

Examples:

```bash
# Legacy level-normalized regression
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=core --final-runs=10

# Natural levels + natural Goldenrod spending budget
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=all --spend-policy=natural --exp-profile=all-accessible --grind-policy=none --final-runs=10

# Same natural money supply, but explicitly pay EXP/time to grind to each ace level
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=all --spend-policy=natural --exp-profile=all-accessible --grind-policy=ace-paid --final-runs=10

npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=core --final-runs=10
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=money --final-runs=10
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --resources=all --final-runs=10
```

### EXP envelope comparison

Because `major` is a hard lower bound and `all-accessible` is an accessible-trainer upper envelope rather than a proven normal route, a fixed party can be cross-evaluated under all three EXP assumptions:

```bash
npm run exp-envelope -- \
  --version=HEARTGOLD \
  --team=Cyndaquil,Mareep,Geodude,Zubat,Lapras,Tentacool \
  --resources=all \
  --spend-policy=natural \
  --runs=3
```

This reports the same team under:

- `major + none`: low-EXP lower bound;
- `normal-route + none`: canonical-route map envelope;
- `all-accessible + none`: accessible-trainer upper envelope;
- `all-accessible + ace-paid`: explicit grind-to-ace reference with extra EXP and expected wild battles charged instead of free levels.

A team that only performs well at one envelope endpoint should not be treated as a robust story-party result.

## Search

`prefix` exists mainly as a deterministic regression path.

`beam` is the useful optimizer:

1. simulate individual candidates;
2. keep a candidate shortlist;
3. iteratively grow legal partial teams;
4. retain a beam of strong teams;
5. rescore surviving full teams across multiple deterministic RNG seeds.

Team membership is treated as an unordered set by the beam/cache. Before each modeled boss, the simulator therefore chooses a deterministic lead/order from next-boss matchup utility rather than inheriting whichever candidate happened to be appended first during beam construction. A CI smoke test checks that reversing the same input team does not change the battle evaluation.

Search ranking supports two objectives:

- `--objective=mean` (default): maximize mean win rate, with lower-tail metrics as tie-breakers.
- `--objective=story-clear`: first maximize **boss coverage** toward a 50% per-boss win-rate target, where each boss contributes `min(winRate / 0.5, 1)`; then use the bottom-5 boss average, worst-boss rate, and mean rate as tie-breakers. Capping already-reliable bosses prevents easy fights from compensating indefinitely for mandatory bosses that remain weak.

The bottom-5 and worst-boss metrics are still reported explicitly. The coverage score was added because a fixed bottom-5 average can collapse to zero when five or more late-game bosses are still unwinnable under a no-grind EXP envelope.

A starter can be fixed:

```bash
npm run search -- \
  --pool=canonical \
  --version=HEARTGOLD \
  --strategy=beam \
  --starter=Cyndaquil \
  --runs=1 \
  --screen-runs=1 \
  --final-runs=10 \
  --beam-width=8 \
  --candidate-cap=24 \
  --team-size=6
```

All six HG/SS × starter searches can share candidate screening:

```bash
npm run optimize -- \
  --versions=HEARTGOLD,SOULSILVER \
  --starters=Chikorita,Cyndaquil,Totodile \
  --runs=1 \
  --screen-runs=1 \
  --final-runs=10 \
  --beam-width=4 \
  --candidate-cap=16 \
  --team-size=6
```

Optimization output includes provenance, route size, team members, battle-by-battle win rates, TM ownership, purchase costs and Pareto results. It can be written to JSON and retained as a GitHub Actions artifact.

Search-width sensitivity can be measured directly instead of assuming one beam configuration is sufficient:

```bash
npm run convergence -- \
  --version=HEARTGOLD \
  --starter=Cyndaquil \
  --exp-profile=normal-route \
  --beam-widths=4,8,16 \
  --candidate-caps=16,24,32 \
  --final-runs=3
```

The report uses the largest requested search as a reference and records top-team overlap, score deltas, and evaluated-team counts for each width/cap pair. Stable top teams across this grid are stronger evidence than a single beam-search result.

## Setup

Requires Node.js 22.18+.

```bash
cd hgss_story_sim
npm install
```

## Useful commands

```bash
npm run validate
npm run pool -- --version=HEARTGOLD
npm run pool -- --version=SOULSILVER
npm run simulate -- --runs=20

npm run route-smoke
npm run exp-smoke
npm run exp-budget-smoke
npm run exp-route-smoke
npm run exp-budget -- --version=HEARTGOLD --exp-profile=all-accessible --grind-policy=none
npm run switch-smoke
npm run tutor-smoke
npm run hm-smoke
npm run tm-smoke
npm run shop-tm-smoke
npm run smoke
```

## Acquisition stages

Stage is an acquisition checkpoint, not the index of a battle in the route.

- 0 Falkner
- 1 Bugsy
- 2 Whitney
- 3 Morty
- 4 Chuck
- 5 Jasmine
- 6 Pryce
- 7 Clair
- 8 Will
- 9 Koga
- 10 Bruno
- 11 Karen
- 12 Lance

Rocket and rival battles share the appropriate stage without shifting these checkpoints.

## Current approximations

This is not yet a bit-perfect HGSS story emulator.

- trainer bag-item use is not modeled;
- battle policy is heuristic rather than a globally optimal controller or exact HGSS AI;
- reachability stages and boss-window/map ordering are curated checkpoints, not a complete event-graph proof;
- friendship, stone, trade, move-known and location evolutions are still partly manual/conservative;
- overworld TM coverage is incomplete;
- `normal-route` is a canonical-map envelope, not yet a trainer-by-trainer proof of the exact mandatory/on-route subset;
- `all-accessible` is an accessible-trainer EXP/money upper envelope;
- EXP allocation can be balanced or boss-aware, but neither is a globally optimized switch-training schedule;
- midpoint encounter levels reduce the previous max-level optimism, but encounter-level choice is still an explicit modeling policy;
- the natural spending budget assumes all modeled pre-Whitney prize money can be reserved for TMs and does not yet subtract routine Poké Ball/healing-item purchases;
- beam search is heuristic and does not prove the global optimum;
- double battles with an ally are not yet represented faithfully.

## CI

GitHub Actions currently checks:

- syntax and source-backed acquisition validation
- exact growth-curve smoke
- source-backed natural EXP supply and real per-Pokémon battle levels
- balanced vs boss-aware EXP allocation
- map-level acquisition timing and boss-window ordering
- paid-grind EXP / expected-wild-battle accounting
- starter-specific 21-battle route selection
- real battle completion
- bounded player switching
- tutor/HM timing
- one-use TM ownership
- repeatable TM cost accounting
- full story-route simulation
- HG/SS canonical pools
- prefix and beam-search smoke

Push commits containing `[optimize]` run the legacy `ace` comparison across HG/SS × all three starters. `[optimize-core]` runs the same legacy search with no purchasable TMs. `[optimize-exp]` runs `major`, `normal-route`, `all-accessible`, and explicitly paid ace-level grinding comparisons. All retain JSON results as Actions artifacts.

The current CI optimization profile uses beam width 4, candidate cap 16, and 10-run finalist rescoring.

Final comparison runs are executed on the same commit for both `all` and `core` resource profiles so move-selection changes do not contaminate the comparison.

The current comparison also penalizes recharge, charge-turn, recoil, crash and self-KO move drawbacks in the move-selection heuristic.

## Next milestones

1. Verify and add remaining mandatory Rocket/event encounters.
2. Expand overworld TM and other pre-Lance move-source coverage.
3. Improve trainer item-use / AI fidelity.
4. Broaden optimizer search and benchmark convergence.
5. Extend through Kanto and Red.


The final optimizer comparison after this monotonic-resource fix is triggered from the same commit for both `all` and `core`, so the outputs are directly comparable.
