import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { hgssTrainerToShowdownTeam, materializeCandidateTeam, planSingleUseMachines, runBattle, simulateMatchup } from './battle.mjs';
import { buildCanonicalCandidatePool, validateCandidateTeam } from './acquisition.mjs';
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

async function loadMoveAccess() {
  const config = await readJson('config/move-access.json');
  if (!Array.isArray(config.reusableMachines)) {
    throw new Error('move-access.json must contain reusableMachines[]');
  }
  if (!Array.isArray(config.singleUseMachines)) {
    throw new Error('move-access.json must contain singleUseMachines[]');
  }
  return config;
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

async function loadCanonicalPool(version, story = null) {
  const context = story || await loadStory();
  const access = await readJson('config/story-access.canonical.json');
  return buildCanonicalCandidatePool({
    commit: context.config.sourceCommit,
    bosses: context.bosses,
    access,
    version,
  });
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

async function loadCuratedPool(poolPath, story) {
  const [pool, access, availability] = await Promise.all([
    readJson(poolPath),
    readJson('config/story-access.json'),
    loadPretAvailabilityData(story.config.sourceCommit),
  ]);

  const validation = await validateAndResolveCandidates(
    pool.candidates || [],
    access,
    availability,
    story.config.sourceCommit,
  );
  if (!validation.ok) {
    const failures = validation.rows.filter(row => !row.ok);
    throw new Error(`Candidate source validation failed: ${JSON.stringify(failures)}`);
  }

  const candidates = deriveLevelEvolutionStages(
    validation.candidates,
    story.bosses,
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
  const story = await loadStory();
  const compact = story.bosses.map(boss => ({
    stage: boss.stage,
    key: boss.key,
    label: boss.label,
    trainerId: boss.trainerId,
    aceLevel: boss.aceLevel,
    party: boss.trainer.party,
  }));
  console.log(JSON.stringify(compact, null, 2));
}

function estimateCatchUpLevels(candidates, bosses) {
  const details = [];
  let total = 0;
  let unknown = 0;

  for (const candidate of candidates) {
    // Stage-0 members are assumed to level naturally during the opening route.
    if (Number(candidate.availableFrom || 0) <= 0) {
      details.push({
        species: candidate.species,
        availableFrom: Number(candidate.availableFrom || 0),
        entryLevelMax: candidate.entryLevelMax ?? null,
        targetLevel: bosses[0]?.aceLevel ?? null,
        catchUpLevels: 0,
        assumedNaturalOpening: true,
      });
      continue;
    }

    const firstBoss = bosses.find(boss => boss.stage >= Number(candidate.availableFrom || 0));
    const entryLevel = Number(candidate.entryLevelMax);
    if (!firstBoss || !Number.isFinite(entryLevel)) {
      unknown += 1;
      details.push({
        species: candidate.species,
        availableFrom: Number(candidate.availableFrom || 0),
        entryLevelMax: candidate.entryLevelMax ?? null,
        targetLevel: firstBoss?.aceLevel ?? null,
        catchUpLevels: null,
      });
      continue;
    }

    const deficit = Math.max(0, Number(firstBoss.aceLevel) - entryLevel);
    total += deficit;
    details.push({
      species: candidate.species,
      availableFrom: Number(candidate.availableFrom || 0),
      entryLevelMax: entryLevel,
      targetLevel: firstBoss.aceLevel,
      catchUpLevels: deficit,
    });
  }

  return { total, unknown, details };
}

async function evaluateCandidates(candidates, bosses, runs, moveAccess) {
  const rows = [];
  const catchUp = estimateCatchUpLevels(candidates, bosses);
  const singleUsePlan = planSingleUseMachines(candidates, bosses, moveAccess);
  let weightedWins = 0;
  let weightedRuns = 0;
  for (const boss of bosses) {
    const playerTeam = materializeCandidateTeam(
      candidates,
      boss.stage,
      boss.aceLevel,
      { moveAccess, singleUsePlan },
    );
    if (!playerTeam.length) {
      weightedRuns += runs;
      rows.push({
        boss: boss.label,
        aceLevel: boss.aceLevel,
        skipped: true,
        reason: 'no available candidates',
        runs,
        wins: 0,
        losses: runs,
        ties: 0,
        winRate: 0,
        averageTurns: 0,
      });
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
    catchUpLevels: catchUp.total,
    catchUpUnknown: catchUp.unknown,
    catchUpDetails: catchUp.details,
    singleUsePlan,
    rows,
  };
}

async function cmdPool() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const full = arg('full', 'false') === 'true';
  const story = await loadStory();
  const pool = await loadCanonicalPool(version, story);

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
      entryLevelMin: mon.entryLevelMin ?? null,
      entryLevelMax: mon.entryLevelMax ?? null,
      speciesByStage: mon.speciesByStage,
      sourceTypes: [...new Set(mon.sources.map(x => x.type))],
    })),
  }, null, 2));
}

async function cmdValidate() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  if (poolPath === 'canonical') {
    const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
    const story = await loadStory();
    const pool = await loadCanonicalPool(version, story);
    console.log(JSON.stringify({
      sourceCommit: story.config.sourceCommit,
      pool: 'canonical',
      version,
      candidateCount: pool.candidates.length,
      valid: pool.candidates.length >= 6,
    }, null, 2));
    return;
  }

  const story = await loadStory();
  const resolved = await loadCuratedPool(poolPath, story);
  console.log(JSON.stringify({
    sourceCommit: story.config.sourceCommit,
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
  if (poolPath === 'canonical') {
    throw new Error('simulate requires an explicit team/baseline; use search --pool=canonical for generated candidates');
  }

  const story = await loadStory();
  const resolved = await loadCuratedPool(poolPath, story);
  if (!teamRespectsExclusiveGroups(resolved.baseline) || !validateCandidateTeam(resolved.baseline)) {
    throw new Error('baselineTeam violates team constraints');
  }

  const moveAccess = await loadMoveAccess();
  const result = await evaluateCandidates(resolved.baseline, story.bosses, runs, moveAccess);
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


function candidateIdentity(candidate) {
  return candidate.familyId || candidate.species;
}

function findStarterCandidate(candidates, requested) {
  if (!requested || String(requested).toLowerCase() === 'any') return null;
  const wanted = String(requested).toLowerCase();
  const candidate = candidates.find(mon => mon.species.toLowerCase() === wanted);
  if (!candidate) throw new Error(`Requested starter not found in pool: ${requested}`);
  if (candidate.exclusiveGroup !== 'starter') {
    throw new Error(`Requested --starter is not marked as a starter: ${candidate.species}`);
  }
  return candidate;
}

function paretoFront(rows) {
  return rows.filter((row, index) => !rows.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const atLeastAsGood =
      other.score >= row.score &&
      other.catchUpLevels <= row.catchUpLevels &&
      other.catchUpUnknown <= row.catchUpUnknown;
    const strictlyBetter =
      other.score > row.score ||
      other.catchUpLevels < row.catchUpLevels ||
      other.catchUpUnknown < row.catchUpUnknown;
    return atLeastAsGood && strictlyBetter;
  }));
}

function searchResultRow(team, evaluation) {
  return {
    score: evaluation.score,
    catchUpLevels: evaluation.catchUpLevels,
    catchUpUnknown: evaluation.catchUpUnknown,
    team: team.map(x => x.species),
    singleUsePlan: evaluation.singleUsePlan,
    bosses: evaluation.rows.map(row => ({
      boss: row.boss,
      winRate: row.winRate,
      skipped: row.skipped || false,
    })),
  };
}

async function screenCandidates(candidates, story, moveAccess, screenRuns) {
  const rows = [];
  for (const candidate of candidates) {
    const evaluation = await evaluateCandidates([candidate], story.bosses, screenRuns, moveAccess);
    rows.push({ candidate, evaluation });
  }
  rows.sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    a.candidate.availableFrom - b.candidate.availableFrom ||
    a.candidate.species.localeCompare(b.candidate.species)
  );
  return rows;
}

async function runBeamSearch({
  candidates,
  story,
  moveAccess,
  runs,
  teamSize,
  beamWidth,
  candidateCap,
  screenRuns,
  finalRuns,
  requiredCandidate,
  screenRowsOverride = null,
}) {
  const screenRows = screenRowsOverride || await screenCandidates(candidates, story, moveAccess, screenRuns);

  let screened = screenRows.slice(0, Math.min(candidateCap, screenRows.length)).map(row => row.candidate);
  if (requiredCandidate && !screened.some(mon => candidateIdentity(mon) === candidateIdentity(requiredCandidate))) {
    screened = [requiredCandidate, ...screened.slice(0, Math.max(0, candidateCap - 1))];
  }

  const cache = new Map();
  async function evaluateTeam(team) {
    const key = team.map(candidateIdentity).sort().join('|') + `@runs=${runs}`;
    if (!cache.has(key)) {
      cache.set(key, await evaluateCandidates(team, story.bosses, runs, moveAccess));
    }
    return cache.get(key);
  }

  let beam = [];
  if (requiredCandidate) {
    beam = [{ team: [requiredCandidate], evaluation: await evaluateTeam([requiredCandidate]) }];
  } else {
    beam = [{ team: [], evaluation: null }];
  }

  const startSize = requiredCandidate ? 2 : 1;
  for (let targetSize = startSize; targetSize <= teamSize; targetSize += 1) {
    const expanded = [];
    const seenTeams = new Set();

    for (const state of beam) {
      const existing = new Set(state.team.map(candidateIdentity));
      for (const candidate of screened) {
        if (existing.has(candidateIdentity(candidate))) continue;
        const team = [...state.team, candidate];
        if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) continue;
        const key = team.map(candidateIdentity).sort().join('|');
        if (seenTeams.has(key)) continue;
        seenTeams.add(key);
        const evaluation = await evaluateTeam(team);
        expanded.push({ team, evaluation });
      }
    }

    expanded.sort((a, b) =>
      b.evaluation.score - a.evaluation.score ||
      a.team.map(x => x.species).sort().join('|').localeCompare(b.team.map(x => x.species).sort().join('|'))
    );
    beam = expanded.slice(0, beamWidth);
    if (!beam.length) break;
  }

  const finalStates = [];
  for (const state of beam) {
    const evaluation = Number(finalRuns) === Number(runs)
      ? state.evaluation
      : await evaluateCandidates(state.team, story.bosses, finalRuns, moveAccess);
    finalStates.push({ team: state.team, evaluation });
  }
  finalStates.sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    a.evaluation.catchUpLevels - b.evaluation.catchUpLevels ||
    a.team.map(x => x.species).sort().join('|').localeCompare(b.team.map(x => x.species).sort().join('|'))
  );

  const top = finalStates.map(state => searchResultRow(state.team, state.evaluation));
  return {
    scannedCandidates: screenRows.length,
    screenedCandidates: screened.length,
    screenTop: screenRows.slice(0, Math.min(20, screenRows.length)).map(row => ({
      species: row.candidate.species,
      availableFrom: row.candidate.availableFrom,
      score: row.evaluation.score,
      catchUpLevels: row.evaluation.catchUpLevels,
      catchUpUnknown: row.evaluation.catchUpUnknown,
    })),
    evaluatedTeams: cache.size,
    finalRescoredTeams: finalStates.length,
    finalRunsPerBoss: finalRuns,
    paretoFront: paretoFront(top),
    top,
  };
}

async function cmdSearch() {
  const poolPath = arg('pool', 'config/candidates.example.json');
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const strategy = String(arg('strategy', 'prefix')).toLowerCase();
  const starterName = arg('starter', 'any');
  const runs = Number(arg('runs', '5'));
  const teamSize = Number(arg('team-size', '6'));
  const limit = Number(arg('limit', '100'));
  const beamWidth = Number(arg('beam-width', '8'));
  const candidateCap = Number(arg('candidate-cap', '24'));
  const screenRuns = Number(arg('screen-runs', '1'));
  const finalRuns = Number(arg('final-runs', String(runs)));
  const story = await loadStory();

  let candidates;
  if (poolPath === 'canonical') {
    candidates = (await loadCanonicalPool(version, story)).candidates;
  } else {
    candidates = (await loadCuratedPool(poolPath, story)).candidates;
  }

  if (candidates.length < teamSize) throw new Error('Candidate pool is smaller than team-size');
  const requiredCandidate = findStarterCandidate(candidates, starterName);
  const moveAccess = await loadMoveAccess();

  if (strategy === 'beam') {
    const result = await runBeamSearch({
      candidates,
      story,
      moveAccess,
      runs,
      teamSize,
      beamWidth,
      candidateCap,
      screenRuns,
      finalRuns,
      requiredCandidate,
    });
    console.log(JSON.stringify({
      pool: poolPath,
      version: poolPath === 'canonical' ? version : undefined,
      strategy,
      starter: requiredCandidate?.species || 'any',
      runsPerBoss: runs,
      screenRunsPerBoss: screenRuns,
      finalRunsPerBoss: finalRuns,
      beamWidth,
      candidateCap,
      ...result,
    }, null, 2));
    return;
  }

  if (strategy !== 'prefix') {
    throw new Error(`Unknown search strategy: ${strategy}`);
  }

  const results = [];
  let tested = 0;
  let rejectedByConstraints = 0;
  const choose = requiredCandidate ? teamSize - 1 : teamSize;
  const combinationPool = requiredCandidate
    ? candidates.filter(mon => candidateIdentity(mon) !== candidateIdentity(requiredCandidate))
    : candidates;

  for (const combo of combinations(combinationPool, choose)) {
    const team = requiredCandidate ? [requiredCandidate, ...combo] : combo;
    if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) {
      rejectedByConstraints += 1;
      continue;
    }
    const evaluation = await evaluateCandidates(team, story.bosses, runs, moveAccess);
    results.push(searchResultRow(team, evaluation));
    tested += 1;
    if (tested >= limit) break;
  }

  results.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({
    pool: poolPath,
    version: poolPath === 'canonical' ? version : undefined,
    strategy,
    starter: requiredCandidate?.species || 'any',
    tested,
    rejectedByConstraints,
    runsPerBoss: runs,
    paretoFront: paretoFront(results),
    top: results.slice(0, 20),
  }, null, 2));
}

async function cmdOptimize() {
  const versions = String(arg('versions', 'HEARTGOLD,SOULSILVER'))
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  const starters = String(arg('starters', 'Chikorita,Cyndaquil,Totodile'))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const runs = Number(arg('runs', '1'));
  const screenRuns = Number(arg('screen-runs', '1'));
  const finalRuns = Number(arg('final-runs', '10'));
  const beamWidth = Number(arg('beam-width', '3'));
  const candidateCap = Number(arg('candidate-cap', '12'));
  const teamSize = Number(arg('team-size', '6'));

  const story = await loadStory();
  const moveAccess = await loadMoveAccess();
  const output = {
    runsPerBoss: runs,
    screenRunsPerBoss: screenRuns,
    finalRunsPerBoss: finalRuns,
    beamWidth,
    candidateCap,
    teamSize,
    versions: {},
  };

  for (const version of versions) {
    const pool = await loadCanonicalPool(version, story);
    const candidates = pool.candidates;
    const screenRows = await screenCandidates(candidates, story, moveAccess, screenRuns);
    output.versions[version] = {};

    for (const starterName of starters) {
      const requiredCandidate = findStarterCandidate(candidates, starterName);
      const result = await runBeamSearch({
        candidates,
        story,
        moveAccess,
        runs,
        teamSize,
        beamWidth,
        candidateCap,
        screenRuns,
        finalRuns,
        requiredCandidate,
        screenRowsOverride: screenRows,
      });
      output.versions[version][requiredCandidate.species] = {
        scannedCandidates: result.scannedCandidates,
        screenedCandidates: result.screenedCandidates,
        evaluatedTeams: result.evaluatedTeams,
        paretoFront: result.paretoFront,
        top: result.top,
      };
    }
  }

  const serialized = JSON.stringify(output, null, 2);
  const outputPath = arg('output', '');
  if (outputPath) {
    const absolutePath = path.resolve(ROOT, outputPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, serialized + '\n', 'utf8');
    console.error(`wrote optimization result: ${absolutePath}`);
  }
  console.log(serialized);
}

async function cmdSwitchSmoke() {
  const playerTeam = [
    {
      species: 'Geodude',
      level: 20,
      ability: 'Rock Head',
      nature: 'Serious',
      moves: ['Tackle', 'Rock Throw'],
    },
    {
      species: 'Mareep',
      level: 20,
      ability: 'Static',
      nature: 'Serious',
      moves: ['ThunderShock', 'Tackle'],
    },
  ];
  const enemyTeam = [
    {
      species: 'Totodile',
      level: 20,
      ability: 'Torrent',
      nature: 'Serious',
      moves: ['Water Gun', 'Scratch'],
    },
  ];
  const result = await runBattle(playerTeam, enemyTeam, 7331);
  if (result.p1VoluntarySwitches < 1) {
    throw new Error(`Expected player-side matchup switch, got ${result.p1VoluntarySwitches}`);
  }
  if (result.p2VoluntarySwitches !== 0) {
    throw new Error(`NPC should not voluntarily switch, got ${result.p2VoluntarySwitches}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdHmSmoke() {
  const story = await loadStory();
  const [pool, moveAccess] = await Promise.all([
    loadCanonicalPool('HEARTGOLD', story),
    loadMoveAccess(),
  ]);
  const magikarp = pool.candidates.find(candidate => candidate.species === 'Magikarp');
  if (!magikarp) throw new Error('Magikarp not found in canonical pool');

  const singleUsePlan = planSingleUseMachines([magikarp], story.bosses, moveAccess);
  const beforeSurf = materializeCandidateTeam([magikarp], 2, 19, { moveAccess, singleUsePlan })[0];
  const afterSurf = materializeCandidateTeam([magikarp], 3, 25, { moveAccess, singleUsePlan })[0];

  if (beforeSurf.moves.includes('Surf')) {
    throw new Error('Surf became available before its acquisition stage');
  }
  if (afterSurf.species !== 'Gyarados') {
    throw new Error(`Expected Magikarp to evolve to Gyarados by stage 3, got ${afterSurf.species}`);
  }
  if (!afterSurf.moves.includes('Surf')) {
    throw new Error(`Expected stage-3 Gyarados to consider Surf, got ${afterSurf.moves.join(', ')}`);
  }

  console.log(JSON.stringify({
    beforeSurf: {
      stage: 2,
      species: beforeSurf.species,
      moves: beforeSurf.moves,
    },
    afterSurf: {
      stage: 3,
      species: afterSurf.species,
      moves: afterSurf.moves,
    },
  }, null, 2));
}

async function cmdTmSmoke() {
  const story = await loadStory();
  const [pool, moveAccess] = await Promise.all([
    loadCanonicalPool('HEARTGOLD', story),
    loadMoveAccess(),
  ]);
  const names = ['Pidgey', 'Hoothoot'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`${name} not found in canonical pool`);
    return candidate;
  });

  const singleUsePlan = planSingleUseMachines(team, story.bosses, moveAccess);
  const tm51Owners = Object.entries(singleUsePlan)
    .filter(([, machines]) => machines.some(machine => machine.machine === 'TM51'))
    .map(([owner]) => owner);

  if (tm51Owners.length !== 1) {
    throw new Error(`Expected exactly one TM51 owner, got ${tm51Owners.length}`);
  }

  const before = materializeCandidateTeam(team, 0, 13, { moveAccess, singleUsePlan });
  const after = materializeCandidateTeam(team, 1, 17, { moveAccess, singleUsePlan });
  const beforeRoostUsers = before.filter(mon => mon.moves.includes('Roost')).length;
  const afterRoostUsers = after.filter(mon => mon.moves.includes('Roost')).length;

  if (beforeRoostUsers !== 0) {
    throw new Error('Roost became available before Falkner reward');
  }
  if (afterRoostUsers > 1) {
    throw new Error(`TM51 was consumed by more than one team member: ${afterRoostUsers}`);
  }

  console.log(JSON.stringify({
    tm51Owners,
    before: before.map(mon => ({ species: mon.species, moves: mon.moves })),
    after: after.map(mon => ({ species: mon.species, moves: mon.moves })),
  }, null, 2));
}

async function cmdSmoke() {
  const story = await loadStory();
  const falkner = story.bosses[0];
  const enemyTeam = hgssTrainerToShowdownTeam(falkner.trainer, falkner);
  const [resolved, moveAccess] = await Promise.all([
    loadCuratedPool('config/candidates.example.json', story),
    loadMoveAccess(),
  ]);
  const singleUsePlan = planSingleUseMachines(resolved.baseline, story.bosses, moveAccess);
  const playerTeam = materializeCandidateTeam(
    resolved.baseline,
    falkner.stage,
    falkner.aceLevel,
    { moveAccess, singleUsePlan },
  );
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
  validate: cmdValidate,
  simulate: cmdSimulate,
  search: cmdSearch,
  optimize: cmdOptimize,
  'switch-smoke': cmdSwitchSmoke,
  'hm-smoke': cmdHmSmoke,
  'tm-smoke': cmdTmSmoke,
  smoke: cmdSmoke,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, switch-smoke, hm-smoke, tm-smoke, extract, pool, validate, simulate, search, optimize');
  process.exitCode = 2;
} else {
  await commands[command]();
}
