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

Player battle levels are still normalized to the current opponent's ace level. Grinding burden is modeled separately.

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

### Grinding / cost metrics

The optimizer reports several objectives separately instead of hiding them in one arbitrary score.

- battle win rate
- `catchUpExp`: EXP needed to bring a newly acquired member to the next relevant story battle level
- `purchaseCosts.money`
- `purchaseCosts.coins`

Growth-rate-aware EXP uses the six Gen 4 curves (Fast, Medium Fast, Medium Slow, Slow, Erratic, Fluctuating), validated against the HGSS growth table.

Pareto output removes teams that are simultaneously no better in win rate and no cheaper in EXP/money/coins.

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
- battle level normalization remains an abstraction even though catch-up EXP is now tracked;
- beam search is heuristic and does not prove the global optimum;
- double battles with an ally are not yet represented faithfully.

## CI

GitHub Actions currently checks:

- syntax and source-backed acquisition validation
- exact growth-curve smoke
- starter-specific 21-battle route selection
- real battle completion
- bounded player switching
- tutor/HM timing
- one-use TM ownership
- repeatable TM cost accounting
- full story-route simulation
- HG/SS canonical pools
- prefix and beam-search smoke

Push commits containing `[optimize]` additionally run HG/SS × all three starters and retain the JSON result as an Actions artifact.

## Next milestones

1. Verify and add remaining mandatory Rocket/event encounters.
2. Expand overworld TM and other pre-Lance move-source coverage.
3. Improve trainer item-use / AI fidelity.
4. Broaden optimizer search and benchmark convergence.
5. Extend through Kanto and Red.
