import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { hgssTrainerToShowdownTeam, materializeCandidateTeam, simulateMatchup } from './battle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'));
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadBosses() {
  const config = await readJson('config/story-bosses.json');
  const source = await loadPretTrainerData(config.sourceCommit);
  return extractBosses(source, config);
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
    const enemyTeam = hgssTrainerToShowdownTeam(boss.trainer);
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
  const runs = Number(arg('runs', '5'));
  const teamSize = Number(arg('team-size', '6'));
  const limit = Number(arg('limit', '100'));
  const pool = await readJson(poolPath);
  const bosses = await loadBosses();
  if (pool.candidates.length < teamSize) throw new Error('Candidate pool is smaller than team-size');
  const results = [];
  let tested = 0;
  for (const team of combinations(pool.candidates, teamSize)) {
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
  const enemyTeam = hgssTrainerToShowdownTeam(falkner.trainer);
  console.log(JSON.stringify({
    source: falkner.key,
    trainerId: falkner.trainerId,
    aceLevel: falkner.aceLevel,
    showdownTeam: enemyTeam,
  }, null, 2));
}

const command = process.argv[2] || 'smoke';
const commands = {
  extract: cmdExtract,
  simulate: cmdSimulate,
  search: cmdSearch,
  smoke: cmdSmoke,
};
if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, extract, simulate, search');
  process.exitCode = 2;
} else {
  await commands[command]();
}
