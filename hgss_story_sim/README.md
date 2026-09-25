# HGSS story simulator MVP

This module evaluates candidate HeartGold/SoulSilver story parties by repeatedly running the original HGSS boss rosters through Pokemon Showdown's Gen 4 headless battle simulator.

## What is already modeled

- Original HGSS trainer rosters are fetched from a pinned `pret/pokeheartgold` commit.
- Trainer IDs are resolved from `include/constants/trainers.h`; no manually copied boss stats are required.
- The default route contains the 8 Johto Gym Leaders, Elite Four, and Champion Lance.
- Explicit HGSS held items and moves are mapped into Showdown sets.
- HGSS trainer IVs use the original formula from `CreateNPCTrainerParty`: `floor(difficulty * 31 / 255)` for every stat.
- HGSS trainer class/gender metadata is parsed from the same pinned source, and the original LCRNG path is reproduced to derive deterministic NPC personality, nature, and ability slot.
- If a trainer/candidate has no explicit moves, Gen 4 level-up moves are reconstructed from Pokemon Showdown learnsets.
- Candidate availability can be staged with `availableFrom`, and evolutions can be represented with `speciesByStage`, so a late-game form is not used against an early Gym.
- Candidate levels are normalized to each boss's ace level for the first MVP, avoiding a hidden grinding assumption.
- Battles are deterministic by seed and can be repeated for Monte Carlo-style comparison.
- `search` enumerates candidate-team combinations and ranks them by aggregate boss win rate.

## Important MVP approximations

This is not yet a bit-perfect HGSS emulator. The current branch intentionally separates the pieces that still need fidelity work:

1. Trainer bag-item usage (Potion, Full Restore, etc.) is not modeled by Pokemon Showdown.
2. The battle policy is a simple deterministic greedy policy, not HGSS's exact AI-flag implementation.
3. Candidate acquisition stages in `candidates.example.json` are illustrative. A real optimization run should replace them with verified HGSS encounter/gift/evolution availability.
4. TM/HM/tutor availability and one-use TM competition are not modeled yet. Candidate moves default to level-up moves unless explicitly supplied.
5. Normalizing player levels to the boss ace level measures party efficiency at comparable levels; it does not yet model the HGSS EXP curve or required grinding time.

These limitations make the MVP useful for comparative experiments, but its output should not yet be called the definitive optimal HGSS story party.

## Setup

Requires Node.js 22.18+.

```bash
cd hgss_story_sim
npm install
```

## Commands

Verify that the pinned HGSS data can be read and converted:

```bash
npm run smoke
```

Print the extracted boss dataset:

```bash
npm run extract
```

Evaluate the example candidate party against all bosses, 20 runs per boss:

```bash
npm run simulate -- --runs=20
```

Search candidate combinations. The defaults intentionally stay small because each team triggers many full battles:

```bash
npm run search -- --runs=5 --limit=100 --team-size=6
```

Use a custom pool:

```bash
npm run search -- --pool=config/my-candidates.json --runs=20 --limit=1000
```

## Candidate format

```json
{
  "candidates": [
    {
      "species": "Mareep",
      "availableFrom": 0,
      "speciesByStage": [{"stage": 1, "species": "Flaaffy"}, {"stage": 4, "species": "Ampharos"}],
      "moves": ["Thunderbolt", "Signal Beam", "Thunder Wave", "Light Screen"],
      "item": "Magnet"
    }
  ]
}
```

`availableFrom` is the zero-based position in `config/story-bosses.json`. `speciesByStage` can change the species/form used at later story stages. If `moves` is omitted, the simulator derives the last four Gen 4 level-up moves available at the boss level.

## Next fidelity milestones

- Port the relevant HGSS AI flags and trainer item-use rules.
- Build verified encounter/gift/evolution availability data by route and badge count.
- Add TM/HM/tutor acquisition constraints and one-use TM ownership.
- Replace equal-level normalization with an EXP/time cost model.
- Add beam/genetic search and Pareto objectives for win rate, grinding, acquisition timing, and TM cost.
- Extend after Lance to Kanto Gym Leaders and Red.


## CI coverage

The branch CI performs both a single Falkner battle smoke test and a one-run pass across all 13 Johto/E4/Lance bosses. This catches data-mapping and battle-stream regressions across the current story route.
