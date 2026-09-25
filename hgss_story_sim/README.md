# HGSS story simulator

This module searches for strong Pokémon HeartGold/SoulSilver story parties by combining pinned `pret/pokeheartgold` game data with Pokémon Showdown's Gen 4 headless battle simulator.

## Current coverage

### Battle fidelity

- Boss rosters are fetched from pinned `pret/pokeheartgold` commit `9d8b7591f09b65804da2fb2dfd56f320633e0d36`.
- The route currently covers all 8 Johto Gym Leaders, the Elite Four, and Champion Lance.
- Explicit trainer moves and held items are mapped into Showdown Gen 4 sets.
- NPC IVs reproduce HGSS's `floor(difficulty * 31 / 255)` formula.
- Trainer class/gender metadata and the HGSS LCRNG path are used to reproduce deterministic NPC personality, nature, and ability slot.
- Battles are deterministic by seed and can be repeated for comparison.
- Candidate levels are currently normalized to each boss's ace level.

### Acquisition modeling

Two complementary paths are kept intentionally:

1. **Canonical generated pool** — the main search path.
   - Wild availability comes from `gs_enc_data.json`.
   - HeartGold/SoulSilver version differences are resolved from the source data.
   - Story-accessible maps and encounter-method unlocks are defined in `config/story-access.canonical.json`.
   - Gifts/statics/headbutt exceptions are added as auditable manual acquisitions.
   - Unambiguous level evolutions are derived from `evo.json`.
   - Duplicate evolution families and mutually exclusive starters are rejected.

2. **Curated source-validated pool** — a small regression/reference path.
   - Each candidate in `candidates.example.json` points to a source id in `config/story-access.json`.
   - The validator checks the pinned encounter/headbutt/script source before accepting the candidate.
   - This caught and corrected earlier modeling errors such as Mareep being available before Falkner and Gyarados appearing before Magikarp can reach level 20.

The current canonical generator produces **92 candidate acquisitions** for both HeartGold and SoulSilver on the conservative Johto route. The stage distribution differs where the versions differ.

## Setup

Requires Node.js 22.18+.

```bash
cd hgss_story_sim
npm install
```

## Commands

Validate the curated source-backed acquisition examples:

```bash
npm run validate
```

Inspect the generated canonical candidate pool:

```bash
npm run pool -- --version=HEARTGOLD
npm run pool -- --version=SOULSILVER
npm run pool -- --version=HEARTGOLD --full=true
```

Run the curated baseline team through the full Johto/E4/Lance route:

```bash
npm run simulate -- --runs=20
```

Search teams from the generated HeartGold pool:

```bash
npm run search -- --pool=canonical --version=HEARTGOLD --runs=5 --limit=100 --team-size=6
```

SoulSilver works the same way:

```bash
npm run search -- --pool=canonical --version=SOULSILVER --runs=5 --limit=100 --team-size=6
```

Print the extracted boss dataset:

```bash
npm run extract
```

Run the quick battle smoke test:

```bash
npm run smoke
```

## Story stages

`availableFrom` is the zero-based index in `config/story-bosses.json`:

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

A candidate can only participate from its acquisition stage onward.

## Current approximations

This is not yet a bit-perfect HGSS story emulator.

- Trainer bag-item use is not modeled.
- Battle decisions use a deterministic greedy policy rather than the exact HGSS AI-flag implementation.
- Story map/method unlock stages are deliberately conservative and still curated rather than derived from a full map-event reachability graph.
- Friendship, stone, trade, move-known, and location-based evolutions are conservative/manual; only unambiguous level evolutions are automatic.
- TM/HM/tutor acquisition timing and one-use TM competition are not yet included in move selection.
- Equal-level normalization does not model the actual EXP curve or grinding time.
- Search currently optimizes aggregate boss win rate only; it does not yet produce a Pareto frontier over grinding, acquisition timing, TM cost, or real-time convenience.

## CI coverage

The GitHub Actions workflow currently verifies all of these paths:

- dependency install and syntax checks;
- curated source-backed acquisition validation;
- a real Falkner battle;
- one full pass over all 13 Johto/E4/Lance bosses;
- HeartGold canonical candidate generation;
- SoulSilver canonical candidate generation;
- a canonical-pool team-search smoke test.

## Next fidelity milestones

1. Add TM/HM/tutor acquisition constraints and resource ownership.
2. Add EXP/grinding-time cost.
3. Port the relevant HGSS trainer item-use and AI behavior.
4. Replace brute-force-prefix search with a better optimizer (beam/genetic/branch-and-bound) and Pareto objectives.
5. Extend beyond Lance through Kanto and Red.
