import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { candidateMovePool, candidateMoveUtility, hgssTrainerToShowdownTeam, materializeCandidateTeam, planPurchasableMachines, planSingleUseMachines, runBattle, simulateMatchup } from './battle.mjs';
import { buildCanonicalCandidatePool, validateCandidateTeam } from './acquisition.mjs';
import { buildExpWorld, buildTeamExpSchedule } from './exp-budget.mjs';
import {
  deriveLevelEvolutionStages,
  loadPretAvailabilityData,
  teamRespectsExclusiveGroups,
  validateAndResolveCandidates,
} from './availability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONEY_PER_COIN = 20;

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'));
}

function normalizeResourceProfile(value) {
  const profile = String(value || 'all').toLowerCase();
  if (!['core', 'money', 'all'].includes(profile)) {
    throw new Error(`Unknown resource profile: ${value}. Use core, money, or all.`);
  }
  return profile;
}

function normalizeSpendPolicy(value) {
  const policy = String(value || 'unbounded').toLowerCase();
  if (!['unbounded', 'natural'].includes(policy)) {
    throw new Error(`Unknown spend policy: ${value}. Use unbounded or natural.`);
  }
  return policy;
}

function normalizeExpProfile(value) {
  const profile = String(value || 'ace').toLowerCase();
  if (!['ace', 'major', 'all-accessible'].includes(profile)) {
    throw new Error(`Unknown EXP profile: ${value}. Use ace, major, or all-accessible.`);
  }
  return profile;
}

function mergeExpAccess(baseAccess, expAccess) {
  const stages = new Map(
    (baseAccess?.stages || []).map(stage => [
      Number(stage.stage),
      { ...stage, addMaps: [...(stage.addMaps || [])] },
    ])
  );
  for (const extra of expAccess?.additionalStages || []) {
    const stage = Number(extra.stage);
    const current = stages.get(stage) || { stage, addMaps: [] };
    const maps = new Set([...(current.addMaps || []), ...(extra.maps || [])]);
    stages.set(stage, { ...current, addMaps: [...maps] });
  }
  return {
    ...baseAccess,
    stages: [...stages.values()].sort((a, b) => Number(a.stage) - Number(b.stage)),
  };
}

function normalizeGrindPolicy(value) {
  const policy = String(value || 'none').toLowerCase();
  if (!['none', 'ace-paid'].includes(policy)) {
    throw new Error(`Unknown grind policy: ${value}. Use none or ace-paid.`);
  }
  return policy;
}

async function loadExpContext(story, expProfile, version = 'HEARTGOLD', grindPolicy = 'none') {
  const profile = normalizeExpProfile(expProfile);
  const normalizedGrindPolicy = normalizeGrindPolicy(grindPolicy);
  if (profile === 'ace') return { profile, grindPolicy: 'none', world: null };
  const [baseAccess, expAccess] = await Promise.all([
    readJson('config/story-access.canonical.json'),
    readJson('config/exp-access.json'),
  ]);
  const access = mergeExpAccess(baseAccess, expAccess);
  const world = await buildExpWorld({
    commit: story.config.sourceCommit,
    access,
    trainerSource: story.source,
    version,
  });
  return { profile, grindPolicy: normalizedGrindPolicy, world };
}

async function loadMoveAccess(resourceProfile = 'all', spendPolicy = 'unbounded') {
  const config = await readJson('config/move-access.json');
  if (!Array.isArray(config.reusableMachines)) {
    throw new Error('move-access.json must contain reusableMachines[]');
  }
  if (!Array.isArray(config.singleUseMachines)) {
    throw new Error('move-access.json must contain singleUseMachines[]');
  }
  if (!Array.isArray(config.purchasableMachines)) {
    throw new Error('move-access.json must contain purchasableMachines[]');
  }

  const profile = normalizeResourceProfile(resourceProfile);
  let purchasableMachines = [];
  if (profile === 'money') {
    purchasableMachines = config.purchasableMachines.filter(machine => machine.currency === 'money');
  } else if (profile === 'all') {
    purchasableMachines = config.purchasableMachines;
  }

  return {
    ...config,
    resourceProfile: profile,
    spendPolicy: normalizeSpendPolicy(spendPolicy),
    purchasableMachines,
  };
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

function expAtLevel(growthRate, level) {
  const n = Math.max(1, Math.min(100, Math.floor(Number(level))));
  const rate = String(growthRate || '').replace(/^GROWTH_/, '');

  if (rate === 'MEDIUM_FAST') return n ** 3;
  if (rate === 'FAST') return Math.floor((4 * n ** 3) / 5);
  if (rate === 'SLOW') return Math.floor((5 * n ** 3) / 4);
  if (rate === 'MEDIUM_SLOW') {
    if (n <= 1) return 0;
    return Math.floor((6 * n ** 3) / 5 - 15 * n ** 2 + 100 * n - 140);
  }
  if (rate === 'ERRATIC') {
    if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
    if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
    if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
    return Math.floor((n ** 3 * (160 - n)) / 100);
  }
  if (rate === 'FLUCTUATING') {
    if (n <= 15) return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
    if (n <= 36) return Math.floor((n ** 3 * (n + 14)) / 50);
    return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
  }
  return null;
}

function estimateCatchUpLevels(candidates, bosses) {
  const details = [];
  let total = 0;
  let unknown = 0;
  let totalExp = 0;
  let expUnknown = 0;

  for (const candidate of candidates) {
    const availableFrom = Number(candidate.availableFrom || 0);
    const growthRate = candidate.growthRate || null;

    // Stage-0 members are assumed to level naturally during the opening route.
    if (availableFrom <= 0) {
      details.push({
        species: candidate.species,
        availableFrom,
        growthRate,
        entryLevelMax: candidate.entryLevelMax ?? null,
        targetLevel: bosses[0]?.aceLevel ?? null,
        catchUpLevels: 0,
        catchUpExp: 0,
        assumedNaturalOpening: true,
      });
      continue;
    }

    const firstBoss = bosses.find(boss => boss.stage >= availableFrom);
    const entryLevel = Number(candidate.entryLevelMax);
    if (!firstBoss || !Number.isFinite(entryLevel)) {
      unknown += 1;
      expUnknown += 1;
      details.push({
        species: candidate.species,
        availableFrom,
        growthRate,
        entryLevelMax: candidate.entryLevelMax ?? null,
        targetLevel: firstBoss?.aceLevel ?? null,
        catchUpLevels: null,
        catchUpExp: null,
      });
      continue;
    }

    const targetLevel = Number(firstBoss.aceLevel);
    const deficit = Math.max(0, targetLevel - entryLevel);
    total += deficit;

    let catchUpExp = 0;
    if (deficit > 0) {
      const startExp = expAtLevel(growthRate, entryLevel);
      const targetExp = expAtLevel(growthRate, targetLevel);
      if (startExp === null || targetExp === null) {
        catchUpExp = null;
        expUnknown += 1;
      } else {
        catchUpExp = Math.max(0, targetExp - startExp);
        totalExp += catchUpExp;
      }
    }

    details.push({
      species: candidate.species,
      availableFrom,
      growthRate,
      entryLevelMax: entryLevel,
      targetLevel,
      catchUpLevels: deficit,
      catchUpExp,
    });
  }

  return { total, unknown, totalExp, expUnknown, details };
}

function storyStarterFromCandidates(candidates) {
  return candidates.find(candidate => candidate.exclusiveGroup === 'starter')?.species || null;
}

function storyBattlesForCandidates(bosses, candidates) {
  const starter = storyStarterFromCandidates(candidates);
  return bosses.filter(boss =>
    !boss.appliesToStarter || (starter && boss.appliesToStarter === starter)
  );
}

function summarizeCaptureSearch(candidates) {
  let expectedEncounters = 0;
  let unknown = 0;
  let headbuttLowerBounds = 0;
  const details = [];

  for (const candidate of candidates) {
    const capture = candidate.captureSearch || { mode: 'unknown', expectedEncounters: null };
    const value = Number(capture.expectedEncounters);
    if (Number.isFinite(value)) {
      expectedEncounters += Math.max(0, value);
    } else {
      unknown += 1;
    }
    if (capture.mode === 'headbutt-lower-bound') headbuttLowerBounds += 1;
    details.push({
      species: candidate.species,
      mode: capture.mode,
      expectedEncounters: Number.isFinite(value) ? value : null,
      source: capture.source || null,
      catchRate: candidate.catchRate ?? null,
    });
  }

  return {
    expectedEncounters,
    unknown,
    headbuttLowerBounds,
    details,
  };
}

function naturalPurchaseBudget(expSchedule) {
  if (!expSchedule?.battles?.length) return null;
  const goldenrodStage = expSchedule.battles.filter(battle => Number(battle.stage) === 2);
  if (!goldenrodStage.length) return Number(expSchedule.startingMoney || 0);
  return Math.max(...goldenrodStage.map(battle => Number(battle.moneyBefore || 0)));
}

function summarizeResourceBudget(purchaseCosts, expSchedule = null, purchasePlanBudget = null) {
  const money = Number(purchaseCosts?.money || 0);
  const coins = Number(purchaseCosts?.coins || 0);
  const coinMoneyEquivalent = coins * MONEY_PER_COIN;
  const directPurchaseMoneyEquivalent = money + coinMoneyEquivalent;
  const naturalMoney = expSchedule ? Number(expSchedule.totalNaturalMoney || 0) : null;
  const moneyShortfall = naturalMoney === null
    ? null
    : Math.max(0, directPurchaseMoneyEquivalent - naturalMoney);

  return {
    money,
    coins,
    moneyPerCoin: MONEY_PER_COIN,
    coinMoneyEquivalent,
    directPurchaseMoneyEquivalent,
    naturalMoney,
    naturalPurchaseBudget: naturalPurchaseBudget(expSchedule),
    plannerBudget: purchasePlanBudget,
    moneyShortfall,
    interpretation: 'coin cost converted using the source-backed Game Corner desk rate',
  };
}

function evaluationResourceBurden(evaluation) {
  return Number(
    evaluation?.resourceBudget?.directPurchaseMoneyEquivalent ??
    Number(evaluation?.purchaseCosts?.money || 0) +
      Number(evaluation?.purchaseCosts?.coins || 0) * MONEY_PER_COIN
  );
}

function rowResourceBurden(row) {
  return Number(
    row?.resourceBudget?.directPurchaseMoneyEquivalent ??
    Number(row?.purchaseCosts?.money || 0) +
      Number(row?.purchaseCosts?.coins || 0) * MONEY_PER_COIN
  );
}

async function evaluateCandidatesWithMoveAccess(candidates, bosses, runs, moveAccess, expContext = null) {
  const rows = [];
  const routeBosses = storyBattlesForCandidates(bosses, candidates);
  const routeStarter = storyStarterFromCandidates(candidates);
  const expProfile = normalizeExpProfile(expContext?.profile || 'ace');
  const expSchedule = expProfile === 'ace'
    ? null
    : buildTeamExpSchedule({
        candidates,
        routeBosses,
        expWorld: expContext.world,
        profile: expProfile,
        grindPolicy: expContext?.grindPolicy || 'none',
      });
  const catchUp = estimateCatchUpLevels(candidates, routeBosses);
  const captureSearch = summarizeCaptureSearch(candidates);
  const singleUsePlan = planSingleUseMachines(candidates, routeBosses, moveAccess);
  const spendPolicy = normalizeSpendPolicy(moveAccess?.spendPolicy || 'unbounded');
  const naturalBudget = naturalPurchaseBudget(expSchedule);
  if (spendPolicy === 'natural' && naturalBudget === null) {
    throw new Error('spend-policy=natural requires a non-ace EXP profile');
  }
  const purchasable = planPurchasableMachines(
    candidates,
    routeBosses,
    moveAccess,
    singleUsePlan,
    spendPolicy === 'natural'
      ? { maxMoneyEquivalent: naturalBudget, moneyPerCoin: MONEY_PER_COIN }
      : {},
  );
  const purchasablePlan = purchasable.assignments;
  const purchaseCosts = purchasable.costs;
  const resourceBudget = summarizeResourceBudget(
    purchaseCosts,
    expSchedule,
    purchasable.budget || null,
  );
  let weightedWins = 0;
  let weightedRuns = 0;
  for (const [battleIndex, boss] of routeBosses.entries()) {
    const levelsByCandidate = expSchedule?.battles?.[battleIndex]?.levelsBefore || null;
    const playerTeam = materializeCandidateTeam(
      candidates,
      boss.stage,
      boss.aceLevel,
      { moveAccess, singleUsePlan, purchasablePlan, levelsByCandidate },
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
    const result = await simulateMatchup(
      playerTeam,
      enemyTeam,
      runs,
      1000 + boss.stage * 100000 + battleIndex * 1000,
    );
    weightedWins += result.wins;
    weightedRuns += result.runs;
    rows.push({
      boss: boss.label,
      aceLevel: boss.aceLevel,
      playerLevels: Object.fromEntries(playerTeam.map(mon => [mon.species, mon.level])),
      naturalExpBefore: expSchedule?.battles?.[battleIndex]?.mapExpBefore || 0,
      availableMons: playerTeam.map(x => x.species),
      ...result,
    });
  }
  const meanWinRate = weightedRuns ? weightedWins / weightedRuns : 0;
  const worstBossWinRate = rows.length
    ? Math.min(...rows.map(row => Number(row.winRate || 0)))
    : 0;
  const finalBattle = routeBosses[routeBosses.length - 1] || null;
  const finalLevelSnapshot = expSchedule?.battles?.[routeBosses.length - 1]?.levelsBefore || null;
  const finalMaterialized = finalBattle
    ? materializeCandidateTeam(
        candidates,
        finalBattle.stage,
        finalBattle.aceLevel,
        { moveAccess, singleUsePlan, purchasablePlan, levelsByCandidate: finalLevelSnapshot },
      )
    : [];
  const finalTeam = finalMaterialized.map(mon => mon.species);
  const finalLevels = Object.fromEntries(finalMaterialized.map(mon => [mon.species, mon.level]));

  return {
    score: meanWinRate,
    worstBossWinRate,
    routeStarter,
    expProfile,
    grindPolicy: expContext?.grindPolicy || 'none',
    expSchedule,
    finalTeam,
    finalLevels,
    routeBattleCount: routeBosses.length,
    catchUpLevels: catchUp.total,
    catchUpUnknown: catchUp.unknown,
    catchUpExp: catchUp.totalExp,
    catchUpExpUnknown: catchUp.expUnknown,
    catchUpDetails: catchUp.details,
    captureSearch,
    singleUsePlan,
    purchasablePlan,
    purchaseCosts,
    resourceBudget,
    rows,
  };
}

function resourceMoveAccessVariants(moveAccess) {
  const requested = normalizeResourceProfile(moveAccess?.resourceProfile || 'all');
  const allPurchasable = Array.isArray(moveAccess?.purchasableMachines)
    ? moveAccess.purchasableMachines
    : [];

  const core = {
    ...moveAccess,
    resourceProfile: 'core',
    purchasableMachines: [],
  };
  const money = {
    ...moveAccess,
    resourceProfile: 'money',
    purchasableMachines: allPurchasable.filter(machine => machine.currency === 'money'),
  };
  const all = {
    ...moveAccess,
    resourceProfile: 'all',
    purchasableMachines: allPurchasable,
  };

  if (requested === 'core') return [core];
  if (requested === 'money') return [core, money];
  return [core, money, all];
}

function resourceEvaluationBetter(a, b) {
  if (!b) return true;
  if (a.score !== b.score) return a.score > b.score;
  if (a.worstBossWinRate !== b.worstBossWinRate) {
    return a.worstBossWinRate > b.worstBossWinRate;
  }
  const rank = { core: 0, money: 1, all: 2 };
  const ar = rank[a.effectiveResourceProfile] ?? 9;
  const br = rank[b.effectiveResourceProfile] ?? 9;
  if (ar !== br) return ar < br;
  const aBurden = evaluationResourceBurden(a);
  const bBurden = evaluationResourceBurden(b);
  if (aBurden !== bBurden) return aBurden < bBurden;
  return Number(a.purchaseCosts?.coins || 0) < Number(b.purchaseCosts?.coins || 0);
}

async function evaluateCandidates(candidates, bosses, runs, moveAccess, expContext = null) {
  const requestedResourceProfile = normalizeResourceProfile(moveAccess?.resourceProfile || 'all');
  let best = null;

  for (const variant of resourceMoveAccessVariants(moveAccess)) {
    const evaluation = await evaluateCandidatesWithMoveAccess(candidates, bosses, runs, variant, expContext);
    const enriched = {
      ...evaluation,
      requestedResourceProfile,
      effectiveResourceProfile: variant.resourceProfile,
    };
    if (resourceEvaluationBetter(enriched, best)) best = enriched;
  }

  return best;
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
      growthRate: mon.growthRate ?? null,
      catchRate: mon.catchRate ?? null,
      captureSearch: mon.captureSearch ?? null,
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
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'unbounded'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'ace'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  if (poolPath === 'canonical') {
    throw new Error('simulate requires an explicit team/baseline; use search --pool=canonical for generated candidates');
  }

  const story = await loadStory();
  const resolved = await loadCuratedPool(poolPath, story);
  if (!teamRespectsExclusiveGroups(resolved.baseline) || !validateCandidateTeam(resolved.baseline)) {
    throw new Error('baselineTeam violates team constraints');
  }

  const [moveAccess, expContext] = await Promise.all([
    loadMoveAccess(resourceProfile, spendPolicy),
    loadExpContext(story, expProfile, 'HEARTGOLD', grindPolicy),
  ]);
  const result = await evaluateCandidates(resolved.baseline, story.bosses, runs, moveAccess, expContext);
  console.log(JSON.stringify({
    pool: poolPath,
    baselineTeam: resolved.baseline.map(candidate => candidate.species),
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
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

function evaluationExpBurden(evaluation) {
  if (evaluation?.expProfile && evaluation.expProfile !== 'ace') {
    return Number(evaluation.expSchedule?.totalGrindExp || 0);
  }
  return Number(evaluation?.catchUpExp || 0);
}

function evaluationExpUnknown(evaluation) {
  if (evaluation?.expProfile && evaluation.expProfile !== 'ace') {
    return Number(evaluation.expSchedule?.unknownEntryLevels?.length || 0);
  }
  return Number(evaluation?.catchUpExpUnknown || 0);
}

function rowExpBurden(row) {
  if (row?.expProfile && row.expProfile !== 'ace') {
    return Number(row.naturalExp?.totalGrindExp || 0);
  }
  return Number(row?.catchUpExp || 0);
}

function rowExpUnknown(row) {
  if (row?.expProfile && row.expProfile !== 'ace') {
    return Number(row.naturalExp?.unknownEntryLevels?.length || 0);
  }
  return Number(row?.catchUpExpUnknown || 0);
}

function paretoFront(rows) {
  return rows.filter((row, index) => !rows.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const rowResource = rowResourceBurden(row);
    const otherResource = rowResourceBurden(other);
    const rowExp = rowExpBurden(row);
    const otherExp = rowExpBurden(other);
    const rowUnknown = rowExpUnknown(row);
    const otherUnknown = rowExpUnknown(other);
    const rowCapture = Number(row.captureSearch?.expectedEncounters || 0);
    const otherCapture = Number(other.captureSearch?.expectedEncounters || 0);
    const rowCaptureUnknown = Number(row.captureSearch?.unknown || 0);
    const otherCaptureUnknown = Number(other.captureSearch?.unknown || 0);

    const atLeastAsGood =
      other.score >= row.score &&
      other.worstBossWinRate >= row.worstBossWinRate &&
      otherExp <= rowExp &&
      otherUnknown <= rowUnknown &&
      otherCapture <= rowCapture &&
      otherCaptureUnknown <= rowCaptureUnknown &&
      otherResource <= rowResource;
    const strictlyBetter =
      other.score > row.score ||
      other.worstBossWinRate > row.worstBossWinRate ||
      otherExp < rowExp ||
      otherUnknown < rowUnknown ||
      otherCapture < rowCapture ||
      otherCaptureUnknown < rowCaptureUnknown ||
      otherResource < rowResource;
    return atLeastAsGood && strictlyBetter;
  }));
}

function searchResultRow(team, evaluation) {
  return {
    score: evaluation.score,
    worstBossWinRate: evaluation.worstBossWinRate,
    catchUpLevels: evaluation.catchUpLevels,
    catchUpUnknown: evaluation.catchUpUnknown,
    catchUpExp: evaluation.catchUpExp,
    catchUpExpUnknown: evaluation.catchUpExpUnknown,
    expBurden: evaluationExpBurden(evaluation),
    expBurdenUnknown: evaluationExpUnknown(evaluation),
    captureSearch: evaluation.captureSearch,
    team: team.map(x => x.species),
    finalTeam: evaluation.finalTeam,
    finalLevels: evaluation.finalLevels,
    expProfile: evaluation.expProfile,
    grindPolicy: evaluation.grindPolicy,
    naturalExp: evaluation.expSchedule ? {
      totalNaturalExp: evaluation.expSchedule.totalNaturalExp,
      totalMapExp: evaluation.expSchedule.totalMapExp,
      totalMajorExp: evaluation.expSchedule.totalMajorExp,
      startingMoney: evaluation.expSchedule.startingMoney,
      totalMapMoney: evaluation.expSchedule.totalMapMoney,
      totalMajorMoney: evaluation.expSchedule.totalMajorMoney,
      totalNaturalMoney: evaluation.expSchedule.totalNaturalMoney,
      totalGrindExp: evaluation.expSchedule.totalGrindExp,
      totalExpectedGrindBattles: evaluation.expSchedule.totalExpectedGrindBattles,
      unknownEntryLevels: evaluation.expSchedule.unknownEntryLevels,
    } : null,
    routeStarter: evaluation.routeStarter,
    routeBattleCount: evaluation.routeBattleCount,
    requestedResourceProfile: evaluation.requestedResourceProfile,
    effectiveResourceProfile: evaluation.effectiveResourceProfile,
    spendPolicy: evaluation.spendPolicy,
    singleUsePlan: evaluation.singleUsePlan,
    purchasablePlan: evaluation.purchasablePlan,
    purchaseCosts: evaluation.purchaseCosts,
    resourceBudget: evaluation.resourceBudget,
    bosses: evaluation.rows.map(row => ({
      boss: row.boss,
      winRate: row.winRate,
      skipped: row.skipped || false,
    })),
  };
}

async function screenCandidates(candidates, story, moveAccess, screenRuns, expContext = null) {
  const rows = [];
  for (const candidate of candidates) {
    const evaluation = await evaluateCandidates([candidate], story.bosses, screenRuns, moveAccess, expContext);
    rows.push({ candidate, evaluation });
  }
  rows.sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    a.candidate.availableFrom - b.candidate.availableFrom ||
    a.candidate.species.localeCompare(b.candidate.species)
  );
  return rows;
}

function evaluationDominates(a, b) {
  const aResource = evaluationResourceBurden(a);
  const bResource = evaluationResourceBurden(b);
  const aExp = evaluationExpBurden(a);
  const bExp = evaluationExpBurden(b);
  const aUnknown = evaluationExpUnknown(a);
  const bUnknown = evaluationExpUnknown(b);
  const aCapture = Number(a.captureSearch?.expectedEncounters || 0);
  const bCapture = Number(b.captureSearch?.expectedEncounters || 0);
  const aCaptureUnknown = Number(a.captureSearch?.unknown || 0);
  const bCaptureUnknown = Number(b.captureSearch?.unknown || 0);

  const atLeastAsGood =
    a.score >= b.score &&
    a.worstBossWinRate >= b.worstBossWinRate &&
    aExp <= bExp &&
    aUnknown <= bUnknown &&
    aCapture <= bCapture &&
    aCaptureUnknown <= bCaptureUnknown &&
    aResource <= bResource;
  const strictlyBetter =
    a.score > b.score ||
    a.worstBossWinRate > b.worstBossWinRate ||
    aExp < bExp ||
    aUnknown < bUnknown ||
    aCapture < bCapture ||
    aCaptureUnknown < bCaptureUnknown ||
    aResource < bResource;
  return atLeastAsGood && strictlyBetter;
}

function stateTieKey(state) {
  return state.team.map(x => x.species).sort().join('|');
}

function selectMultiObjectiveBeam(states, width) {
  if (states.length <= width) return states;

  const front = states.filter((state, index) =>
    !states.some((other, otherIndex) =>
      index !== otherIndex && evaluationDominates(other.evaluation, state.evaluation)
    )
  );

  const selected = [];
  const keys = new Set();
  function add(state) {
    if (!state || selected.length >= width) return;
    const key = stateTieKey(state);
    if (keys.has(key)) return;
    keys.add(key);
    selected.push(state);
  }

  const byScore = [...front].sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const byExp = [...front].sort((a, b) =>
    evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const byCapture = [...front].sort((a, b) =>
    Number(a.evaluation.captureSearch?.expectedEncounters || 0) -
      Number(b.evaluation.captureSearch?.expectedEncounters || 0) ||
    Number(a.evaluation.captureSearch?.unknown || 0) -
      Number(b.evaluation.captureSearch?.unknown || 0) ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const byResource = [...front].sort((a, b) =>
    evaluationResourceBurden(a.evaluation) - evaluationResourceBurden(b.evaluation) ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const byWorstBoss = [...front].sort((a, b) =>
    b.evaluation.worstBossWinRate - a.evaluation.worstBossWinRate ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );

  add(byScore[0]);
  add(byWorstBoss[0]);
  add(byExp[0]);
  add(byCapture[0]);
  add(byResource[0]);

  for (const state of byScore) add(state);

  if (selected.length < width) {
    const fallback = [...states].sort((a, b) =>
      b.evaluation.score - a.evaluation.score ||
      evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
      stateTieKey(a).localeCompare(stateTieKey(b))
    );
    for (const state of fallback) add(state);
  }

  return selected.slice(0, width);
}

function candidateScreenTieKey(row) {
  return row.candidate.species;
}

function selectCandidateScreenRows(rows, width) {
  if (rows.length <= width) return rows;

  const front = rows.filter((row, index) =>
    !rows.some((other, otherIndex) =>
      index !== otherIndex && evaluationDominates(other.evaluation, row.evaluation)
    )
  );
  const selected = [];
  const seen = new Set();

  function add(row) {
    if (!row || selected.length >= width) return;
    const key = candidateScreenTieKey(row);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(row);
  }

  const sorters = [
    (a, b) => b.evaluation.score - a.evaluation.score,
    (a, b) => b.evaluation.worstBossWinRate - a.evaluation.worstBossWinRate,
    (a, b) => Number(a.evaluation.expSchedule?.totalGrindExp || 0) - Number(b.evaluation.expSchedule?.totalGrindExp || 0),
    (a, b) => evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation),
    (a, b) => Number(a.evaluation.captureSearch?.expectedEncounters || 0) - Number(b.evaluation.captureSearch?.expectedEncounters || 0),
    (a, b) => Number(a.evaluation.purchaseCosts?.money || 0) - Number(b.evaluation.purchaseCosts?.money || 0),
    (a, b) => Number(a.evaluation.purchaseCosts?.coins || 0) - Number(b.evaluation.purchaseCosts?.coins || 0),
    (a, b) => a.candidate.availableFrom - b.candidate.availableFrom,
  ];

  for (const sorter of sorters) {
    const ordered = [...front].sort((a, b) =>
      sorter(a, b) || candidateScreenTieKey(a).localeCompare(candidateScreenTieKey(b))
    );
    add(ordered[0]);
  }

  const byScore = [...front].sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
    candidateScreenTieKey(a).localeCompare(candidateScreenTieKey(b))
  );
  for (const row of byScore) add(row);

  if (selected.length < width) {
    for (const row of rows) add(row);
  }
  return selected.slice(0, width);
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
  expContext = null,
}) {
  const screenRows = screenRowsOverride || await screenCandidates(candidates, story, moveAccess, screenRuns, expContext);

  const eligibleScreenRows = requiredCandidate
    ? screenRows.filter(row =>
        row.candidate.exclusiveGroup !== 'starter' ||
        candidateIdentity(row.candidate) === candidateIdentity(requiredCandidate)
      )
    : screenRows;
  let screened = selectCandidateScreenRows(eligibleScreenRows, candidateCap)
    .map(row => row.candidate);
  if (requiredCandidate && !screened.some(mon => candidateIdentity(mon) === candidateIdentity(requiredCandidate))) {
    screened = [requiredCandidate, ...screened.slice(0, Math.max(0, candidateCap - 1))];
  }

  const cache = new Map();
  async function evaluateTeam(team) {
    const key = team.map(candidateIdentity).sort().join('|') + `@runs=${runs}`;
    if (!cache.has(key)) {
      cache.set(key, await evaluateCandidates(team, story.bosses, runs, moveAccess, expContext));
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

    beam = selectMultiObjectiveBeam(expanded, beamWidth);
    if (!beam.length) break;
  }

  const finalStates = [];
  for (const state of beam) {
    const evaluation = Number(finalRuns) === Number(runs)
      ? state.evaluation
      : await evaluateCandidates(state.team, story.bosses, finalRuns, moveAccess, expContext);
    finalStates.push({ team: state.team, evaluation });
  }
  finalStates.sort((a, b) =>
    b.evaluation.score - a.evaluation.score ||
    evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
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
      worstBossWinRate: row.evaluation.worstBossWinRate,
      catchUpLevels: row.evaluation.catchUpLevels,
      catchUpUnknown: row.evaluation.catchUpUnknown,
      catchUpExp: row.evaluation.catchUpExp,
      catchUpExpUnknown: row.evaluation.catchUpExpUnknown,
      expBurden: evaluationExpBurden(row.evaluation),
      expBurdenUnknown: evaluationExpUnknown(row.evaluation),
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
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'unbounded'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'ace'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const story = await loadStory();

  let candidates;
  if (poolPath === 'canonical') {
    candidates = (await loadCanonicalPool(version, story)).candidates;
  } else {
    candidates = (await loadCuratedPool(poolPath, story)).candidates;
  }

  if (candidates.length < teamSize) throw new Error('Candidate pool is smaller than team-size');
  const requiredCandidate = findStarterCandidate(candidates, starterName);
  const [moveAccess, expContext] = await Promise.all([
    loadMoveAccess(resourceProfile, spendPolicy),
    loadExpContext(story, expProfile, version, grindPolicy),
  ]);

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
      expContext,
    });
    console.log(JSON.stringify({
      pool: poolPath,
      version: poolPath === 'canonical' ? version : undefined,
      strategy,
      starter: requiredCandidate?.species || 'any',
      resourceProfile,
      spendPolicy,
      expProfile,
      grindPolicy,
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
    const evaluation = await evaluateCandidates(team, story.bosses, runs, moveAccess, expContext);
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
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
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
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'unbounded'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'ace'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));

  const story = await loadStory();
  const moveAccess = await loadMoveAccess(resourceProfile, spendPolicy);
  const output = {
    schemaVersion: 1,
    sourceCommit: story.config.sourceCommit,
    battleEngine: 'pokemon-showdown@0.11.11/gen4customgame',
    policy: 'greedy-moves+conservative-player-switching',
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    runsPerBoss: runs,
    screenRunsPerBoss: screenRuns,
    finalRunsPerBoss: finalRuns,
    beamWidth,
    candidateCap,
    teamSize,
    versions: {},
  };

  for (const version of versions) {
    const [pool, expContext] = await Promise.all([
      loadCanonicalPool(version, story),
      loadExpContext(story, expProfile, version, grindPolicy),
    ]);
    const candidates = pool.candidates;
    const screenRows = await screenCandidates(candidates, story, moveAccess, screenRuns, expContext);
    output.versions[version] = {
      candidateCount: candidates.length,
      starters: {},
    };

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
        expContext,
      });
      output.versions[version].starters[requiredCandidate.species] = {
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

async function cmdResourceMonotonicSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const wanted = ['Cyndaquil', 'Dunsparce', 'Geodude'];
  const team = wanted.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing monotonic-smoke candidate: ${name}`);
    return candidate;
  });
  const shortRoute = story.bosses.filter(battle => Number(battle.stage) <= 2);

  const results = {};
  for (const profile of ['core', 'money', 'all']) {
    const moveAccess = await loadMoveAccess(profile);
    results[profile] = await evaluateCandidates(team, shortRoute, 1, moveAccess);
  }

  if (results.money.score < results.core.score) {
    throw new Error(`money profile regressed below core: ${results.money.score} < ${results.core.score}`);
  }
  if (results.all.score < results.money.score) {
    throw new Error(`all profile regressed below money: ${results.all.score} < ${results.money.score}`);
  }

  console.log(JSON.stringify(Object.fromEntries(
    Object.entries(results).map(([profile, result]) => [profile, {
      score: result.score,
      worstBossWinRate: result.worstBossWinRate,
      effectiveResourceProfile: result.effectiveResourceProfile,
      purchaseCosts: result.purchaseCosts,
    }])
  ), null, 2));
}

async function cmdMoveScoreSmoke() {
  const aerialAce = candidateMoveUtility('Pidgeot', 'Aerial Ace');
  const hyperBeam = candidateMoveUtility('Pidgeot', 'Hyper Beam');
  const energyBall = candidateMoveUtility('Meganium', 'Energy Ball');
  const solarBeam = candidateMoveUtility('Meganium', 'Solar Beam');

  if (!(aerialAce > hyperBeam)) {
    throw new Error(`Recharge penalty regression: Aerial Ace ${aerialAce} <= Hyper Beam ${hyperBeam}`);
  }
  if (!(energyBall > solarBeam)) {
    throw new Error(`Charge penalty regression: Energy Ball ${energyBall} <= Solar Beam ${solarBeam}`);
  }

  console.log(JSON.stringify({
    Pidgeot: { aerialAce, hyperBeam },
    Meganium: { energyBall, solarBeam },
  }, null, 2));
}

async function cmdResourceBudgetSmoke() {
  const moneyOnly = summarizeResourceBudget({ money: 1000, coins: 0 }, null);
  const coinsOnly = summarizeResourceBudget({ money: 0, coins: 50 }, null);
  if (moneyOnly.directPurchaseMoneyEquivalent !== 1000) {
    throw new Error(`1000 money should stay 1000, got ${moneyOnly.directPurchaseMoneyEquivalent}`);
  }
  if (coinsOnly.directPurchaseMoneyEquivalent !== 1000) {
    throw new Error(`50 coins should equal 1000 money, got ${coinsOnly.directPurchaseMoneyEquivalent}`);
  }

  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const team = ['Cyndaquil', 'Mareep', 'Geodude'].map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing resource-budget candidate: ${name}`);
    return candidate;
  });
  const route = storyBattlesForCandidates(story.bosses, team);
  const expContext = await loadExpContext(story, 'all-accessible', 'HEARTGOLD', 'none');
  const schedule = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'all-accessible',
    grindPolicy: 'none',
  });
  if (!(schedule.totalNaturalMoney > schedule.startingMoney)) {
    throw new Error(
      `Expected trainer prize money above starting cash: ${schedule.totalNaturalMoney}`
    );
  }

  const moveAccess = await loadMoveAccess('all', 'natural');
  const singleUsePlan = planSingleUseMachines(team, route, moveAccess);
  const budget = naturalPurchaseBudget(schedule);
  const budgeted = planPurchasableMachines(
    team,
    route,
    moveAccess,
    singleUsePlan,
    { maxMoneyEquivalent: budget, moneyPerCoin: MONEY_PER_COIN },
  );
  if (Number(budgeted.budget?.spentMoneyEquivalent || 0) > budget) {
    throw new Error(
      `Budgeted TM planner overspent: ${budgeted.budget?.spentMoneyEquivalent} > ${budget}`
    );
  }

  console.log(JSON.stringify({
    conversion: {
      money1000: moneyOnly.directPurchaseMoneyEquivalent,
      coins50: coinsOnly.directPurchaseMoneyEquivalent,
      moneyPerCoin: MONEY_PER_COIN,
    },
    naturalBudget: {
      startingMoney: schedule.startingMoney,
      totalMapMoney: schedule.totalMapMoney,
      totalMajorMoney: schedule.totalMajorMoney,
      totalNaturalMoney: schedule.totalNaturalMoney,
      goldenrodPurchaseBudget: budget,
    },
    budgetedTMPlan: budgeted.budget,
    budgetedTMCosts: budgeted.costs,
  }, null, 2));
}

async function cmdResourceSmoke() {
  const [core, money, all] = await Promise.all([
    loadMoveAccess('core'),
    loadMoveAccess('money'),
    loadMoveAccess('all'),
  ]);

  if (core.purchasableMachines.length !== 0) {
    throw new Error('core profile must not contain purchasable machines');
  }
  if (!money.purchasableMachines.length || money.purchasableMachines.some(machine => machine.currency !== 'money')) {
    throw new Error('money profile must contain only money-purchasable machines');
  }
  if (all.purchasableMachines.length <= money.purchasableMachines.length ||
      !all.purchasableMachines.some(machine => machine.currency === 'coins')) {
    throw new Error('all profile must include Game Corner coin machines');
  }

  console.log(JSON.stringify({
    core: core.purchasableMachines.length,
    money: money.purchasableMachines.length,
    all: all.purchasableMachines.length,
  }, null, 2));
}

async function cmdRouteSmoke() {
  const story = await loadStory();
  const expected = {
    Chikorita: [
      'TRAINER_RIVAL_SILVER_7',
      'TRAINER_RIVAL_SILVER_8',
      'TRAINER_RIVAL_SILVER_18',
      'TRAINER_RIVAL_SILVER_9',
    ],
    Cyndaquil: [
      'TRAINER_RIVAL_SILVER_10',
      'TRAINER_RIVAL_SILVER_11',
      'TRAINER_RIVAL_SILVER_12',
      'TRAINER_RIVAL_SILVER_13',
    ],
    Totodile: [
      'TRAINER_RIVAL_SILVER',
      'TRAINER_RIVAL_SILVER_4',
      'TRAINER_RIVAL_SILVER_17',
      'TRAINER_RIVAL_SILVER_5',
    ],
  };

  const output = {};
  for (const [starter, rivalKeys] of Object.entries(expected)) {
    const route = storyBattlesForCandidates(story.bosses, [
      { species: starter, exclusiveGroup: 'starter' },
    ]);
    const activeRivals = route.filter(battle => battle.kind === 'rival').map(battle => battle.key);
    if (route.length !== 21) {
      throw new Error(`${starter} route expected 21 battles, got ${route.length}`);
    }
    if (JSON.stringify(activeRivals) !== JSON.stringify(rivalKeys)) {
      throw new Error(`${starter} rival route mismatch: ${JSON.stringify(activeRivals)}`);
    }
    output[starter] = {
      battleCount: route.length,
      rivalKeys: activeRivals,
    };
  }

  const noStarterRoute = storyBattlesForCandidates(story.bosses, []);
  if (noStarterRoute.length !== 17 || noStarterRoute.some(battle => battle.kind === 'rival')) {
    throw new Error(`Starter-neutral screening route mismatch: ${noStarterRoute.length}`);
  }
  output.starterNeutral = { battleCount: noStarterRoute.length };

  console.log(JSON.stringify(output, null, 2));
}

async function cmdCaptureSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const get = name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Capture-smoke candidate not found: ${name}`);
    return candidate;
  };

  const mareep = get('Mareep');
  const lapras = get('Lapras');
  const heracross = get('Heracross');

  if (mareep.captureSearch?.mode !== 'wild' ||
      !(Number(mareep.captureSearch?.expectedEncounters) > 0)) {
    throw new Error(`Mareep wild search cost invalid: ${JSON.stringify(mareep.captureSearch)}`);
  }
  if (lapras.captureSearch?.mode !== 'fixed-or-gift' ||
      Number(lapras.captureSearch?.expectedEncounters) !== 0) {
    throw new Error(`Lapras fixed encounter cost invalid: ${JSON.stringify(lapras.captureSearch)}`);
  }
  if (heracross.captureSearch?.mode !== 'headbutt-lower-bound' ||
      !(Number(heracross.captureSearch?.expectedEncounters) > 0)) {
    throw new Error(`Heracross Headbutt lower bound invalid: ${JSON.stringify(heracross.captureSearch)}`);
  }

  console.log(JSON.stringify({
    Mareep: {
      captureSearch: mareep.captureSearch,
      catchRate: mareep.catchRate,
      entryLevelMin: mareep.entryLevelMin,
      entryLevelMax: mareep.entryLevelMax,
    },
    Lapras: {
      captureSearch: lapras.captureSearch,
      catchRate: lapras.catchRate,
    },
    Heracross: {
      captureSearch: heracross.captureSearch,
      catchRate: heracross.catchRate,
    },
  }, null, 2));
}

async function cmdExpRouteSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const names = ['Cyndaquil', 'Mareep', 'Geodude', 'Zubat', 'Lapras', 'Tentacool'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing EXP-route smoke candidate: ${name}`);
    return candidate;
  });
  const moveAccess = await loadMoveAccess('core');

  const [naturalContext, paidContext] = await Promise.all([
    loadExpContext(story, 'all-accessible', 'HEARTGOLD', 'none'),
    loadExpContext(story, 'all-accessible', 'HEARTGOLD', 'ace-paid'),
  ]);
  const natural = await evaluateCandidates(team, story.bosses, 1, moveAccess, naturalContext);
  const paid = await evaluateCandidates(team, story.bosses, 1, moveAccess, paidContext);

  if (natural.routeBattleCount !== 21 || paid.routeBattleCount !== 21) {
    throw new Error(
      `EXP-route smoke expected 21 battles, got natural=${natural.routeBattleCount}, paid=${paid.routeBattleCount}`
    );
  }
  const firstNatural = natural.rows[0];
  const firstPaid = paid.rows[0];
  if (!firstNatural || !firstPaid) throw new Error('Missing Falkner EXP-route result');

  const naturalLevels = Object.values(firstNatural.playerLevels || {}).map(Number);
  const paidLevels = Object.values(firstPaid.playerLevels || {}).map(Number);
  if (!naturalLevels.length || !paidLevels.length) throw new Error('Missing player levels in EXP-route result');
  if (naturalLevels.every(level => level === Number(firstNatural.aceLevel))) {
    throw new Error('Natural EXP route unexpectedly normalized every Falkner mon to ace level');
  }
  if (!paidLevels.every(level => level === Number(firstPaid.aceLevel))) {
    throw new Error(
      `ace-paid route failed to buy Falkner ace level: ${JSON.stringify(firstPaid.playerLevels)}`
    );
  }
  if (!(Number(paid.expSchedule?.totalGrindExp || 0) > 0)) {
    throw new Error('ace-paid route recorded no grind EXP');
  }
  if (!(Number(paid.expSchedule?.totalExpectedGrindBattles || 0) > 0)) {
    throw new Error('ace-paid route recorded no expected grind battles');
  }

  console.log(JSON.stringify({
    natural: {
      score: natural.score,
      firstBattle: {
        boss: firstNatural.boss,
        aceLevel: firstNatural.aceLevel,
        playerLevels: firstNatural.playerLevels,
        winRate: firstNatural.winRate,
      },
      finalLevels: natural.finalLevels,
      totalNaturalExp: natural.expSchedule?.totalNaturalExp,
    },
    acePaid: {
      score: paid.score,
      firstBattle: {
        boss: firstPaid.boss,
        aceLevel: firstPaid.aceLevel,
        playerLevels: firstPaid.playerLevels,
        winRate: firstPaid.winRate,
        bestWildGrind: paid.expSchedule?.battles?.[0]?.bestWildGrind,
        grindExpBefore: paid.expSchedule?.battles?.[0]?.grindExpBefore,
        expectedGrindBattles: paid.expSchedule?.battles?.[0]?.expectedGrindBattles,
      },
      finalLevels: paid.finalLevels,
      totalNaturalExp: paid.expSchedule?.totalNaturalExp,
      totalGrindExp: paid.expSchedule?.totalGrindExp,
      totalExpectedGrindBattles: paid.expSchedule?.totalExpectedGrindBattles,
    },
  }, null, 2));
}

async function cmdExpBudget() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const profile = normalizeExpProfile(arg('exp-profile', 'all-accessible'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  if (profile === 'ace') {
    throw new Error('exp-budget requires --exp-profile=major or all-accessible');
  }
  const requestedTeam = String(arg(
    'team',
    'Cyndaquil,Mareep,Geodude,Zubat,Lapras,Tentacool'
  )).split(',').map(value => value.trim()).filter(Boolean);

  const story = await loadStory();
  const pool = await loadCanonicalPool(version, story);
  const team = requestedTeam.map(name => {
    const candidate = pool.candidates.find(mon => mon.species.toLowerCase() === name.toLowerCase());
    if (!candidate) throw new Error(`EXP-budget candidate not found: ${name}`);
    return candidate;
  });
  const route = storyBattlesForCandidates(story.bosses, team);
  const expContext = await loadExpContext(story, profile, version, grindPolicy);
  const schedule = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile,
    grindPolicy,
  });

  console.log(JSON.stringify({
    version,
    grindPolicy,
    team: team.map(mon => mon.species),
    routeBattleCount: route.length,
    world: {
      mapTrainerCount: expContext.world.mapTrainerRows.length,
      mapCount: expContext.world.mapCount,
      unresolvedMaps: expContext.world.unresolvedMaps,
    },
    ...schedule,
  }, null, 2));
}

async function cmdExpBudgetSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const names = ['Cyndaquil', 'Mareep', 'Geodude', 'Zubat', 'Lapras', 'Tentacool'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing EXP-budget smoke candidate: ${name}`);
    return candidate;
  });
  const route = storyBattlesForCandidates(story.bosses, team);
  const expContext = await loadExpContext(story, 'all-accessible');

  const major = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'major',
  });
  const accessible = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'all-accessible',
    grindPolicy: 'none',
  });
  const acePaid = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'all-accessible',
    grindPolicy: 'ace-paid',
  });

  if (major.totalMapExp !== 0) {
    throw new Error(`major profile unexpectedly included map EXP: ${major.totalMapExp}`);
  }
  if (!(accessible.totalNaturalExp > major.totalNaturalExp)) {
    throw new Error(
      `all-accessible EXP must exceed major-only: ${accessible.totalNaturalExp} <= ${major.totalNaturalExp}`
    );
  }
  if (major.unknownEntryLevels.length || accessible.unknownEntryLevels.length) {
    throw new Error(
      `EXP-budget smoke has unknown entry levels: ${JSON.stringify(accessible.unknownEntryLevels)}`
    );
  }

  const laprasKey = team.find(mon => mon.species === 'Lapras').familyId || 'Lapras';
  const preLapras = accessible.battles.filter(battle => battle.stage < 4);
  if (preLapras.some(battle => Object.hasOwn(battle.levelsBefore, laprasKey))) {
    throw new Error('Lapras received EXP before its stage-4 acquisition');
  }

  const levelSum = schedule => Object.values(schedule.finalLevels)
    .reduce((sum, level) => sum + Number(level || 0), 0);
  if (!(levelSum(accessible) >= levelSum(major))) {
    throw new Error('More natural EXP produced a lower final level sum');
  }
  if (!(acePaid.totalGrindExp > 0) || !(acePaid.totalExpectedGrindBattles > 0)) {
    throw new Error('ace-paid profile failed to record paid grind');
  }

  console.log(JSON.stringify({
    routeBattleCount: route.length,
    worldMapTrainerCount: expContext.world.mapTrainerRows.length,
    unresolvedMaps: expContext.world.unresolvedMaps,
    major: {
      totalNaturalExp: major.totalNaturalExp,
      totalMajorExp: major.totalMajorExp,
      finalLevels: major.finalLevels,
    },
    allAccessible: {
      totalNaturalExp: accessible.totalNaturalExp,
      totalMapExp: accessible.totalMapExp,
      totalMajorExp: accessible.totalMajorExp,
      firstBattleLevels: accessible.battles[0]?.levelsBefore,
      finalLevels: accessible.finalLevels,
    },
    acePaid: {
      totalNaturalExp: acePaid.totalNaturalExp,
      totalGrindExp: acePaid.totalGrindExp,
      totalExpectedGrindBattles: acePaid.totalExpectedGrindBattles,
      firstBattle: acePaid.battles[0],
      finalLevels: acePaid.finalLevels,
    },
  }, null, 2));
}

async function cmdExpSmoke() {
  const expected = {
    MEDIUM_FAST: 8000,
    ERRATIC: 12800,
    FLUCTUATING: 5440,
    MEDIUM_SLOW: 5460,
    FAST: 6400,
    SLOW: 10000,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map(rate => [rate, expAtLevel(rate, 20)])
  );
  for (const [rate, value] of Object.entries(expected)) {
    if (actual[rate] !== value) {
      throw new Error(`Growth table mismatch for ${rate} Lv20: expected ${value}, got ${actual[rate]}`);
    }
  }
  console.log(JSON.stringify({ level: 20, expected, actual }, null, 2));
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

async function cmdTutorSmoke() {
  const moveAccess = await loadMoveAccess();
  const before = candidateMovePool('Quilava', 17, 1, moveAccess);
  const after = candidateMovePool('Quilava', 19, 2, moveAccess);

  if (before.includes('Headbutt')) {
    throw new Error('Headbutt tutor became available before Ilex Forest');
  }
  if (!after.includes('Headbutt')) {
    throw new Error('Expected stage-2 Quilava to be compatible with reusable Headbutt tutor');
  }

  console.log(JSON.stringify({ before, after }, null, 2));
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

async function cmdShopTmSmoke() {
  const story = await loadStory();
  const moveAccess = await loadMoveAccess();
  const team = [
    { species: 'Cyndaquil', availableFrom: 0, familyId: 'Cyndaquil' },
    { species: 'Growlithe', availableFrom: 2, familyId: 'Growlithe' },
  ];
  const singleUsePlan = planSingleUseMachines(team, story.bosses, moveAccess);
  const purchasable = planPurchasableMachines(team, story.bosses, moveAccess, singleUsePlan);
  const owners = Object.entries(purchasable.assignments)
    .filter(([, machines]) => machines.some(machine => machine.machine === 'TM38'))
    .map(([owner]) => owner);

  if (owners.length < 2) {
    throw new Error(`Expected purchasable TM38 to support multiple owners, got ${owners.length}`);
  }
  if (Number(purchasable.costs.money || 0) < 11000) {
    throw new Error(`Expected at least two Fire Blast purchases (11000), got ${purchasable.costs.money || 0}`);
  }

  const before = materializeCandidateTeam(team, 1, 17, {
    moveAccess,
    singleUsePlan,
    purchasablePlan: purchasable.assignments,
  });
  const after = materializeCandidateTeam(team, 2, 19, {
    moveAccess,
    singleUsePlan,
    purchasablePlan: purchasable.assignments,
  });
  if (before.some(mon => mon.moves.includes('Fire Blast'))) {
    throw new Error('Goldenrod shop TM38 became available before stage 2');
  }
  if (after.filter(mon => mon.moves.includes('Fire Blast')).length < 1) {
    throw new Error('Expected at least one stage-2 team member to use purchased Fire Blast');
  }

  console.log(JSON.stringify({
    owners,
    purchaseCosts: purchasable.costs,
    before: before.map(mon => ({ species: mon.species, moves: mon.moves })),
    after: after.map(mon => ({ species: mon.species, moves: mon.moves })),
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
  'resource-monotonic-smoke': cmdResourceMonotonicSmoke,
  'resource-budget-smoke': cmdResourceBudgetSmoke,
  'move-score-smoke': cmdMoveScoreSmoke,
  'resource-smoke': cmdResourceSmoke,
  'route-smoke': cmdRouteSmoke,
  'exp-budget': cmdExpBudget,
  'exp-budget-smoke': cmdExpBudgetSmoke,
  'capture-smoke': cmdCaptureSmoke,
  'exp-route-smoke': cmdExpRouteSmoke,
  'exp-smoke': cmdExpSmoke,
  'switch-smoke': cmdSwitchSmoke,
  'tutor-smoke': cmdTutorSmoke,
  'hm-smoke': cmdHmSmoke,
  'tm-smoke': cmdTmSmoke,
  'shop-tm-smoke': cmdShopTmSmoke,
  smoke: cmdSmoke,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, resource-budget-smoke, resource-monotonic-smoke, move-score-smoke, resource-smoke, route-smoke, exp-budget, exp-budget-smoke, capture-smoke, exp-route-smoke, exp-smoke, switch-smoke, tutor-smoke, hm-smoke, tm-smoke, shop-tm-smoke, extract, pool, validate, simulate, search, optimize');
  process.exitCode = 2;
} else {
  await commands[command]();
}
