import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { candidateBossUtility, candidateMovePool, candidateMoveUtility, hgssTrainerToShowdownTeam, materializeCandidateTeam, planPurchasableMachines, planSingleUseMachines, runBattle, simulateMatchup } from './battle.mjs';
import { chooseHgssMoveIndex, chooseHgssPostKoSwitch, chooseHgssTrainerItem, decodeHgssAiFlags, trainerAiProfile } from './trainer-ai.mjs';
import { buildCanonicalCandidatePool, validateCandidateTeam } from './acquisition.mjs';
import { allocateBreakpointAwareExp, buildExpWorld, buildTeamExpSchedule } from './exp-budget.mjs';
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
  if (!['ace', 'major', 'normal-route', 'all-accessible'].includes(profile)) {
    throw new Error(
      `Unknown EXP profile: ${value}. Use ace, major, normal-route, or all-accessible.`
    );
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

function normalizeEntryLevelPolicy(value) {
  const policy = String(value || 'midpoint').toLowerCase();
  if (!['min', 'midpoint', 'max'].includes(policy)) {
    throw new Error(`Unknown entry-level policy: ${value}. Use min, midpoint, or max.`);
  }
  return policy;
}

function normalizeSameStageJoinPolicy(value) {
  const policy = String(value || 'map-order').toLowerCase();
  if (!['map-order', 'after-map-exp', 'before-map-exp'].includes(policy)) {
    throw new Error(
      `Unknown same-stage join policy: ${value}. Use map-order, after-map-exp, or before-map-exp.`
    );
  }
  return policy;
}

function normalizeExpAllocator(value) {
  const allocator = String(value || 'balanced').toLowerCase();
  if (!['balanced', 'boss-aware-soft', 'boss-aware', 'breakpoint-aware'].includes(allocator)) {
    throw new Error(
      `Unknown EXP allocator: ${value}. Use balanced, boss-aware-soft, boss-aware, or breakpoint-aware.`
    );
  }
  return allocator;
}

function normalizeSearchObjective(value) {
  const objective = String(value || 'mean').toLowerCase();
  if (!['mean', 'story-clear'].includes(objective)) {
    throw new Error(`Unknown search objective: ${value}. Use mean or story-clear.`);
  }
  return objective;
}

const STORY_CLEAR_BOTTOM_K = 5;
const STORY_CLEAR_TARGET_WIN_RATE = 0.5;

function storyClearCoverageScore(rows, target = STORY_CLEAR_TARGET_WIN_RATE) {
  if (!rows.length) return 0;
  const threshold = Math.max(0.01, Math.min(1, Number(target) || STORY_CLEAR_TARGET_WIN_RATE));
  return rows.reduce((sum, row) => {
    const rate = Math.max(0, Math.min(1, Number(row.winRate || 0)));
    return sum + Math.min(rate, threshold) / threshold;
  }, 0) / rows.length;
}

function storyClearGeometricScore(rows) {
  if (!rows.length) return 0;
  const logMean = rows.reduce((sum, row) => {
    const wins = Number(row.wins);
    const losses = Number(row.losses);
    let estimate;
    if (Number.isFinite(wins) && Number.isFinite(losses) && wins + losses > 0) {
      // Beta(1,1) posterior mean avoids every finite smoke run turning a
      // single 0/N result into a permanent zero-product route score.
      estimate = (wins + 1) / (wins + losses + 2);
    } else {
      const rate = Math.max(0, Math.min(1, Number(row.winRate || 0)));
      estimate = Math.max(1e-6, Math.min(1 - 1e-6, rate));
    }
    return sum + Math.log(estimate);
  }, 0) / rows.length;
  return Math.exp(logMean);
}

function lowerTailBossWinRate(rows, k = STORY_CLEAR_BOTTOM_K) {
  const rates = rows
    .map(row => Number(row.winRate || 0))
    .sort((a, b) => a - b);
  if (!rates.length) return 0;
  const count = Math.max(1, Math.min(rates.length, Number(k) || STORY_CLEAR_BOTTOM_K));
  return rates.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}

function evaluationObjectiveCompare(a, b, objective = 'mean') {
  if (objective === 'story-clear') {
    if (a.storyClearGeometricScore !== b.storyClearGeometricScore) {
      return b.storyClearGeometricScore - a.storyClearGeometricScore;
    }
    if (a.storyClearCoverageScore !== b.storyClearCoverageScore) {
      return b.storyClearCoverageScore - a.storyClearCoverageScore;
    }
    if (a.bottom5BossWinRate !== b.bottom5BossWinRate) {
      return b.bottom5BossWinRate - a.bottom5BossWinRate;
    }
    if (a.worstBossWinRate !== b.worstBossWinRate) {
      return b.worstBossWinRate - a.worstBossWinRate;
    }
    if (a.score !== b.score) return b.score - a.score;
    return 0;
  }
  if (a.score !== b.score) return b.score - a.score;
  if (a.bottom5BossWinRate !== b.bottom5BossWinRate) {
    return b.bottom5BossWinRate - a.bottom5BossWinRate;
  }
  if (a.worstBossWinRate !== b.worstBossWinRate) {
    return b.worstBossWinRate - a.worstBossWinRate;
  }
  return 0;
}

async function loadExpContext(
  story,
  expProfile,
  version = 'HEARTGOLD',
  grindPolicy = 'none',
  entryLevelPolicy = 'midpoint',
  sameStageJoinPolicy = 'map-order',
  expAllocator = 'balanced',
) {
  const profile = normalizeExpProfile(expProfile);
  const normalizedGrindPolicy = normalizeGrindPolicy(grindPolicy);
  const normalizedEntryLevelPolicy = normalizeEntryLevelPolicy(entryLevelPolicy);
  const normalizedSameStageJoinPolicy = normalizeSameStageJoinPolicy(sameStageJoinPolicy);
  const normalizedExpAllocator = normalizeExpAllocator(expAllocator);
  const bossAwareSoftLevelScale = Number(arg('soft-level-scale', '8'));
  const breakpointBossHorizon = Number(arg('breakpoint-boss-horizon', '4'));
  const breakpointLevelLookahead = Number(arg('breakpoint-level-lookahead', '12'));
  const breakpointDiscount = Number(arg('breakpoint-discount', '0.72'));
  if (!Number.isFinite(bossAwareSoftLevelScale) || bossAwareSoftLevelScale <= 0) {
    throw new Error(`Invalid --soft-level-scale: ${bossAwareSoftLevelScale}`);
  }
  if (!Number.isInteger(breakpointBossHorizon) || breakpointBossHorizon < 1) {
    throw new Error(`Invalid --breakpoint-boss-horizon: ${breakpointBossHorizon}`);
  }
  if (!Number.isInteger(breakpointLevelLookahead) || breakpointLevelLookahead < 1) {
    throw new Error(`Invalid --breakpoint-level-lookahead: ${breakpointLevelLookahead}`);
  }
  if (!Number.isFinite(breakpointDiscount) || breakpointDiscount <= 0 || breakpointDiscount > 1) {
    throw new Error(`Invalid --breakpoint-discount: ${breakpointDiscount}`);
  }
  if (profile === 'ace') {
    return {
      profile,
      grindPolicy: 'none',
      entryLevelPolicy: normalizedEntryLevelPolicy,
      sameStageJoinPolicy: normalizedSameStageJoinPolicy,
      expAllocator: normalizedExpAllocator,
      bossAwareSoftLevelScale,
      breakpointBossHorizon,
      breakpointLevelLookahead,
      breakpointDiscount,
      world: null,
    };
  }
  const [baseAccess, expAccess, expTiming] = await Promise.all([
    readJson('config/story-access.canonical.json'),
    readJson('config/exp-access.json'),
    readJson('config/exp-timing.json'),
  ]);
  const access = profile === 'all-accessible'
    ? mergeExpAccess(baseAccess, expAccess)
    : baseAccess;
  const world = await buildExpWorld({
    commit: story.config.sourceCommit,
    access,
    trainerSource: story.source,
    version,
    timing: expTiming,
  });
  return {
    profile,
    grindPolicy: normalizedGrindPolicy,
    entryLevelPolicy: normalizedEntryLevelPolicy,
    sameStageJoinPolicy: normalizedSameStageJoinPolicy,
    expAllocator: normalizedExpAllocator,
    bossAwareSoftLevelScale,
    breakpointBossHorizon,
    breakpointLevelLookahead,
    breakpointDiscount,
    world,
  };
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

function orderCandidatesForBoss(candidates, boss, levelsByCandidate = null) {
  return [...candidates].sort((a, b) => {
    const aKey = candidateIdentity(a);
    const bKey = candidateIdentity(b);
    const aLevel = levelsByCandidate && Number.isFinite(Number(levelsByCandidate[aKey]))
      ? Number(levelsByCandidate[aKey])
      : Number(boss.aceLevel);
    const bLevel = levelsByCandidate && Number.isFinite(Number(levelsByCandidate[bKey]))
      ? Number(levelsByCandidate[bKey])
      : Number(boss.aceLevel);
    const aUtility = candidateBossUtility(a, boss, aLevel);
    const bUtility = candidateBossUtility(b, boss, bLevel);
    return bUtility - aUtility || aKey.localeCompare(bKey);
  });
}

async function evaluateCandidatesWithMoveAccess(candidates, bosses, runs, moveAccess, expContext = null, grindPolicy = 'none', battleOptions = {}) {
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
        entryLevelPolicy: expContext?.entryLevelPolicy || 'midpoint',
        sameStageJoinPolicy: expContext?.sameStageJoinPolicy || 'map-order',
        allocator: expContext?.expAllocator || 'balanced',
        levelUtility: candidateBossUtility,
        bossAwareSoftLevelScale: expContext?.bossAwareSoftLevelScale || 8,
        breakpointBossHorizon: expContext?.breakpointBossHorizon || 4,
        breakpointLevelLookahead: expContext?.breakpointLevelLookahead || 12,
        breakpointDiscount: expContext?.breakpointDiscount || 0.72,
      });
  const catchUp = estimateCatchUpLevels(candidates, routeBosses);
  const captureSearch = summarizeCaptureSearch(candidates);
  const levelsByBattle = expSchedule
    ? expSchedule.battles.map(battle => battle.levelsBefore || {})
    : null;
  const singleUsePlan = planSingleUseMachines(
    candidates,
    routeBosses,
    moveAccess,
    { levelsByBattle },
  );
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
      ? {
          maxMoneyEquivalent: naturalBudget,
          moneyPerCoin: MONEY_PER_COIN,
          levelsByBattle,
        }
      : { levelsByBattle },
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
    const orderedCandidates = orderCandidatesForBoss(candidates, boss, levelsByCandidate);
    const playerTeam = materializeCandidateTeam(
      orderedCandidates,
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
      { p2Trainer: boss, ...battleOptions },
    );
    weightedWins += result.wins;
    weightedRuns += result.runs;
    rows.push({
      boss: boss.label,
      aceLevel: boss.aceLevel,
      playerLevels: Object.fromEntries(playerTeam.map(mon => [mon.species, mon.level])),
      playerLead: playerTeam[0]?.species || null,
      naturalExpBefore: expSchedule?.battles?.[battleIndex]?.mapExpBefore || 0,
      availableMons: playerTeam.map(x => x.species),
      ...result,
    });
  }
  const meanWinRate = weightedRuns ? weightedWins / weightedRuns : 0;
  const worstBossWinRate = rows.length
    ? Math.min(...rows.map(row => Number(row.winRate || 0)))
    : 0;
  const bottom5BossWinRate = lowerTailBossWinRate(rows);
  const storyCoverage = storyClearCoverageScore(rows);
  const storyGeometric = storyClearGeometricScore(rows);
  const finalBattle = routeBosses[routeBosses.length - 1] || null;
  const finalLevelSnapshot = expSchedule?.battles?.[routeBosses.length - 1]?.levelsBefore || null;
  const finalMaterialized = finalBattle
    ? materializeCandidateTeam(
        orderCandidatesForBoss(candidates, finalBattle, finalLevelSnapshot),
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
    bottom5BossWinRate,
    storyClearGeometricScore: storyGeometric,
    storyClearCoverageScore: storyCoverage,
    storyClearTargetWinRate: STORY_CLEAR_TARGET_WIN_RATE,
    storyClearBottomK: STORY_CLEAR_BOTTOM_K,
    leadPolicy: 'boss-utility',
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

function resourceEvaluationBetter(a, b, objective = 'mean') {
  if (!b) return true;
  const objectiveOrder = evaluationObjectiveCompare(a, b, objective);
  if (objectiveOrder !== 0) return objectiveOrder < 0;
  const rank = { core: 0, money: 1, all: 2 };
  const ar = rank[a.effectiveResourceProfile] ?? 9;
  const br = rank[b.effectiveResourceProfile] ?? 9;
  if (ar !== br) return ar < br;
  const aBurden = evaluationResourceBurden(a);
  const bBurden = evaluationResourceBurden(b);
  if (aBurden !== bBurden) return aBurden < bBurden;
  return Number(a.purchaseCosts?.coins || 0) < Number(b.purchaseCosts?.coins || 0);
}

async function evaluateCandidates(
  candidates,
  bosses,
  runs,
  moveAccess,
  expContext = null,
  grindPolicy = 'none',
  objective = 'mean',
  battleOptions = {},
) {
  const requestedResourceProfile = normalizeResourceProfile(moveAccess?.resourceProfile || 'all');
  let best = null;

  for (const variant of resourceMoveAccessVariants(moveAccess)) {
    const evaluation = await evaluateCandidatesWithMoveAccess(
      candidates,
      bosses,
      runs,
      variant,
      expContext,
      grindPolicy,
      battleOptions,
    );
    const enriched = {
      ...evaluation,
      requestedResourceProfile,
      effectiveResourceProfile: variant.resourceProfile,
    };
    if (resourceEvaluationBetter(enriched, best, objective)) best = enriched;
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
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'balanced'));
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
    loadExpContext(
      story,
      expProfile,
      'HEARTGOLD',
      grindPolicy,
      entryLevelPolicy,
      sameStageJoinPolicy,
      expAllocator,
    ),
  ]);
  const result = await evaluateCandidates(resolved.baseline, story.bosses, runs, moveAccess, expContext, grindPolicy);
  console.log(JSON.stringify({
    pool: poolPath,
    baselineTeam: resolved.baseline.map(candidate => candidate.species),
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
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
      other.bottom5BossWinRate >= row.bottom5BossWinRate &&
      other.storyClearGeometricScore >= row.storyClearGeometricScore &&
      other.storyClearCoverageScore >= row.storyClearCoverageScore &&
      otherExp <= rowExp &&
      otherUnknown <= rowUnknown &&
      otherCapture <= rowCapture &&
      otherCaptureUnknown <= rowCaptureUnknown &&
      otherResource <= rowResource;
    const strictlyBetter =
      other.score > row.score ||
      other.worstBossWinRate > row.worstBossWinRate ||
      other.bottom5BossWinRate > row.bottom5BossWinRate ||
      other.storyClearGeometricScore > row.storyClearGeometricScore ||
      other.storyClearCoverageScore > row.storyClearCoverageScore ||
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
    bottom5BossWinRate: evaluation.bottom5BossWinRate,
    storyClearGeometricScore: evaluation.storyClearGeometricScore,
    storyClearCoverageScore: evaluation.storyClearCoverageScore,
    storyClearTargetWinRate: evaluation.storyClearTargetWinRate,
    storyClearBottomK: evaluation.storyClearBottomK,
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
      wins: row.wins,
      losses: row.losses,
      winRate: row.winRate,
      playerLead: row.playerLead || null,
      skipped: row.skipped || false,
    })),
  };
}

async function screenCandidates(
  candidates,
  story,
  moveAccess,
  screenRuns,
  expContext = null,
  grindPolicy = 'none',
  objective = 'mean',
) {
  const rows = [];
  for (const candidate of candidates) {
    const evaluation = await evaluateCandidates(
      [candidate],
      story.bosses,
      screenRuns,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    );
    rows.push({ candidate, evaluation });
  }
  rows.sort((a, b) =>
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
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
    a.bottom5BossWinRate >= b.bottom5BossWinRate &&
    a.storyClearGeometricScore >= b.storyClearGeometricScore &&
    a.storyClearCoverageScore >= b.storyClearCoverageScore &&
    aExp <= bExp &&
    aUnknown <= bUnknown &&
    aCapture <= bCapture &&
    aCaptureUnknown <= bCaptureUnknown &&
    aResource <= bResource;
  const strictlyBetter =
    a.score > b.score ||
    a.worstBossWinRate > b.worstBossWinRate ||
    a.bottom5BossWinRate > b.bottom5BossWinRate ||
    a.storyClearGeometricScore > b.storyClearGeometricScore ||
    a.storyClearCoverageScore > b.storyClearCoverageScore ||
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

function selectMultiObjectiveBeam(states, width, objective = 'mean') {
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
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
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
    b.evaluation.bottom5BossWinRate - a.evaluation.bottom5BossWinRate ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const byBottom5 = [...front].sort((a, b) =>
    b.evaluation.bottom5BossWinRate - a.evaluation.bottom5BossWinRate ||
    b.evaluation.worstBossWinRate - a.evaluation.worstBossWinRate ||
    b.evaluation.score - a.evaluation.score ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );

  add(byScore[0]);
  add(byBottom5[0]);
  add(byWorstBoss[0]);
  add(byExp[0]);
  add(byCapture[0]);
  add(byResource[0]);

  for (const state of byScore) add(state);

  if (selected.length < width) {
    const fallback = [...states].sort((a, b) =>
      evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
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

function selectCandidateScreenRows(rows, width, objective = 'mean') {
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
    (a, b) => evaluationObjectiveCompare(a.evaluation, b.evaluation, objective),
    (a, b) => b.evaluation.bottom5BossWinRate - a.evaluation.bottom5BossWinRate,
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
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
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
  grindPolicy = 'none',
  evaluationCache = null,
  objective = 'mean',
}) {
  const screenRows = screenRowsOverride || await screenCandidates(
    candidates,
    story,
    moveAccess,
    screenRuns,
    expContext,
    grindPolicy,
    objective,
  );

  const eligibleScreenRows = requiredCandidate
    ? screenRows.filter(row =>
        row.candidate.exclusiveGroup !== 'starter' ||
        candidateIdentity(row.candidate) === candidateIdentity(requiredCandidate)
      )
    : screenRows;
  let screened = selectCandidateScreenRows(eligibleScreenRows, candidateCap, objective)
    .map(row => row.candidate);
  if (requiredCandidate && !screened.some(mon => candidateIdentity(mon) === candidateIdentity(requiredCandidate))) {
    screened = [requiredCandidate, ...screened.slice(0, Math.max(0, candidateCap - 1))];
  }

  const cache = evaluationCache || new Map();
  const cacheSizeBefore = cache.size;
  async function evaluateTeamAtRuns(team, requestedRuns) {
    const key = team.map(candidateIdentity).sort().join('|') +
      `@runs=${requestedRuns}@objective=${objective}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        await evaluateCandidates(
          team,
          story.bosses,
          requestedRuns,
          moveAccess,
          expContext,
          grindPolicy,
          objective,
        )
      );
    }
    return cache.get(key);
  }
  async function evaluateTeam(team) {
    return evaluateTeamAtRuns(team, runs);
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

    beam = selectMultiObjectiveBeam(expanded, beamWidth, objective);
    if (!beam.length) break;
  }

  const finalStates = [];
  for (const state of beam) {
    const evaluation = Number(finalRuns) === Number(runs)
      ? state.evaluation
      : await evaluateTeamAtRuns(state.team, finalRuns);
    finalStates.push({ team: state.team, evaluation });
  }
  finalStates.sort((a, b) =>
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
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
      bottom5BossWinRate: row.evaluation.bottom5BossWinRate,
      storyClearGeometricScore: row.evaluation.storyClearGeometricScore,
      storyClearCoverageScore: row.evaluation.storyClearCoverageScore,
      catchUpLevels: row.evaluation.catchUpLevels,
      catchUpUnknown: row.evaluation.catchUpUnknown,
      catchUpExp: row.evaluation.catchUpExp,
      catchUpExpUnknown: row.evaluation.catchUpExpUnknown,
      expBurden: evaluationExpBurden(row.evaluation),
      expBurdenUnknown: evaluationExpUnknown(row.evaluation),
    })),
    evaluatedTeams: cache.size - cacheSizeBefore,
    cachedEvaluationsTotal: cache.size,
    finalRescoredTeams: finalStates.length,
    finalRunsPerBoss: finalRuns,
    objective,
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
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'balanced'));
  const objective = normalizeSearchObjective(arg('objective', 'mean'));
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
    loadExpContext(
      story,
      expProfile,
      version,
      grindPolicy,
      entryLevelPolicy,
      sameStageJoinPolicy,
      expAllocator,
    ),
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
      grindPolicy,
      objective,
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
      entryLevelPolicy,
      sameStageJoinPolicy,
      expAllocator,
      objective,
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
    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    );
    results.push(searchResultRow(team, evaluation));
    tested += 1;
    if (tested >= limit) break;
  }

  results.sort((a, b) =>
    evaluationObjectiveCompare(a, b, objective) ||
    rowExpBurden(a) - rowExpBurden(b) ||
    a.team.slice().sort().join('|').localeCompare(b.team.slice().sort().join('|'))
  );
  console.log(JSON.stringify({
    pool: poolPath,
    version: poolPath === 'canonical' ? version : undefined,
    strategy,
    starter: requiredCandidate?.species || 'any',
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    tested,
    rejectedByConstraints,
    runsPerBoss: runs,
    paretoFront: paretoFront(results),
    top: results.slice(0, 20),
  }, null, 2));
}

async function cmdConvergence() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = arg('starter', 'Cyndaquil');
  const runs = Number(arg('runs', '1'));
  const screenRuns = Number(arg('screen-runs', '1'));
  const finalRuns = Number(arg('final-runs', '3'));
  const teamSize = Number(arg('team-size', '6'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'balanced'));
  const objective = normalizeSearchObjective(arg('objective', 'mean'));
  const beamWidths = String(arg('beam-widths', '4,8,16'))
    .split(',').map(Number).filter(value => Number.isInteger(value) && value > 0);
  const candidateCaps = String(arg('candidate-caps', '16,24,32'))
    .split(',').map(Number).filter(value => Number.isInteger(value) && value > 0);
  const pairArg = String(arg('pairs', '')).trim();
  let configurations = [];
  if (pairArg) {
    configurations = pairArg.split(',').map(value => {
      const [beamWidth, candidateCap] = value.split(':').map(Number);
      if (!Number.isInteger(beamWidth) || beamWidth <= 0 ||
          !Number.isInteger(candidateCap) || candidateCap <= 0) {
        throw new Error(`Invalid convergence pair: ${value}. Use beam:candidate, e.g. 4:16`);
      }
      return { beamWidth, candidateCap };
    });
  } else {
    if (!beamWidths.length || !candidateCaps.length) {
      throw new Error('convergence requires positive --beam-widths and --candidate-caps');
    }
    configurations = candidateCaps.flatMap(candidateCap =>
      beamWidths.map(beamWidth => ({ beamWidth, candidateCap }))
    );
  }

  const story = await loadStory();
  const [pool, moveAccess, expContext] = await Promise.all([
    loadCanonicalPool(version, story),
    loadMoveAccess(resourceProfile, spendPolicy),
    loadExpContext(
      story,
      expProfile,
      version,
      grindPolicy,
      entryLevelPolicy,
      sameStageJoinPolicy,
      expAllocator,
    ),
  ]);
  const candidates = pool.candidates;
  const requiredCandidate = findStarterCandidate(candidates, starterName);
  const screenRows = await screenCandidates(
    candidates,
    story,
    moveAccess,
    screenRuns,
    expContext,
    grindPolicy,
    objective,
  );

  const rows = [];
  const sharedEvaluationCache = new Map();
  for (const { beamWidth, candidateCap } of configurations) {
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
      grindPolicy,
      evaluationCache: sharedEvaluationCache,
      objective,
    });
    const top = result.top[0] || null;
    rows.push({
      beamWidth,
      candidateCap,
      evaluatedTeams: result.evaluatedTeams,
      cachedEvaluationsTotal: result.cachedEvaluationsTotal,
      finalRescoredTeams: result.finalRescoredTeams,
      team: top?.team || [],
      finalTeam: top?.finalTeam || [],
      score: top?.score ?? null,
      worstBossWinRate: top?.worstBossWinRate ?? null,
      bottom5BossWinRate: top?.bottom5BossWinRate ?? null,
      storyClearGeometricScore: top?.storyClearGeometricScore ?? null,
      storyClearCoverageScore: top?.storyClearCoverageScore ?? null,
      expBurden: top?.expBurden ?? null,
      captureExpectedEncounters: top?.captureSearch?.expectedEncounters ?? null,
      resourceBurden: top ? rowResourceBurden(top) : null,
    });
  }

  const baseline = rows
    .slice()
    .sort((a, b) =>
      b.candidateCap - a.candidateCap ||
      b.beamWidth - a.beamWidth
    )[0] || null;
  const baselineSet = new Set(baseline?.team || []);
  for (const row of rows) {
    const overlap = row.team.filter(species => baselineSet.has(species)).length;
    row.baselineTeamOverlap = overlap;
    row.baselineTeamOverlapRatio = baselineSet.size ? overlap / baselineSet.size : null;
    row.scoreDeltaFromLargest = baseline && row.score !== null && baseline.score !== null
      ? row.score - baseline.score
      : null;
  }

  console.log(JSON.stringify({
    version,
    starter: requiredCandidate?.species || 'any',
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    runsPerBoss: runs,
    screenRunsPerBoss: screenRuns,
    finalRunsPerBoss: finalRuns,
    teamSize,
    configurations,
    baseline: baseline ? {
      beamWidth: baseline.beamWidth,
      candidateCap: baseline.candidateCap,
      team: baseline.team,
      score: baseline.score,
      worstBossWinRate: baseline.worstBossWinRate,
      bottom5BossWinRate: baseline.bottom5BossWinRate,
      storyClearGeometricScore: baseline.storyClearGeometricScore,
      storyClearCoverageScore: baseline.storyClearCoverageScore,
    } : null,
    rows,
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
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'balanced'));
  const objective = normalizeSearchObjective(arg('objective', 'mean'));

  const story = await loadStory();
  const moveAccess = await loadMoveAccess(resourceProfile, spendPolicy);
  const output = {
    schemaVersion: 1,
    sourceCommit: story.config.sourceCommit,
    battleEngine: 'pokemon-showdown@0.11.11/gen4customgame',
    policy: 'player-heuristic+source-guided-hgss-trainer-ai',
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
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
      loadExpContext(
        story,
        expProfile,
        version,
        grindPolicy,
        entryLevelPolicy,
        sameStageJoinPolicy,
        expAllocator,
      ),
    ]);
    const candidates = pool.candidates;
    const screenRows = await screenCandidates(
      candidates,
      story,
      moveAccess,
      screenRuns,
      expContext,
      grindPolicy,
      objective,
    );
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
        grindPolicy,
        objective,
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
  const levelsByBattle = schedule.battles.map(battle => battle.levelsBefore || {});
  const singleUsePlan = planSingleUseMachines(team, route, moveAccess, { levelsByBattle });
  const budget = naturalPurchaseBudget(schedule);
  const budgeted = planPurchasableMachines(
    team,
    route,
    moveAccess,
    singleUsePlan,
    { maxMoneyEquivalent: budget, moneyPerCoin: MONEY_PER_COIN, levelsByBattle },
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
    if (route.length !== 30) {
      throw new Error(`${starter} route expected 30 battles through Red, got ${route.length}`);
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
  if (noStarterRoute.length !== 26 || noStarterRoute.some(battle => battle.kind === 'rival')) {
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

  const expectedRouteBattleCount = storyBattlesForCandidates(story.bosses, team).length;
  if (natural.routeBattleCount !== expectedRouteBattleCount ||
      paid.routeBattleCount !== expectedRouteBattleCount) {
    throw new Error(
      `EXP-route smoke expected ${expectedRouteBattleCount} battles, got natural=${natural.routeBattleCount}, paid=${paid.routeBattleCount}`
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

async function cmdExpEnvelope() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const runs = Number(arg('runs', '3'));
  const requestedTeam = String(arg(
    'team',
    'Cyndaquil,Mareep,Geodude,Zubat,Lapras,Tentacool'
  )).split(',').map(value => value.trim()).filter(Boolean);

  const story = await loadStory();
  const pool = await loadCanonicalPool(version, story);
  const team = requestedTeam.map(name => {
    const candidate = pool.candidates.find(mon => mon.species.toLowerCase() === name.toLowerCase());
    if (!candidate) throw new Error(`EXP-envelope candidate not found: ${name}`);
    return candidate;
  });
  const moveAccess = await loadMoveAccess(resourceProfile, spendPolicy);

  const profiles = [
    { name: 'major', expProfile: 'major', grindPolicy: 'none' },
    { name: 'normalRoute', expProfile: 'normal-route', grindPolicy: 'none' },
    { name: 'natural', expProfile: 'all-accessible', grindPolicy: 'none' },
    { name: 'acePaid', expProfile: 'all-accessible', grindPolicy: 'ace-paid' },
  ];

  const results = {};
  for (const profile of profiles) {
    const expContext = await loadExpContext(
      story,
      profile.expProfile,
      version,
      profile.grindPolicy,
    );
    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      expContext,
    );
    results[profile.name] = searchResultRow(team, evaluation);
  }

  console.log(JSON.stringify({
    version,
    resourceProfile,
    spendPolicy,
    runsPerBoss: runs,
    team: team.map(mon => mon.species),
    results,
  }, null, 2));
}

async function cmdExpEnvelopeSmoke() {
  const version = 'HEARTGOLD';
  const story = await loadStory();
  const pool = await loadCanonicalPool(version, story);
  const names = ['Cyndaquil', 'Mareep', 'Geodude'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing EXP-envelope smoke candidate: ${name}`);
    return candidate;
  });
  const moveAccess = await loadMoveAccess('core', 'natural');

  const evaluations = {};
  for (const [name, expProfile, grindPolicy] of [
    ['major', 'major', 'none'],
    ['normalRoute', 'normal-route', 'none'],
    ['natural', 'all-accessible', 'none'],
    ['acePaid', 'all-accessible', 'ace-paid'],
  ]) {
    const expContext = await loadExpContext(story, expProfile, version, grindPolicy);
    evaluations[name] = await evaluateCandidates(
      team,
      story.bosses,
      1,
      moveAccess,
      expContext,
    );
  }

  if (!(evaluations.normalRoute.expSchedule.totalNaturalExp > evaluations.major.expSchedule.totalNaturalExp)) {
    throw new Error('Normal-route EXP envelope should exceed major-only EXP supply');
  }
  if (!(evaluations.natural.expSchedule.totalNaturalExp >= evaluations.normalRoute.expSchedule.totalNaturalExp)) {
    throw new Error('All-accessible EXP envelope should not be below normal-route EXP supply');
  }
  if (!(evaluations.acePaid.expSchedule.totalGrindExp > 0)) {
    throw new Error('Ace-paid envelope should record non-zero grind EXP');
  }
  if (!(evaluations.acePaid.expSchedule.totalExpectedGrindBattles > 0)) {
    throw new Error('Ace-paid envelope should record expected wild battles');
  }

  console.log(JSON.stringify(Object.fromEntries(
    Object.entries(evaluations).map(([name, evaluation]) => [name, {
      score: evaluation.score,
      worstBossWinRate: evaluation.worstBossWinRate,
      finalLevels: evaluation.finalLevels,
      totalNaturalExp: evaluation.expSchedule.totalNaturalExp,
      totalGrindExp: evaluation.expSchedule.totalGrindExp,
      expectedGrindBattles: evaluation.expSchedule.totalExpectedGrindBattles,
    }])
  ), null, 2));
}

async function cmdExpBudget() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const profile = normalizeExpProfile(arg('exp-profile', 'all-accessible'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'balanced'));
  if (profile === 'ace') {
    throw new Error('exp-budget requires --exp-profile=major, normal-route, or all-accessible');
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
  const expContext = await loadExpContext(
    story,
    profile,
    version,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
  );
  const schedule = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    allocator: expAllocator,
    levelUtility: candidateBossUtility,
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
  const expContext = await loadExpContext(story, 'all-accessible', 'HEARTGOLD');

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

async function cmdExpSegmentSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const names = ['Cyndaquil', 'Gyarados'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing segment-smoke candidate: ${name}`);
    return candidate;
  });
  const gyarados = team.find(mon => mon.species === 'Gyarados');
  const gyaradosKey = gyarados.familyId || gyarados.species;
  const route = storyBattlesForCandidates(story.bosses, team);
  const expContext = await loadExpContext(
    story,
    'all-accessible',
    'HEARTGOLD',
    'none',
    'midpoint',
    'map-order',
  );
  const schedule = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'all-accessible',
    grindPolicy: 'none',
    entryLevelPolicy: 'midpoint',
    sameStageJoinPolicy: 'map-order',
  });

  const silverAzalea = schedule.battles.find(battle => battle.label === 'Silver (Azalea)');
  const whitney = schedule.battles.find(battle => battle.label === 'Whitney');
  if (!silverAzalea || !whitney) throw new Error('Missing stage-2 boss windows');
  if (silverAzalea.mapSegments.some(segment => ['R34', 'R35', 'R36'].includes(segment.map))) {
    throw new Error('Goldenrod-route EXP leaked before Silver (Azalea)');
  }
  if (!whitney.mapSegments.some(segment => segment.map === 'R34')) {
    throw new Error('Route 34 EXP was not delayed to the Whitney boss window');
  }

  const stage6 = schedule.battles.find(battle => Number(battle.stage) === 6);
  if (!stage6) throw new Error('Missing stage-6 battle in segment smoke');
  const t29Index = stage6.mapSegments.findIndex(segment => segment.map === 'T29');
  if (t29Index < 0) throw new Error('Stage-6 segment order is missing Lake of Rage map T29');
  const earlier = stage6.mapSegments.slice(0, t29Index);
  if (earlier.some(segment => segment.joinedBeforeMapExp.includes(gyaradosKey))) {
    throw new Error('Gyarados joined before reaching its T29 acquisition segment');
  }
  if (!stage6.mapSegments[t29Index].joinedBeforeMapExp.includes(gyaradosKey)) {
    throw new Error(
      `Gyarados did not join at T29: ${JSON.stringify(stage6.mapSegments[t29Index])}`
    );
  }
  if (stage6.joinedAfterMapExp.includes(gyaradosKey)) {
    throw new Error('Mapped Gyarados acquisition fell back to after-map EXP join');
  }

  console.log(JSON.stringify({
    gyaradosKey,
    stage: stage6.stage,
    mapSegments: stage6.mapSegments,
    joinedAfterMapExp: stage6.joinedAfterMapExp,
    levelsBefore: stage6.levelsBefore,
  }, null, 2));
}

async function cmdExpAllocatorSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const names = ['Cyndaquil', 'Mareep', 'Geodude', 'Zubat', 'Lapras', 'Tentacool'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing allocator-smoke candidate: ${name}`);
    return candidate;
  });
  const route = storyBattlesForCandidates(story.bosses, team);
  const expContext = await loadExpContext(story, 'normal-route', 'HEARTGOLD');

  const balanced = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'balanced',
  });
  const bossAwareSoft = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware-soft',
    levelUtility: candidateBossUtility,
  });
  const bossAware = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware',
    levelUtility: candidateBossUtility,
  });
  const breakpointAware = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'breakpoint-aware',
    levelUtility: candidateBossUtility,
  });
  const breakpointAwareReversed = buildTeamExpSchedule({
    candidates: [...team].reverse(),
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'breakpoint-aware',
    levelUtility: candidateBossUtility,
  });

  for (const schedule of [bossAwareSoft, bossAware, breakpointAware, breakpointAwareReversed]) {
    if (balanced.totalNaturalExp !== schedule.totalNaturalExp) {
      throw new Error(
        `Allocator changed total natural EXP: ${balanced.totalNaturalExp} != ${schedule.totalNaturalExp}`
      );
    }
  }
  if (JSON.stringify(balanced.finalLevels) === JSON.stringify(bossAware.finalLevels)) {
    throw new Error('Boss-aware allocator produced the same final level allocation as balanced');
  }
  if (JSON.stringify(breakpointAware.finalLevels) !== JSON.stringify(breakpointAwareReversed.finalLevels)) {
    throw new Error(
      `Breakpoint-aware allocator depends on team order: ${JSON.stringify(breakpointAware.finalLevels)} != ${JSON.stringify(breakpointAwareReversed.finalLevels)}`
    );
  }

  const breakpointStates = [
    {
      key: 'breakpoint',
      candidate: { species: 'BreakpointMon' },
      growthRate: 'MEDIUM_FAST',
      level: 10,
      exp: expAtLevel('MEDIUM_FAST', 10),
      unknown: false,
    },
    {
      key: 'steady',
      candidate: { species: 'SteadyMon' },
      growthRate: 'MEDIUM_FAST',
      level: 10,
      exp: expAtLevel('MEDIUM_FAST', 10),
      unknown: false,
    },
  ];
  const syntheticUtility = (candidate, _boss, level) => {
    if (candidate.species === 'BreakpointMon') return level >= 12 ? 120 : 8;
    return 10 + (level - 10) * 4;
  };
  const syntheticAmount =
    expAtLevel('MEDIUM_FAST', 12) - expAtLevel('MEDIUM_FAST', 10);
  const synthetic = allocateBreakpointAwareExp(
    breakpointStates,
    syntheticAmount,
    [{ label: 'next' }, { label: 'later' }],
    syntheticUtility,
    { bossHorizon: 2, levelLookahead: 4, discount: 0.72 },
  );
  if (synthetic.allocated !== syntheticAmount || synthetic.unallocated !== 0) {
    throw new Error(`Breakpoint allocator failed EXP conservation: ${JSON.stringify(synthetic)}`);
  }
  if (breakpointStates[0].level < 12 || breakpointStates[1].level !== 10) {
    throw new Error(
      `Breakpoint allocator failed to fund the future breakpoint: ${JSON.stringify(breakpointStates)}`
    );
  }

  const levelSpread = schedule => {
    const levels = Object.values(schedule.finalLevels).map(Number);
    return levels.length ? Math.max(...levels) - Math.min(...levels) : 0;
  };
  if (!(levelSpread(bossAwareSoft) < levelSpread(bossAware))) {
    throw new Error(
      `Boss-aware-soft did not reduce level spread: soft=${levelSpread(bossAwareSoft)}, unrestricted=${levelSpread(bossAware)}`
    );
  }

  console.log(JSON.stringify({
    totalNaturalExp: balanced.totalNaturalExp,
    balanced: { allocator: balanced.allocator, finalLevels: balanced.finalLevels },
    bossAwareSoft: {
      allocator: bossAwareSoft.allocator,
      levelPenaltyScale: bossAwareSoft.bossAwareSoftLevelScale,
      levelSpread: levelSpread(bossAwareSoft),
      finalLevels: bossAwareSoft.finalLevels,
    },
    bossAware: { allocator: bossAware.allocator, finalLevels: bossAware.finalLevels },
    breakpointAware: {
      allocator: breakpointAware.allocator,
      bossHorizon: breakpointAware.breakpointBossHorizon,
      levelLookahead: breakpointAware.breakpointLevelLookahead,
      discount: breakpointAware.breakpointDiscount,
      levelSpread: levelSpread(breakpointAware),
      finalLevels: breakpointAware.finalLevels,
    },
    syntheticBreakpoint: {
      allocated: synthetic.allocated,
      finalLevels: Object.fromEntries(breakpointStates.map(state => [state.key, state.level])),
    },
  }, null, 2));
}

async function cmdTeamOrderSmoke() {
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const names = ['Cyndaquil', 'Mareep', 'Geodude'];
  const team = names.map(name => {
    const candidate = pool.candidates.find(mon => mon.species === name);
    if (!candidate) throw new Error(`Missing team-order smoke candidate: ${name}`);
    return candidate;
  });
  const reversed = [...team].reverse();
  const shortRoute = story.bosses.filter(battle => Number(battle.stage) <= 2);
  const [moveAccess, expContext] = await Promise.all([
    loadMoveAccess('core', 'natural'),
    loadExpContext(
      story,
      'normal-route',
      'HEARTGOLD',
      'none',
      'midpoint',
      'map-order',
      'balanced',
    ),
  ]);

  const a = await evaluateCandidates(team, shortRoute, 2, moveAccess, expContext, 'none', 'story-clear');
  const b = await evaluateCandidates(reversed, shortRoute, 2, moveAccess, expContext, 'none', 'story-clear');
  const summary = evaluation => ({
    score: evaluation.score,
    coverage: evaluation.storyClearCoverageScore,
    worst: evaluation.worstBossWinRate,
    bottom5: evaluation.bottom5BossWinRate,
    rows: evaluation.rows.map(row => ({
      boss: row.boss,
      wins: row.wins,
      losses: row.losses,
      lead: row.playerLead,
    })),
  });

  if (JSON.stringify(summary(a)) !== JSON.stringify(summary(b))) {
    throw new Error(
      `Candidate input order changed battle evaluation: ${JSON.stringify({ a: summary(a), b: summary(b) })}`
    );
  }
  console.log(JSON.stringify(summary(a), null, 2));
}

async function cmdObjectiveSmoke() {
  const fragileRows = [
    ...Array.from({ length: 16 }, () => ({ winRate: 1, wins: 10, losses: 0 })),
    ...Array.from({ length: 5 }, () => ({ winRate: 0, wins: 0, losses: 10 })),
  ];
  const resilientRows = [
    ...Array.from({ length: 11 }, () => ({ winRate: 1, wins: 10, losses: 0 })),
    ...Array.from({ length: 10 }, () => ({ winRate: 0.4, wins: 4, losses: 6 })),
  ];
  const fragile = {
    score: 16 / 21,
    worstBossWinRate: 0,
    bottom5BossWinRate: lowerTailBossWinRate(fragileRows),
    storyClearGeometricScore: storyClearGeometricScore(fragileRows),
    storyClearCoverageScore: storyClearCoverageScore(fragileRows),
  };
  const resilient = {
    score: (11 + 10 * 0.4) / 21,
    worstBossWinRate: 0.4,
    bottom5BossWinRate: lowerTailBossWinRate(resilientRows),
    storyClearGeometricScore: storyClearGeometricScore(resilientRows),
    storyClearCoverageScore: storyClearCoverageScore(resilientRows),
  };

  if (!(evaluationObjectiveCompare(fragile, resilient, 'mean') < 0)) {
    throw new Error('Mean objective did not prefer the higher mean-win-rate evaluation');
  }
  if (!(evaluationObjectiveCompare(resilient, fragile, 'story-clear') < 0)) {
    throw new Error('Story-clear objective did not prefer the stronger lower tail');
  }

  const rows = [0.9, 0.8, 0.4, 0.3, 0.2, 0.1].map(winRate => ({ winRate }));
  const bottom5 = lowerTailBossWinRate(rows);
  const expected = (0.1 + 0.2 + 0.3 + 0.4 + 0.8) / 5;
  if (Math.abs(bottom5 - expected) > 1e-12) {
    throw new Error(`Bottom-5 calculation mismatch: expected ${expected}, got ${bottom5}`);
  }

  console.log(JSON.stringify({
    bottomK: STORY_CLEAR_BOTTOM_K,
    targetWinRate: STORY_CLEAR_TARGET_WIN_RATE,
    lowerTailExample: bottom5,
    fragileGeometric: fragile.storyClearGeometricScore,
    resilientGeometric: resilient.storyClearGeometricScore,
    fragileCoverage: fragile.storyClearCoverageScore,
    resilientCoverage: resilient.storyClearCoverageScore,
    meanPrefers: 'fragile',
    storyClearPrefers: 'resilient',
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

async function cmdAllocatorCrossCompare() {
  const runs = Number(arg('runs', '20'));
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const [moveAccess, bossAwareContext, breakpointContext] = await Promise.all([
    loadMoveAccess('money', 'natural'),
    loadExpContext(
      story,
      'normal-route',
      'HEARTGOLD',
      'none',
      'midpoint',
      'map-order',
      'boss-aware',
    ),
    loadExpContext(
      story,
      'normal-route',
      'HEARTGOLD',
      'none',
      'midpoint',
      'map-order',
      'breakpoint-aware',
    ),
  ]);

  const teams = {
    bossAwareTop: ['Cyndaquil', 'Chinchou', 'Abra', 'Magikarp', 'Pidgey', 'Qwilfish'],
    breakpointTop: ['Cyndaquil', 'Lapras', 'Chinchou', 'Sentret', 'Magnemite', 'Hoothoot'],
  };
  const allocators = {
    bossAware: bossAwareContext,
    breakpointAware: breakpointContext,
  };

  const results = {};
  for (const [teamLabel, names] of Object.entries(teams)) {
    const candidates = selectByNames(pool.candidates, names);
    results[teamLabel] = { team: names, conditions: {} };
    for (const [allocatorLabel, expContext] of Object.entries(allocators)) {
      const evaluation = await evaluateCandidatesWithMoveAccess(
        candidates,
        story.bosses,
        runs,
        moveAccess,
        expContext,
        'none',
      );
      results[teamLabel].conditions[allocatorLabel] = {
        expAllocator: expContext.expAllocator,
        score: evaluation.score,
        worstBossWinRate: evaluation.worstBossWinRate,
        bottom5BossWinRate: evaluation.bottom5BossWinRate,
        storyClearGeometricScore: evaluation.storyClearGeometricScore,
        storyClearCoverageScore: evaluation.storyClearCoverageScore,
        finalTeam: evaluation.finalTeam,
        finalLevels: evaluation.finalLevels,
        purchaseCosts: evaluation.purchaseCosts,
        resourceBudget: evaluation.resourceBudget,
        bosses: evaluation.rows.map(row => ({
          boss: row.boss,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          winRate: row.winRate,
          playerLevels: row.playerLevels,
          playerLead: row.playerLead,
        })),
      };
    }
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'controlled EXP allocator 2x2 cross-test with fixed teams, seeds, route, moves, trainer AI, and player policy',
    version: 'HEARTGOLD',
    starter: 'Cyndaquil',
    runsPerBoss: runs,
    resourceProfile: 'money',
    spendPolicy: 'natural',
    expProfile: 'normal-route',
    grindPolicy: 'none',
    entryLevelPolicy: 'midpoint',
    sameStageJoinPolicy: 'map-order',
    allocators: {
      bossAware: 'existing immediate next-boss utility per EXP allocator',
      breakpointAware: 'boss-aware baseline plus actual move/evolution breakpoint bonus across a 4-boss, 12-level lookahead',
    },
    results,
  }, null, 2));
}

async function cmdTrainerAiCompare() {
  const runs = Number(arg('runs', '20'));
  const story = await loadStory();
  const pool = await loadCanonicalPool('HEARTGOLD', story);
  const [moveAccess, expContext] = await Promise.all([
    loadMoveAccess('money', 'natural'),
    loadExpContext(
      story,
      'normal-route',
      'HEARTGOLD',
      'none',
      'midpoint',
      'map-order',
      'boss-aware',
    ),
  ]);

  const teams = {
    oldRedTop: ['Cyndaquil', 'Lapras', 'Abra', 'Pidgey', 'Caterpie', 'Chinchou'],
    newAiTop: ['Cyndaquil', 'Chinchou', 'Abra', 'Magikarp', 'Pidgey', 'Qwilfish'],
  };
  const modes = {
    greedy: { p2AiMode: 'greedy' },
    hgssNoItems: { p2AiMode: 'hgss', p2TrainerItems: false },
    hgssItems: { p2AiMode: 'hgss', p2TrainerItems: true },
  };

  const results = {};
  for (const [teamLabel, names] of Object.entries(teams)) {
    const candidates = selectByNames(pool.candidates, names);
    results[teamLabel] = {
      team: names,
      conditions: {},
    };
    for (const [modeLabel, battleOptions] of Object.entries(modes)) {
      const evaluation = await evaluateCandidatesWithMoveAccess(
        candidates,
        story.bosses,
        runs,
        moveAccess,
        expContext,
        'none',
        battleOptions,
      );
      results[teamLabel].conditions[modeLabel] = {
        score: evaluation.score,
        worstBossWinRate: evaluation.worstBossWinRate,
        bottom5BossWinRate: evaluation.bottom5BossWinRate,
        storyClearGeometricScore: evaluation.storyClearGeometricScore,
        storyClearCoverageScore: evaluation.storyClearCoverageScore,
        finalTeam: evaluation.finalTeam,
        finalLevels: evaluation.finalLevels,
        purchaseCosts: evaluation.purchaseCosts,
        resourceBudget: evaluation.resourceBudget,
        bosses: evaluation.rows.map(row => ({
          boss: row.boss,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          winRate: row.winRate,
          averageTurns: row.averageTurns,
          averageP1VoluntarySwitches: row.averageP1VoluntarySwitches,
          averageP2VoluntarySwitches: row.averageP2VoluntarySwitches,
          averageP2ForcedSwitches: row.averageP2ForcedSwitches,
          averageP2MoveDecisions: row.averageP2MoveDecisions,
          averageP2TrainerItemUses: row.averageP2TrainerItemUses,
          p2AiMode: row.p2AiMode,
        })),
      };
    }
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'controlled trainer AI A/B with fixed teams, seeds, route, EXP, moves, and player policy',
    version: 'HEARTGOLD',
    runsPerBoss: runs,
    resourceProfile: 'money',
    spendPolicy: 'natural',
    expProfile: 'normal-route',
    grindPolicy: 'none',
    entryLevelPolicy: 'midpoint',
    sameStageJoinPolicy: 'map-order',
    expAllocator: 'boss-aware',
    playerPolicy: 'unchanged greedy-moves+bounded matchup switching',
    conditions: {
      greedy: 'legacy greedy NPC move policy; no HGSS switching or trainer items',
      hgssNoItems: 'source-guided HGSS NPC move/switch AI; trainer items disabled',
      hgssItems: 'source-guided HGSS NPC move/switch AI; trainer items enabled',
    },
    results,
  }, null, 2));
}

async function cmdTrainerAiSmoke() {
  const story = await loadStory();
  const falkner = story.bosses.find(boss => boss.label === 'Falkner');
  const whitney = story.bosses.find(boss => boss.label === 'Whitney');
  const red = story.bosses.find(boss => boss.label === 'Red');
  if (!falkner || !whitney || !red) throw new Error('Expected Falkner, Whitney, and Red in story route');

  const falknerProfile = trainerAiProfile(falkner);
  const whitneyProfile = trainerAiProfile(whitney);
  const redProfile = trainerAiProfile(red);

  if (falknerProfile.aiFlags !== 3) {
    throw new Error(`Expected Falkner ai_flags=3, got ${falknerProfile.aiFlags}`);
  }
  const falknerFlags = decodeHgssAiFlags(falknerProfile.aiFlags);
  if (!falknerFlags.includes('BASIC') || !falknerFlags.includes('EVAL_ATTACK')) {
    throw new Error(`Unexpected Falkner AI flags: ${falknerFlags.join(',')}`);
  }
  if (whitneyProfile.items.filter(item => item === 'ITEM_SUPER_POTION').length !== 2) {
    throw new Error(`Expected Whitney Super Potion x2, got ${whitneyProfile.items.join(',')}`);
  }
  if (redProfile.items.filter(item => item === 'ITEM_FULL_RESTORE').length !== 4) {
    throw new Error(`Expected Red Full Restore x4, got ${redProfile.items.join(',')}`);
  }

  const mockRequest = {
    side: {
      pokemon: [
        { active: true, condition: '0 fnt' },
        { active: false, condition: '50/50' },
        { active: false, condition: '50/50' },
      ],
    },
  };
  const mockSide = {
    pokemon: [
      { species: 'Rattata', fainted: true, moveSlots: [] },
      {
        species: 'Geodude',
        fainted: false,
        moveSlots: [{ id: 'rockthrow', disabled: false }],
        storedStats: { atk: 40, spa: 20 },
        getTypes: () => ['Rock', 'Ground'],
      },
      {
        species: 'Bellsprout',
        fainted: false,
        moveSlots: [{ id: 'vinewhip', disabled: false }],
        storedStats: { atk: 40, spa: 40 },
        getTypes: () => ['Grass', 'Poison'],
      },
    ],
  };
  const mockFoe = {
    species: 'Totodile',
    storedStats: { def: 35, spd: 35 },
  };
  const switchSlot = chooseHgssPostKoSwitch(mockRequest, mockSide, mockFoe);
  if (switchSlot !== 2) {
    throw new Error(`Expected post-KO AI to prefer Bellsprout slot 3 vs Totodile, got slot ${switchSlot}`);
  }

  const moveSlot = chooseHgssMoveIndex(
    { moves: [{ id: 'thunderbolt', disabled: false }, { id: 'quickattack', disabled: false }] },
    {
      species: 'Pikachu',
      level: 50,
      storedStats: { atk: 90, spa: 100 },
      getTypes: () => ['Electric'],
      boosts: {},
      hp: 100,
      maxhp: 100,
    },
    {
      species: 'Geodude',
      storedStats: { def: 100, spd: 80 },
      getTypes: () => ['Rock', 'Ground'],
      boosts: {},
      hp: 100,
      maxhp: 100,
    },
    7,
    { turn: 1, field: { weather: '' } },
    () => false,
  );
  if (moveSlot !== 1) {
    throw new Error(`Expected Gen 4 BASIC AI to avoid immune Thunderbolt vs Geodude, got move slot ${moveSlot}`);
  }

  const itemPlan = chooseHgssTrainerItem(
    { hp: 20, maxhp: 100, fainted: false },
    { pokemon: [{ hp: 20, fainted: false }] },
    ['ITEM_SUPER_POTION'],
    1,
  );
  if (itemPlan?.item !== 'ITEM_SUPER_POTION' || itemPlan.healAmount !== 50) {
    throw new Error(`Expected Super Potion trainer-item decision, got ${JSON.stringify(itemPlan)}`);
  }

  const itemBattle = await runBattle(
    [{
      species: 'Dratini',
      level: 50,
      ability: 'Shed Skin',
      nature: 'Serious',
      moves: ['Dragon Rage'],
    }],
    [{
      species: 'Shuckle',
      level: 50,
      ability: 'Sturdy',
      nature: 'Serious',
      moves: ['Tackle'],
    }],
    77123,
    { p2Trainer: { trainer: { ai_flags: 7, items: ['ITEM_SUPER_POTION'] } } },
  );
  if (!itemBattle.p2TrainerItemsUsed?.includes('ITEM_SUPER_POTION')) {
    throw new Error(`Expected trainer item bridge to consume Super Potion, got ${JSON.stringify(itemBattle)}`);
  }

  const enemyTeam = hgssTrainerToShowdownTeam(falkner.trainer, falkner);
  const playerTeam = [{
    species: 'Mareep',
    level: 13,
    ability: 'Static',
    nature: 'Serious',
    moves: ['ThunderShock', 'Tackle'],
  }];
  const battle = await simulateMatchup(playerTeam, enemyTeam, 1, 982451, { p2Trainer: falkner });
  if (battle.p2AiMode !== 'hgss' || battle.p2AiFlags !== 3 || battle.averageP2MoveDecisions < 1) {
    throw new Error(`HGSS trainer AI metadata/move scoring was not wired into battle: ${JSON.stringify(battle)}`);
  }

  console.log(JSON.stringify({
    falkner: falknerProfile,
    whitney: whitneyProfile,
    red: redProfile,
    postKoSwitchSlot: switchSlot,
    immuneMoveChoiceSlot: moveSlot,
    itemPlan,
    itemBattle,
    battle,
  }, null, 2));
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
  const battle = await simulateMatchup(playerTeam, enemyTeam, 1, 4242, { p2Trainer: falkner });
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
  convergence: cmdConvergence,
  optimize: cmdOptimize,
  'resource-monotonic-smoke': cmdResourceMonotonicSmoke,
  'resource-budget-smoke': cmdResourceBudgetSmoke,
  'move-score-smoke': cmdMoveScoreSmoke,
  'resource-smoke': cmdResourceSmoke,
  'route-smoke': cmdRouteSmoke,
  'exp-envelope': cmdExpEnvelope,
  'exp-envelope-smoke': cmdExpEnvelopeSmoke,
  'exp-budget': cmdExpBudget,
  'exp-budget-smoke': cmdExpBudgetSmoke,
  'exp-segment-smoke': cmdExpSegmentSmoke,
  'exp-allocator-smoke': cmdExpAllocatorSmoke,
  'team-order-smoke': cmdTeamOrderSmoke,
  'objective-smoke': cmdObjectiveSmoke,
  'capture-smoke': cmdCaptureSmoke,
  'exp-route-smoke': cmdExpRouteSmoke,
  'exp-smoke': cmdExpSmoke,
  'switch-smoke': cmdSwitchSmoke,
  'trainer-ai-smoke': cmdTrainerAiSmoke,
  'allocator-cross-compare': cmdAllocatorCrossCompare,
  'trainer-ai-compare': cmdTrainerAiCompare,
  'tutor-smoke': cmdTutorSmoke,
  'hm-smoke': cmdHmSmoke,
  'tm-smoke': cmdTmSmoke,
  'shop-tm-smoke': cmdShopTmSmoke,
  smoke: cmdSmoke,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, resource-budget-smoke, resource-monotonic-smoke, move-score-smoke, resource-smoke, route-smoke, exp-envelope, exp-envelope-smoke, exp-budget, exp-budget-smoke, exp-segment-smoke, exp-allocator-smoke, team-order-smoke, objective-smoke, capture-smoke, exp-route-smoke, exp-smoke, switch-smoke, trainer-ai-smoke, allocator-cross-compare, tutor-smoke, hm-smoke, tm-smoke, shop-tm-smoke, extract, pool, validate, simulate, search, convergence, optimize');
  process.exitCode = 2;
} else {
  await commands[command]();
}
