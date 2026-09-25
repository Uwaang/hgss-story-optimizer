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

Battle levels now have three explicit modes. The legacy `ace` profile keeps the old free ace-level normalization only for regression. `major` and `all-accessible` derive each party member's actual level from source-backed EXP supply, acquisition timing, and its Gen 4 growth curve.

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

Move selection is story-stage aware.

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
- `all-accessible`: accessible-trainer envelope using source-backed field/Gym/Rocket maps plus the 21 major battles

Late-joining Pokémon never receive EXP from earlier stages. Natural EXP is currently allocated with a deterministic **lowest-level-first balanced policy**. The entry-level assumption is the highest source-backed encounter/gift level for each acquisition source, so this remains mildly optimistic.

Grind policies for non-`ace` EXP profiles:

- `none`: fight with the naturally reached levels
- `ace-paid`: raise the current team to the next opponent ace level, but record the exact extra EXP and an expected wild-battle count instead of granting those levels for free

Wild-grind estimates use the original Gen 4 slot weights (land 20/20/10/10/10/10/5/5/4/4/1/1, Surf 60/30/5/4/1, rods 40/30/15/10/5, Rock Smash 80/20) and the best currently accessible source by expected EXP per battle.

For the current six-mon regression team, the source-backed `all-accessible + none` envelope reaches roughly Lv35-36 by Lance from 262k natural EXP, while repeatedly forcing ace levels costs more than 500k additional EXP and roughly one thousand expected wild battles. This quantifies why the former free ace normalization was too generous.

The optimizer reports:

- mean battle win rate
- `worstBossWinRate`
- effective EXP burden (`totalGrindExp` in the new EXP profiles; legacy `catchUpExp` only in `ace`)
- expected grind battles
- `purchaseCosts.money`
- `purchaseCosts.coins`

Pareto and beam-search dominance use the effective EXP burden, so legacy `catchUpExp` is no longer double-counted in natural-EXP searches.

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

## Search

`prefix` exists mainly as a deterministic regression path.

`beam` is the useful optimizer:

1. simulate individual candidates;
2. keep a candidate shortlist;
3. iteratively grow legal partial teams;
4. retain a beam of strong teams;
5. rescore surviving full teams across multiple deterministic RNG seeds.

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
- reachability stages are conservative curated checkpoints, not a complete event-graph proof;
- friendship, stone, trade, move-known and location evolutions are still partly manual/conservative;
- overworld TM coverage is incomplete;
- `all-accessible` is an accessible-trainer EXP/money envelope, not yet a proven normal-route trainer subset;
- EXP allocation is a deterministic balanced policy rather than a jointly optimized switch-training schedule;
- entry levels currently use the highest source-backed encounter level, which is optimistic;
- the natural spending budget assumes all modeled pre-Whitney prize money can be reserved for TMs and does not yet subtract routine Poké Ball/healing-item purchases;
- beam search is heuristic and does not prove the global optimum;
- double battles with an ally are not yet represented faithfully.

## CI

GitHub Actions currently checks:

- syntax and source-backed acquisition validation
- exact growth-curve smoke
- source-backed natural EXP supply and real per-Pokémon battle levels
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

Push commits containing `[optimize]` run the legacy `ace` comparison across HG/SS × all three starters. `[optimize-core]` runs the same legacy search with no purchasable TMs. `[optimize-exp]` runs two `all-accessible` EXP searches: natural levels (`grind-policy=none`) and explicitly paid ace-level grinding (`grind-policy=ace-paid`). All retain JSON results as Actions artifacts.

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
