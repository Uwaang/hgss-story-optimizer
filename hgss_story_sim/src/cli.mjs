import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { hgssTrainerToShowdownTeam, materializeCandidateTeam, simulateMatchup } from './battle.mjs';
import { buildCanonicalCandidatePool, validateCandidateTeam } from './acquisition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'));
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadStory() {
  const config = await readJson('config/story-bosses.json');
  const source = await loadPretTrainerData(config.sourceCommit);
  return { config, source, bosses: extractBosses(source, config) };
}

async function loadBosses() {
  return (await loadStory()).bosses;
}

async function loadCanonicalPool(version) {
  const { config, bosses } = await loadStory();
  const access = await readJson('config/story-access.canonical.json');
  return buildCanonicalCandidatePool({
    commit: config.sourceCommit,
    bosses,
    access,
    version,
  });
}

async function cmdExtract() {
  const bosses = await loadBosses();
  const compact = bosses.map(boss => ({
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

async function cmdPool() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const full = arg('full', 'false') === 'true';
  const pool = await loadCanonicalPool(version);
  if (full) {
    console.log(JSON.stringify(pool, null, 2));
    return;
  }
  const byStage = {};
  for (const mon of pool.candidates) {
    byStage[mon.availableFrom] = (byStage[mon.availableFrom] || 0) + 1;
  }
  console.log(JSON.stringify({
    version: pool.version,
    sourceCommit: pool.sourceCommit,
    accessMode: pool.accessMode,
    candidateCount: pool.candidates.length,
    newCandidatesByStage: byStage,
    firstTwenty: pool.candidates.slice(0, 20).map(mon => ({
      species: mon.species,
      availableFrom: mon.availableFrom,
      familyId: mon.familyId,
      speciesByStage: mon.speciesByStage,
      sourceTypes: [...new Set(mon.sources.map(x => x.type))],
    })),
  }, null, 2));
}

async function cmdSimulate() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  const runs = Number(arg('runs', '20'));
  const pool = await readJson(poolPath);
  const bosses = await loadBosses();
  const result = await evaluateCandidates(pool.candidates, bosses, runs);
  console.log(JSON.stringify({ pool: poolPath, runsPerBoss: runs, ...result }, null, 2));
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
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const runs = Number(arg('runs', '5'));
  const teamSize = Number(arg('team-size', '6'));
  const limit = Number(arg('limit', '100'));
  const pool = poolPath === 'canonical' ? await loadCanonicalPool(version) : await readJson(poolPath);
  const bosses = await loadBosses();
  if (pool.candidates.length < teamSize) throw new Error('Candidate pool is smaller than team-size');
  const results = [];
  let tested = 0;
  for (const team of combinations(pool.candidates, teamSize)) {
    if (!validateCandidateTeam(team)) continue;
    const evaluation = await evaluateCandidates(team, bosses, runs);
    results.push({
      score: evaluation.score,
      team: team.map(x => x.species),
      bosses: evaluation.rows.map(row => ({ boss: row.boss, winRate: row.winRate, skipped: row.skipped || false })),
    });
    tested += 1;
    if (tested >= limit) break;
  }
  results.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({ tested, runsPerBoss: runs, top: results.slice(0, 20) }, null, 2));
}

async function cmdSmoke() {
  const bosses = await loadBosses();
  const falkner = bosses[0];
  const enemyTeam = hgssTrainerToShowdownTeam(falkner.trainer, falkner);
  const pool = await readJson('config/candidates.example.json');
  const playerTeam = materializeCandidateTeam(pool.candidates, falkner.stage, falkner.aceLevel);
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
  pool: cmdPool,
  simulate: cmdSimulate,
  search: cmdSearch,
  smoke: cmdSmoke,
};
if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, extract, pool, simulate, search');
  process.exitCode = 2;
} else {
  await commands[command]();
}
