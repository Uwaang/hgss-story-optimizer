import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { hgssTrainerToShowdownTeam, materializeCandidateTeam, simulateMatchup } from './battle.mjs';
import {
  deriveLevelEvolutionStages,
  loadPretAvailabilityData,
  teamRespectsExclusiveGroups,
  validateAndResolveCandidates,
} from './availability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'));
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadBossContext() {
  const config = await readJson('config/story-bosses.json');
  const source = await loadPretTrainerData(config.sourceCommit);
  return {
    config,
    bosses: extractBosses(source, config),
  };
}

function selectByNames(candidates, names) {
  if (!Array.isArray(names) || !names.length) return candidates;
  const byName = new Map(candidates.map(candidate => [candidate.species, candidate]));
  return names.map(name => {
    const candidate = byName.get(name);
    if (!candidate) throw new Error(`Baseline candidate not found: ${name}`);
    return candidate;
  });
}

async function loadResolvedPool(poolPath, context) {
  const [pool, access, availability] = await Promise.all([
    readJson(poolPath),
    readJson('config/story-access.json'),
    loadPretAvailabilityData(context.config.sourceCommit),
  ]);

  const validation = await validateAndResolveCandidates(
    pool.candidates || [],
    access,
    availability,
    context.config.sourceCommit,
  );
  if (!validation.ok) {
    const failures = validation.rows.filter(row => !row.ok);
    throw new Error(`Candidate source validation failed: ${JSON.stringify(failures)}`);
  }

  const candidates = deriveLevelEvolutionStages(
    validation.candidates,
    context.bosses,
    availability.evolutions,
  );

  return {
    pool,
    access,
    availability,
    validation,
    candidates,
    baseline: selectByNames(candidates, pool.baselineTeam),
  };
}

async function cmdExtract() {
  const context = await loadBossContext();
  const compact = context.bosses.map(boss => ({
    stage: boss.stage,
    key: boss.key,
    label: boss.label,
    trainerId: boss.trainerId,
    aceLevel: boss.aceLevel,
    party: boss.trainer.party,
  }));
  console.log(JSON.stringify(compact, null, 2));
}

async function evaluateCandidates(candidates, bosses, runs) {
  const rows = [];
  let weightedWins = 0;
  let weightedRuns = 0;
  for (const boss of bosses) {
    const playerTeam = materializeCandidateTeam(candidates, boss.stage, boss.aceLevel);
    if (!playerTeam.length) {
      rows.push({ boss: boss.label, skipped: true, reason: 'no available candidates' });
      continue;
    }
    const enemyTeam = hgssTrainerToShowdownTeam(boss.trainer, boss);
    const result = await simulateMatchup(playerTeam, enemyTeam, runs, 1000 + boss.stage * 100000);
    weightedWins += result.wins;
    weightedRuns += result.runs;
    rows.push({
      boss: boss.label,
      aceLevel: boss.aceLevel,
      availableMons: playerTeam.map(x => x.species),
      ...result,
    });
  }
  return {
    score: weightedRuns ? weightedWins / weightedRuns : 0,
    rows,
  };
}

async function cmdValidate() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  const context = await loadBossContext();
  const resolved = await loadResolvedPool(poolPath, context);
  console.log(JSON.stringify({
    sourceCommit: context.config.sourceCommit,
    pool: poolPath,
    sources: resolved.validation.rows,
    derivedCandidates: resolved.candidates.map(candidate => ({
      species: candidate.species,
      availableFrom: candidate.availableFrom,
      exclusiveGroup: candidate.exclusiveGroup || null,
      speciesByStage: candidate.speciesByStage || [],
      sourceEvidence: candidate.sourceEvidence,
    })),
    baselineTeam: resolved.baseline.map(candidate => candidate.species),
  }, null, 2));
}

async function cmdSimulate() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  const runs = Number(arg('runs', '20'));
  const context = await loadBossContext();
  const resolved = await loadResolvedPool(poolPath, context);
  if (!teamRespectsExclusiveGroups(resolved.baseline)) {
    throw new Error('baselineTeam violates exclusiveGroup constraints');
  }
  const result = await evaluateCandidates(resolved.baseline, context.bosses, runs);
  console.log(JSON.stringify({
    pool: poolPath,
    baselineTeam: resolved.baseline.map(candidate => candidate.species),
    runsPerBoss: runs,
    ...result,
  }, null, 2));
}

function * combinations(values, choose, start = 0, prefix = []) {
  if (prefix.length === choose) {
    yield prefix.slice();
    return;
  }
  const remaining = choose - prefix.length;
  for (let i = start; i <= values.length - remaining; i += 1) {
    prefix.push(values[i]);
    yield * combinations(values, choose, i + 1, prefix);
    prefix.pop();
  }
}

async function cmdSearch() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  const runs = Number(arg('runs', '5'));
  const teamSize = Number(arg('team-size', '6'));
  const limit = Number(arg('limit', '100'));
  const context = await loadBossContext();
  const resolved = await loadResolvedPool(poolPath, context);
  const candidates = resolved.candidates;

  if (candidates.length < teamSize) throw new Error('Candidate pool is smaller than team-size');

  const results = [];
  let tested = 0;
  let rejectedByConstraints = 0;
  for (const team of combinations(candidates, teamSize)) {
    if (!teamRespectsExclusiveGroups(team)) {
      rejectedByConstraints += 1;
      continue;
    }
    const evaluation = await evaluateCandidates(team, context.bosses, runs);
    results.push({
      score: evaluation.score,
      team: team.map(x => x.species),
      bosses: evaluation.rows.map(row => ({
        boss: row.boss,
        winRate: row.winRate,
        skipped: row.skipped || false,
      })),
    });
    tested += 1;
    if (tested >= limit) break;
  }
  results.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({
    tested,
    rejectedByConstraints,
    runsPerBoss: runs,
    top: results.slice(0, 20),
  }, null, 2));
}

async function cmdSmoke() {
  const context = await loadBossContext();
  const falkner = context.bosses[0];
  const enemyTeam = hgssTrainerToShowdownTeam(falkner.trainer, falkner);
  const resolved = await loadResolvedPool('config/candidates.example.json', context);
  const playerTeam = materializeCandidateTeam(resolved.baseline, falkner.stage, falkner.aceLevel);
  const battle = await simulateMatchup(playerTeam, enemyTeam, 1, 4242);
  console.log(JSON.stringify({
    source: falkner.key,
    trainerId: falkner.trainerId,
    aceLevel: falkner.aceLevel,
    playerTeam: playerTeam.map(mon => mon.species),
    showdownTeam: enemyTeam,
    battle,
  }, null, 2));
}

const command = process.argv[2] || 'smoke';
const commands = {
  extract: cmdExtract,
  validate: cmdValidate,
  simulate: cmdSimulate,
  search: cmdSearch,
  smoke: cmdSmoke,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, extract, validate, simulate, search');
  process.exitCode = 2;
} else {
  await commands[command]();
}
