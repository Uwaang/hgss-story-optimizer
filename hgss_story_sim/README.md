# HGSS story simulator

This module searches for strong Pokémon HeartGold/SoulSilver story parties by combining pinned `pret/pokeheartgold` game data with Pokémon Showdown's Gen 4 headless battle simulator.

## Current coverage

### Battle fidelity

- Boss rosters are fetched from pinned `pret/pokeheartgold` commit `9d8b7591f09b65804da2fb2dfd56f320633e0d36`.
- The current route covers all 8 Johto Gym Leaders, the Elite Four, and Champion Lance.
- Explicit trainer moves and held items are mapped into Showdown Gen 4 sets.
- NPC IVs reproduce HGSS's `floor(difficulty * 31 / 255)` formula.
- Trainer class/gender metadata and the HGSS LCRNG path reproduce deterministic NPC personality, nature, and ability slot.
- Battles are deterministic by seed and can be repeated.
- The player-side policy can voluntarily switch when a bench matchup is materially better; the NPC side remains attack-focused to avoid inventing aggressive trainer switching.
- Candidate levels are still normalized to each boss's ace level for the battle itself.

### Acquisition and evolution

The main canonical pool is built from the game data rather than a handwritten tier list.

- Wild availability comes from `gs_enc_data.json`.
- Headbutt candidates and Lv ranges come from `files/arc/headbutt.json` once Headbutt is available.
- HeartGold/SoulSilver version differences are resolved from the source data.
- Story-accessible maps and method unlocks are defined in `config/story-access.canonical.json`.
- Gifts/statics/headbutt exceptions are auditable manual acquisitions.
- Unambiguous level evolutions are derived from `evo.json`.
- Duplicate evolution families and mutually exclusive starters are rejected.
- Wild encounter min/max levels are retained as `entryLevelMin/Max`.
- Verified manual acquisition levels are recorded where source scripts make them explicit.

The current conservative canonical route produces **98 candidate acquisitions** for HeartGold and **98** for SoulSilver, with version-specific stage distributions. Headbutt candidates and their encounter levels are sourced from `files/arc/headbutt.json` after the story unlock.

A smaller curated pool remains as a regression/reference path; every candidate points to encounter/headbutt/script evidence and is validated against the pinned source.

### Move access

Move selection is stage-aware.

- Level-up moves come from Gen 4 learnsets.
- Johto HMs are modeled as reusable machines with story acquisition stages.
- A first source-backed set of one-use story TMs is modeled, including the Johto Gym rewards plus early TM70/TM05.
- Each one-use TM gets a persistent owner within a candidate team; the same TM cannot be assigned to multiple members.
- Machine compatibility is checked against Gen 4 learnsets.

This is intentionally conservative: the full set of overworld/shop/Game Corner/Tutor moves is not modeled yet.

### Search

Two strategies are available:

- `prefix`: deterministic regression/simple search over the first legal combinations.
- `beam`: actual battle simulations first screen individual candidates, then iteratively keep the strongest partial teams.

A starter can be fixed:

```bash
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --runs=3 --screen-runs=1 --beam-width=8 --candidate-cap=24 --team-size=6
```

The search output now includes:

- aggregate boss win rate;
- boss-by-boss results;
- persistent one-use TM ownership plan;
- `catchUpLevels`: a first acquisition-level burden metric.

`catchUpLevels` is deliberately kept separate from win rate for now, so Pareto output can compare battle strength against grinding burden rather than hiding an arbitrary weight inside one score.

Final beam survivors can be rescored across multiple deterministic RNG seeds with `--final-runs=N`; the CI preliminary optimizer uses 10 runs per boss for the finalists.

## Setup

Requires Node.js 22.18+.

```bash
cd hgss_story_sim
npm install
```

## Commands

```bash
# source-backed curated validation
npm run validate

# inspect canonical pools
npm run pool -- --version=HEARTGOLD
npm run pool -- --version=SOULSILVER
npm run pool -- --version=HEARTGOLD --full=true

# curated baseline through all 13 bosses
npm run simulate -- --runs=20

# canonical beam search, fixed starter
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=beam --starter=Cyndaquil --runs=3 --screen-runs=1 --beam-width=8 --candidate-cap=24 --team-size=6

# HG/SS × all three starters; candidate screening is reused per version
npm run optimize -- --versions=HEARTGOLD,SOULSILVER --starters=Chikorita,Cyndaquil,Totodile --runs=1 --screen-runs=1 --final-runs=10 --beam-width=3 --candidate-cap=12 --team-size=6

# simple/prefix search
npm run search -- --pool=canonical --version=HEARTGOLD --strategy=prefix --runs=1 --limit=100 --team-size=6

# regression checks
npm run smoke
npm run hm-smoke
npm run tm-smoke
```

## Story stages

`availableFrom` is the zero-based position in `config/story-bosses.json`:

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

## Current approximations

This is not yet a bit-perfect HGSS story emulator.

- Trainer bag-item use is not modeled.
- Battle decisions use a deterministic heuristic policy (including conservative player switching) rather than an exhaustive optimal controller or exact HGSS AI flags.
- Story map/method unlock stages are conservative curated checkpoints, not a full map-event reachability graph.
- Friendship, stone, trade, move-known, and location evolutions remain conservative/manual.
- Only a subset of story TMs is modeled; shops, many overworld TMs, and tutors still need coverage.
- Equal-level battle normalization is still used; `catchUpLevels` only records an entry-level burden and is not a full EXP/time simulator.
- Beam search is heuristic, not a proof of the globally optimal team.
- Search does not yet emit a true Pareto frontier.

## CI coverage

GitHub Actions verifies:

- dependency install and syntax checks;
- curated source-backed acquisition validation;
- a real Falkner battle;
- a targeted player-side matchup-switch case;
- reusable-HM timing;
- one-use TM ownership;
- one full pass over all 13 Johto/E4/Lance bosses;
- HeartGold and SoulSilver canonical pools;
- canonical prefix-search smoke;
- beam-search smoke.

A heavier six-search preliminary optimization (HG/SS × three starters) only runs on push commits whose message contains `[optimize]`.

## Next milestones

1. Expand source-backed TM/shop/tutor coverage.
2. Turn entry-level burden into a better EXP/grinding-time model and Pareto objective.
3. Improve trainer AI/item-use fidelity.
4. Increase optimizer breadth and compare multiple search strategies.
5. Extend through Kanto and Red.
