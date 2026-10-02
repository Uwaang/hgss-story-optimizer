# Staged Route Search Operations

This document describes the checkpointed HGSS route-search infrastructure.

## Current branches

- `infra/staged-route-search-v1`: first successful staged/parallel prototype.
- `infra/staged-route-search-v2`: hardened version with checkpoint fingerprints,
  resume support, and cumulative/persistent battle-cache reuse.

Search semantics remain experimental. Infrastructure changes here must not be
interpreted as a new recommended Pokémon team.

## Full staged search

Workflow:

`.github/workflows/staged-route-search-v2.yml`

Pipeline:

```text
screen shards x4
  -> screen merge
  -> beam2 shards x3 -> merge/adaptive
  -> beam3 shards x3 -> merge/adaptive
  -> beam4 shards x3 -> merge/adaptive
  -> beam5 shards x3 -> merge/adaptive
  -> beam6 shards x3 -> merge/adaptive
  -> final 16-run validation
```

A merge stage writes a `checkpoint.json`. A checkpoint contains the selected
candidate keys, beam states/evaluations, timing information, and a compatibility
fingerprint.

## Compatibility fingerprint

The staged-search fingerprint hashes the semantic inputs that must agree before
one checkpoint can be reused:

- staged-search schema version
- staged-search semantics version
- HGSS story-data source commit
- battle-cache namespace
- version/starter/evolution policy
- resource/spend policy
- EXP profile and allocator
- entry-level and same-stage-join policy
- objective and route-grind-proxy settings

Beam shard, beam merge, and final-stage commands reject a checkpoint with a
different fingerprint.

Legacy v1 checkpoints do not contain a fingerprint. They may be upgraded only
through the explicit command:

```bash
node src/cli.mjs route-exp-story-stamp-checkpoint \
  --input=results/checkpoint.json \
  --allow-legacy=true \
  <the exact search arguments used by the checkpoint>
```

This is intentionally explicit. Normal staged commands do not silently accept
an unversioned checkpoint.

To inspect the fingerprint for a configuration:

```bash
node src/cli.mjs route-exp-story-fingerprint <search arguments>
```

## Stage resume

Workflow:

`.github/workflows/staged-route-resume-v1.yml`

Manual dispatch inputs:

- `source_run_id`: workflow run that owns the predecessor checkpoint artifact.
- `resume_stage`: `beam2`, `beam3`, `beam4`, `beam5`, `beam6`, or `final`.
- `final_after_beam6`: optionally run final validation immediately after a
  resumed beam6.

The workflow downloads the predecessor merge artifact, validates/stamps its
checkpoint, restores any compatible persistent cache, and resumes only the
requested stage. A resumed beam stage still uses 3 process-level shards.

Predecessor artifact mapping:

| Resume stage | Required predecessor artifact |
| --- | --- |
| beam2 | `staged-screen-merge` |
| beam3 | `staged-beam2-merge` |
| beam4 | `staged-beam3-merge` |
| beam5 | `staged-beam4-merge` |
| beam6 | `staged-beam5-merge` |
| final | `staged-beam6-merge` |

## Battle cache

The simulator already provides deterministic battle-level caching through:

- `HGSS_BATTLE_CACHE_PATH`
- namespace `hgss-battle-cache-v2`

v1 limitation: merge artifacts contained caches, but the next beam shard did
not seed its local cache from the previous merge. Therefore v1 did not provide
continuous beam-to-beam cache reuse.

v2 behavior:

1. beam2 may restore a compatible cross-run persistent cache;
2. each later beam shard copies the previous stage merged cache into its own
   cache path before expansion;
3. shard caches are unioned at merge;
4. adaptive 2 -> 4 run evaluation reuses the corresponding 2-run battles;
5. final validation reuses the beam6 cache;
6. beam6/final caches are saved under immutable GitHub Actions cache keys whose
   prefix contains the staged-search fingerprint.

A cache hit is valid only because the battle-cache key includes the prepared
teams, seed, options, and cache namespace. The checkpoint fingerprint is a
separate guard for search-state compatibility.

## Parallelism

Use process/runner-level sharding before introducing in-process battle
parallelism. The current simulator and optimization caches were designed around
deterministic sequential calls inside one Node process.

Current defaults:

- screening: 4 shards
- beam expansion: 3 shards

Team expansion is assigned by a deterministic hash of the canonical team key,
so the same team generated from multiple parents is evaluated by only one
shard.

## Runtime profiling

Every checkpoint accumulates timing data:

- max shard wall time (critical path)
- sum of shard wall times
- merge/adaptive time
- expanded state count
- challenger/adaptive pool counts

The first staged v1 run, GitHub Actions run `36968404654`, completed in about
2h05m. Its critical path was dominated by beam4-6, especially beam6.

Do not compare only total workflow duration when changing shard count. Compare
stage critical-path time and runner-work sum to detect excessive orchestration
or duplicated work.

## Search-quality controls

Infrastructure speedups must preserve search semantics. At minimum, compare:

- final top teams and route-risk metrics;
- candidate/family screening set;
- beam state at each size;
- known historical control teams;
- hard checkpoints such as Clair, Lance, and Red.

The prior strong retry-family control is:

```text
Cyndaquil / Abra / Phanpy / Chinchou / Diglett / Ponyta
```

A faster workflow is not accepted as a search improvement merely because it
finds a different team.

## Do not mix infrastructure and search-policy changes

When validating staged/resume/cache work, avoid simultaneously changing:

- candidate screening semantics;
- route-risk objective;
- Bayesian racing policy;
- EXP allocator;
- player battle policy.

First establish semantic equivalence. Then iterate on search quality.
