import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractBosses, loadPretTrainerData } from './hgss-data.mjs';
import { candidateBossUtility, candidateMovePool, candidateMoveUtility, hgssTrainerToShowdownTeam, materializeCandidateTeam, planPurchasableMachines, planSingleUseMachines, runBattle, selectCandidateMoves, simulateMatchup } from './battle.mjs';
import { chooseHgssMoveIndex, chooseHgssPostKoSwitch, chooseHgssTrainerItem, decodeHgssAiFlags, trainerAiProfile } from './trainer-ai.mjs';
import { buildCanonicalCandidatePool, buildRedOnlyCandidateForms, validateCandidateTeam } from './acquisition.mjs';
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
  if (!['balanced', 'boss-aware-soft', 'boss-aware', 'boss-aware-depth', 'boss-aware-saturation', 'breakpoint-aware'].includes(allocator)) {
    throw new Error(
      `Unknown EXP allocator: ${value}. Use balanced, boss-aware-soft, boss-aware, boss-aware-depth, boss-aware-saturation, or breakpoint-aware.`
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

function summarizeMemberUsage(candidates, rows) {
  const byKey = new Map(candidates.map(candidate => [candidateIdentity(candidate), candidate]));
  const summary = {};
  for (const candidate of candidates) {
    const key = candidateIdentity(candidate);
    summary[key] = {
      species: candidate.species,
      mandatoryStarter: candidate.exclusiveGroup === 'starter',
      bossesAvailable: 0,
      bossesUsed: 0,
      bossesUsedInWins: 0,
      runsAvailable: 0,
      runsUsed: 0,
      winningRunsUsed: 0,
      appearances: 0,
      leadStarts: 0,
      moveUses: 0,
      activeTurns: 0,
      faints: 0,
      winningMoveUses: 0,
      winningActiveTurns: 0,
      peakUseRate: 0,
      peakWinningUseRate: 0,
      peakMovesPerRun: 0,
      peakActiveTurnsPerRun: 0,
      peakWinningActiveTurnsPerRun: 0,
      bossUsage: [],
    };
  }

  for (const row of rows || []) {
    for (const [key, usage] of Object.entries(row.p1Usage || {})) {
      if (!summary[key]) {
        const candidate = byKey.get(key);
        summary[key] = {
          species: candidate?.species || key,
          mandatoryStarter: candidate?.exclusiveGroup === 'starter',
          bossesAvailable: 0,
          bossesUsed: 0,
          bossesUsedInWins: 0,
          runsAvailable: 0,
          runsUsed: 0,
          winningRunsUsed: 0,
          appearances: 0,
          leadStarts: 0,
          moveUses: 0,
          activeTurns: 0,
          faints: 0,
          winningMoveUses: 0,
          winningActiveTurns: 0,
          peakUseRate: 0,
          peakWinningUseRate: 0,
          peakMovesPerRun: 0,
          peakActiveTurnsPerRun: 0,
          peakWinningActiveTurnsPerRun: 0,
          bossUsage: [],
        };
      }
      const target = summary[key];
      const available = Number(usage.runsAvailable || 0);
      const used = Number(usage.runsUsed || 0);
      const winningUsed = Number(usage.winningRunsUsed || 0);
      const moves = Number(usage.moveUses || 0);
      const activeTurns = Number(usage.activeTurns || 0);
      const winningActiveTurns = Number(usage.winningActiveTurns || 0);
      if (available > 0) {
        target.bossesAvailable += 1;
        if (used > 0) target.bossesUsed += 1;
        if (winningUsed > 0) target.bossesUsedInWins += 1;
        target.peakUseRate = Math.max(target.peakUseRate, used / available);
        target.peakWinningUseRate = Math.max(target.peakWinningUseRate, winningUsed / available);
        target.peakMovesPerRun = Math.max(target.peakMovesPerRun, moves / available);
        target.peakActiveTurnsPerRun = Math.max(target.peakActiveTurnsPerRun, activeTurns / available);
        target.peakWinningActiveTurnsPerRun = Math.max(
          target.peakWinningActiveTurnsPerRun,
          winningActiveTurns / available,
        );
      }
      target.runsAvailable += available;
      target.runsUsed += used;
      target.winningRunsUsed += winningUsed;
      target.appearances += Number(usage.appearances || 0);
      target.leadStarts += Number(usage.leadStarts || 0);
      target.moveUses += moves;
      target.activeTurns += activeTurns;
      target.faints += Number(usage.faints || 0);
      target.winningMoveUses += Number(usage.winningMoveUses || 0);
      target.winningActiveTurns += winningActiveTurns;
      target.bossUsage.push({
        boss: row.boss,
        runsAvailable: available,
        runsUsed: used,
        winningRunsUsed: winningUsed,
        moveUses: moves,
        activeTurns,
        winningActiveTurns,
      });
    }
  }

  for (const target of Object.values(summary)) {
    target.useRate = target.runsAvailable ? target.runsUsed / target.runsAvailable : 0;
    target.winningUseRate = target.runsAvailable ? target.winningRunsUsed / target.runsAvailable : 0;
    target.movesPerAvailableRun = target.runsAvailable ? target.moveUses / target.runsAvailable : 0;
    target.activeTurnsPerAvailableRun = target.runsAvailable ? target.activeTurns / target.runsAvailable : 0;
    target.winningActiveTurnsPerAvailableRun =
      target.runsAvailable ? target.winningActiveTurns / target.runsAvailable : 0;
  }
  return summary;
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
        activationTargets: expContext?.activationTargets || [],
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
  const memberUsage = summarizeMemberUsage(candidates, rows);
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
    memberUsage,
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
    memberUsage: evaluation.memberUsage,
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

function usageForCandidate(evaluation, candidate) {
  const usage = evaluation?.memberUsage?.[candidateIdentity(candidate)] || null;
  if (!usage) return null;
  return {
    bossesAvailable: Number(usage.bossesAvailable || 0),
    bossesUsed: Number(usage.bossesUsed || 0),
    bossesUsedInWins: Number(usage.bossesUsedInWins || 0),
    runsAvailable: Number(usage.runsAvailable || 0),
    runsUsed: Number(usage.runsUsed || 0),
    winningRunsUsed: Number(usage.winningRunsUsed || 0),
    winningActiveTurns: Number(usage.winningActiveTurns || 0),
    useRate: Number(usage.useRate || 0),
    winningUseRate: Number(usage.winningUseRate || 0),
  };
}

function supportedContributionBosses(ablation, usage) {
  if (!ablation || !usage) return [];
  const winningBosses = new Set(
    (usage.bossUsage || [])
      .filter(row => Number(row.winningRunsUsed || 0) > 0)
      .map(row => row.boss)
  );
  return (ablation.topHelpedBosses || [])
    .filter(row => Number(row.delta || 0) > 0 && winningBosses.has(row.boss))
    .sort((a, b) => Number(b.delta || 0) - Number(a.delta || 0) || a.boss.localeCompare(b.boss));
}

async function memberContributionProfile(
  state,
  evaluateTeamAtRuns,
  requestedRuns,
  requiredCandidate = null,
) {
  const members = [];
  const requiredKey = requiredCandidate ? candidateIdentity(requiredCandidate) : null;
  // Contribution must be paired at the same sampling density. In particular,
  // do not compare a final 20-run full team against a 5-run ablation.
  const contributionFull = await evaluateTeamAtRuns(state.team, requestedRuns);

  for (const candidate of state.team) {
    const key = candidateIdentity(candidate);
    const usageRaw = contributionFull?.memberUsage?.[key] || null;
    const usage = usageForCandidate(contributionFull, candidate);
    if (requiredKey && key === requiredKey) {
      members.push({
        species: candidate.species,
        mandatoryStarter: true,
        meaningful: Number(usage?.winningRunsUsed || 0) > 0,
        usage,
        supportedBosses: [],
        supportedBossCount: 0,
        maxSupportedBossWinRateGain: 0,
      });
      continue;
    }

    const reduced = state.team.filter(mon => candidateIdentity(mon) !== key);
    const removed = await evaluateTeamAtRuns(reduced, requestedRuns);
    const ablation = memberAblationSummary(contributionFull, removed, candidate.species);
    const winningBosses = new Set(
      (usageRaw?.bossUsage || [])
        .filter(row => Number(row.winningRunsUsed || 0) > 0)
        .map(row => row.boss)
    );
    const supportedBosses = (ablation.topHelpedBosses || [])
      .filter(row => Number(row.delta || 0) > 0 && winningBosses.has(row.boss))
      .sort((a, b) => Number(b.delta || 0) - Number(a.delta || 0) || a.boss.localeCompare(b.boss));
    const maxSupportedBossWinRateGain = Number(supportedBosses[0]?.delta || 0);
    members.push({
      species: candidate.species,
      mandatoryStarter: false,
      meaningful: supportedBosses.length > 0,
      usage,
      supportedBosses,
      supportedBossCount: supportedBosses.length,
      maxSupportedBossWinRateGain,
      ablation: {
        scoreDelta: ablation.scoreDelta,
        geometricDelta: ablation.geometricDelta,
        coverageDelta: ablation.coverageDelta,
        bottom5Delta: ablation.bottom5Delta,
        worstBossDelta: ablation.worstBossDelta,
        bossesHelped: ablation.bossesHelped,
        bossesHurt: ablation.bossesHurt,
        maxBossWinRateGain: ablation.maxBossWinRateGain,
      },
    });
  }

  const elective = members.filter(member => !member.mandatoryStarter);
  const meaningfulElective = elective.filter(member => member.meaningful);
  const weakestSupportedBossGain = elective.length
    ? Math.min(...elective.map(member => Number(member.maxSupportedBossWinRateGain || 0)))
    : 0;
  const totalSupportedBossGain = elective.reduce(
    (sum, member) => sum + Number(member.maxSupportedBossWinRateGain || 0),
    0,
  );

  return {
    requestedRuns,
    electiveMemberCount: elective.length,
    meaningfulElectiveCount: meaningfulElective.length,
    allElectiveMeaningful: elective.length > 0 && meaningfulElective.length === elective.length,
    weakestSupportedBossGain,
    totalSupportedBossGain,
    members,
  };
}

function memberContributionCompare(a, b, objective = 'story-clear') {
  const ac = a.memberContribution || {};
  const bc = b.memberContribution || {};
  if (Number(ac.meaningfulElectiveCount || 0) !== Number(bc.meaningfulElectiveCount || 0)) {
    return Number(bc.meaningfulElectiveCount || 0) - Number(ac.meaningfulElectiveCount || 0);
  }
  if (Number(ac.weakestSupportedBossGain || 0) !== Number(bc.weakestSupportedBossGain || 0)) {
    return Number(bc.weakestSupportedBossGain || 0) - Number(ac.weakestSupportedBossGain || 0);
  }
  const storyOrder = evaluationObjectiveCompare(a.evaluation, b.evaluation, objective);
  if (storyOrder !== 0) return storyOrder;
  if (Number(ac.totalSupportedBossGain || 0) !== Number(bc.totalSupportedBossGain || 0)) {
    return Number(bc.totalSupportedBossGain || 0) - Number(ac.totalSupportedBossGain || 0);
  }
  return 0;
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
  memberContributionRerank = false,
  contributionRuns = null,
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

  const baselineState = finalStates[0] || null;
  const normalizedContributionRuns = Math.max(
    1,
    Math.floor(Number(contributionRuns || finalRuns || runs)),
  );
  if (memberContributionRerank) {
    for (const state of finalStates) {
      state.memberContribution = await memberContributionProfile(
        state,
        evaluateTeamAtRuns,
        normalizedContributionRuns,
        requiredCandidate,
      );
    }
    finalStates.sort((a, b) =>
      memberContributionCompare(a, b, objective) ||
      evaluationExpBurden(a.evaluation) - evaluationExpBurden(b.evaluation) ||
      a.team.map(x => x.species).sort().join('|').localeCompare(b.team.map(x => x.species).sort().join('|'))
    );
  }

  const top = finalStates.map(state => ({
    ...searchResultRow(state.team, state.evaluation),
    memberContribution: state.memberContribution || null,
  }));
  const baselineTop = baselineState
    ? {
        ...searchResultRow(baselineState.team, baselineState.evaluation),
        memberContribution: baselineState.memberContribution || null,
      }
    : null;
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
    memberContributionRerank: Boolean(memberContributionRerank),
    contributionRunsPerBoss: memberContributionRerank ? normalizedContributionRuns : null,
    baselineTop,
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
  const memberContributionRerank = arg('member-contribution-rerank', 'false') === 'true';
  const contributionRuns = Number(arg('contribution-runs', String(finalRuns)));
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
      memberContributionRerank,
      contributionRuns,
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
  const memberContributionRerank = arg('member-contribution-rerank', 'false') === 'true';
  const contributionRuns = Number(arg('contribution-runs', String(finalRuns)));

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
    memberContributionRerank,
    contributionRunsPerBoss: memberContributionRerank ? contributionRuns : null,
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
        memberContributionRerank,
        contributionRuns,
      });
      output.versions[version].starters[requiredCandidate.species] = {
        scannedCandidates: result.scannedCandidates,
        screenedCandidates: result.screenedCandidates,
        evaluatedTeams: result.evaluatedTeams,
        baselineTop: result.baselineTop,
        memberContributionRerank: result.memberContributionRerank,
        contributionRunsPerBoss: result.contributionRunsPerBoss,
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
  const bossAwareDepth = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware-depth',
    levelUtility: candidateBossUtility,
  });
  const bossAwareDepthReversed = buildTeamExpSchedule({
    candidates: [...team].reverse(),
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware-depth',
    levelUtility: candidateBossUtility,
  });
  const bossAwareSaturation = buildTeamExpSchedule({
    candidates: team,
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware-saturation',
    levelUtility: candidateBossUtility,
  });
  const bossAwareSaturationReversed = buildTeamExpSchedule({
    candidates: [...team].reverse(),
    routeBosses: route,
    expWorld: expContext.world,
    profile: 'normal-route',
    grindPolicy: 'none',
    allocator: 'boss-aware-saturation',
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

  for (const schedule of [bossAwareSoft, bossAware, bossAwareDepth, bossAwareDepthReversed, bossAwareSaturation, bossAwareSaturationReversed, breakpointAware, breakpointAwareReversed]) {
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
  if (JSON.stringify(bossAwareDepth.finalLevels) !== JSON.stringify(bossAwareDepthReversed.finalLevels)) {
    throw new Error(
      `Boss-aware-depth allocator depends on team order: ${JSON.stringify(bossAwareDepth.finalLevels)} != ${JSON.stringify(bossAwareDepthReversed.finalLevels)}`
    );
  }
  if (JSON.stringify(bossAwareSaturation.finalLevels) !== JSON.stringify(bossAwareSaturationReversed.finalLevels)) {
    throw new Error(
      `Boss-aware-saturation allocator depends on team order: ${JSON.stringify(bossAwareSaturation.finalLevels)} != ${JSON.stringify(bossAwareSaturationReversed.finalLevels)}`
    );
  }

  const breakpointStates = [
    {
      key: 'breakpoint',
      candidate: { species: 'BreakpointMon' },
      growthRate: 'MEDIUM_FAST',
      level: 50,
      exp: expAtLevel('MEDIUM_FAST', 50),
      unknown: false,
    },
    {
      key: 'steady',
      candidate: { species: 'SteadyMon' },
      growthRate: 'MEDIUM_FAST',
      level: 50,
      exp: expAtLevel('MEDIUM_FAST', 50),
      unknown: false,
    },
  ];
  const syntheticUtility = (candidate, _boss, level) => {
    if (candidate.species === 'BreakpointMon') return level >= 52 ? 120 : 8;
    return 8 + (level - 50) * 0.2;
  };
  const syntheticAmount =
    expAtLevel('MEDIUM_FAST', 52) - expAtLevel('MEDIUM_FAST', 50);
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
  if (breakpointStates[0].level < 52 || breakpointStates[1].level !== 50) {
    throw new Error(
      `Breakpoint allocator failed to fund a nearby two-level breakpoint: ${JSON.stringify(breakpointStates)}`
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
    bossAwareDepth: {
      allocator: bossAwareDepth.allocator,
      levelSpread: levelSpread(bossAwareDepth),
      finalLevels: bossAwareDepth.finalLevels,
    },
    bossAwareSaturation: {
      allocator: bossAwareSaturation.allocator,
      levelSpread: levelSpread(bossAwareSaturation),
      finalLevels: bossAwareSaturation.finalLevels,
    },
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
  const noSwitchResult = await runBattle(
    playerTeam,
    enemyTeam,
    7331,
    { p1AiMode: 'no-switch' },
  );
  if (noSwitchResult.p1VoluntarySwitches !== 0) {
    throw new Error(
      `no-switch player policy still switched: ${noSwitchResult.p1VoluntarySwitches}`
    );
  }
  if (result.p2VoluntarySwitches !== 0) {
    throw new Error(`NPC should not voluntarily switch, got ${result.p2VoluntarySwitches}`);
  }
  console.log(JSON.stringify({ greedy: result, noSwitch: noSwitchResult }, null, 2));
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





async function cmdAllocatorDepthCompare() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const runs = Math.max(1, Math.floor(Number(arg('runs', '10'))));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) {
    throw new Error('allocator-depth-compare requires exactly six members via --team=A,B,C,D,E,F');
  }

  const story = await loadStory();
  const [pool, moveAccess, bossAwareContext, depthContext] = await Promise.all([
    loadCanonicalPool(version, story),
    loadMoveAccess(resourceProfile, spendPolicy),
    loadExpContext(
      story, 'normal-route', version, 'none', 'midpoint', 'map-order', 'boss-aware',
    ),
    loadExpContext(
      story, 'normal-route', version, 'none', 'midpoint', 'map-order', 'boss-aware-depth',
    ),
  ]);
  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('allocator-depth-compare requires the selected starter in the team');

  const results = {};
  for (const [label, context] of [
    ['bossAware', bossAwareContext],
    ['depth', depthContext],
  ]) {
    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      context,
      'none',
      objective,
    );
    results[label] = {
      ...compactEvaluationForAblation(evaluation),
      expAllocator: context.expAllocator,
      naturalFinalLevels: evaluation.expSchedule?.finalLevels || {},
      bosses: evaluation.rows.map(row => ({
        boss: row.boss,
        aceLevel: Number(row.aceLevel || 0),
        wins: Number(row.wins || 0),
        losses: Number(row.losses || 0),
        winRate: Number(row.winRate || 0),
        playerLevels: row.playerLevels || {},
      })),
    };
  }

  const beforeByBoss = new Map(results.bossAware.bosses.map(row => [row.boss, row]));
  const bossDeltas = results.depth.bosses.map(row => {
    const before = beforeByBoss.get(row.boss);
    return {
      boss: row.boss,
      baselineWinRate: Number(before?.winRate || 0),
      depthWinRate: Number(row.winRate || 0),
      delta: Number(row.winRate || 0) - Number(before?.winRate || 0),
      baselineLevels: before?.playerLevels || {},
      depthLevels: row.playerLevels || {},
    };
  });

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'experimental roster-depth allocator A/B. It keeps the old boss-aware priority intact and adds only a bounded readiness bonus to the top two ace-level matchup answers for the next boss. No six-way level equalization and no objective change.',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    objective,
    baseline: results.bossAware,
    depth: results.depth,
    deltas: {
      score: results.depth.score - results.bossAware.score,
      geometric: results.depth.storyClearGeometricScore - results.bossAware.storyClearGeometricScore,
      coverage: results.depth.storyClearCoverageScore - results.bossAware.storyClearCoverageScore,
      bottom5: results.depth.bottom5BossWinRate - results.bossAware.bottom5BossWinRate,
      worst: results.depth.worstBossWinRate - results.bossAware.worstBossWinRate,
    },
    bossDeltas,
  }, null, 2));
}

async function cmdAllocatorSaturationCompare() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const runs = Math.max(1, Math.floor(Number(arg('runs', '10'))));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) {
    throw new Error('allocator-saturation-compare requires exactly six members via --team=A,B,C,D,E,F');
  }

  const story = await loadStory();
  const [pool, moveAccess, bossAwareContext, saturationContext] = await Promise.all([
    loadCanonicalPool(version, story),
    loadMoveAccess(resourceProfile, spendPolicy),
    loadExpContext(
      story, 'normal-route', version, 'none', 'midpoint', 'map-order', 'boss-aware',
    ),
    loadExpContext(
      story, 'normal-route', version, 'none', 'midpoint', 'map-order', 'boss-aware-saturation',
    ),
  ]);
  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('allocator-saturation-compare requires the selected starter in the team');

  const results = {};
  for (const [label, context] of [
    ['bossAware', bossAwareContext],
    ['saturation', saturationContext],
  ]) {
    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      context,
      'none',
      objective,
    );
    results[label] = {
      ...compactEvaluationForAblation(evaluation),
      expAllocator: context.expAllocator,
      naturalFinalLevels: evaluation.expSchedule?.finalLevels || {},
      bosses: evaluation.rows.map(row => ({
        boss: row.boss,
        aceLevel: Number(row.aceLevel || 0),
        wins: Number(row.wins || 0),
        losses: Number(row.losses || 0),
        winRate: Number(row.winRate || 0),
        playerLevels: row.playerLevels || {},
      })),
    };
  }

  const beforeByBoss = new Map(results.bossAware.bosses.map(row => [row.boss, row]));
  const bossDeltas = results.saturation.bosses.map(row => {
    const before = beforeByBoss.get(row.boss);
    return {
      boss: row.boss,
      baselineWinRate: Number(before?.winRate || 0),
      saturationWinRate: Number(row.winRate || 0),
      delta: Number(row.winRate || 0) - Number(before?.winRate || 0),
      baselineLevels: before?.playerLevels || {},
      saturationLevels: row.playerLevels || {},
    };
  });

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'experimental anti-overinvestment allocator A/B. Saturation fades the absolute boss-utility reward as a member approaches its own ace-level matchup potential; it does not force equal team levels and does not alter the optimizer objective.',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    objective,
    baseline: results.bossAware,
    saturation: results.saturation,
    deltas: {
      score: results.saturation.score - results.bossAware.score,
      geometric: results.saturation.storyClearGeometricScore - results.bossAware.storyClearGeometricScore,
      coverage: results.saturation.storyClearCoverageScore - results.bossAware.storyClearCoverageScore,
      bottom5: results.saturation.bottom5BossWinRate - results.bossAware.bottom5BossWinRate,
      worst: results.saturation.worstBossWinRate - results.bossAware.worstBossWinRate,
    },
    bossDeltas,
  }, null, 2));
}


function contributionUsageSummary(evaluation) {
  const members = Object.values(evaluation.memberUsage || {});
  const rows = members.map(member => ({
    species: member.species,
    mandatoryStarter: Boolean(member.mandatoryStarter),
    bossesUsedInWins: Number(member.bossesUsedInWins || 0),
    winningMoveUses: Number(member.winningMoveUses || 0),
    winningActiveTurns: Number(member.winningActiveTurns || 0),
    peakWinningUseRate: Number(member.peakWinningUseRate || 0),
    peakWinningActiveTurnsPerRun: Number(member.peakWinningActiveTurnsPerRun || 0),
  }));
  const nonStarter = rows.filter(row => !row.mandatoryStarter);
  const target = nonStarter.length ? nonStarter : rows;
  return {
    members: rows,
    membersWithWinningUse: target.filter(row => row.bossesUsedInWins > 0).length,
    membersWithWinningMoves: target.filter(row => row.winningMoveUses > 0).length,
    membersWithWinningActiveTurns: target.filter(row => row.winningActiveTurns > 0).length,
    minPeakWinningUseRate: target.length
      ? Math.min(...target.map(row => row.peakWinningUseRate))
      : 0,
    minPeakWinningActiveTurnsPerRun: target.length
      ? Math.min(...target.map(row => row.peakWinningActiveTurnsPerRun))
      : 0,
  };
}

function contributionUsageCompare(a, b) {
  const aa = contributionUsageSummary(a);
  const bb = contributionUsageSummary(b);
  if (aa.membersWithWinningMoves !== bb.membersWithWinningMoves) {
    return bb.membersWithWinningMoves - aa.membersWithWinningMoves;
  }
  if (aa.membersWithWinningActiveTurns !== bb.membersWithWinningActiveTurns) {
    return bb.membersWithWinningActiveTurns - aa.membersWithWinningActiveTurns;
  }
  if (aa.membersWithWinningUse !== bb.membersWithWinningUse) {
    return bb.membersWithWinningUse - aa.membersWithWinningUse;
  }
  if (aa.minPeakWinningActiveTurnsPerRun !== bb.minPeakWinningActiveTurnsPerRun) {
    return bb.minPeakWinningActiveTurnsPerRun - aa.minPeakWinningActiveTurnsPerRun;
  }
  if (aa.minPeakWinningUseRate !== bb.minPeakWinningUseRate) {
    return bb.minPeakWinningUseRate - aa.minPeakWinningUseRate;
  }
  return 0;
}

function storyNoRegression(candidate, baseline) {
  if (!candidate || !baseline) return false;
  const epsilon = 1e-12;
  return (
    Number(candidate.storyClearGeometricScore || 0) + epsilon >=
      Number(baseline.storyClearGeometricScore || 0) &&
    Number(candidate.storyClearCoverageScore || 0) + epsilon >=
      Number(baseline.storyClearCoverageScore || 0) &&
    Number(candidate.bottom5BossWinRate || 0) + epsilon >=
      Number(baseline.bottom5BossWinRate || 0) &&
    Number(candidate.worstBossWinRate || 0) + epsilon >=
      Number(baseline.worstBossWinRate || 0) &&
    Number(candidate.score || 0) + epsilon >= Number(baseline.score || 0)
  );
}

function contributionParetoDominates(a, b) {
  const ac = a.contribution || {};
  const bc = b.contribution || {};
  const aCapture = Number(a.evaluation.captureSearch?.expectedEncounters || 0);
  const bCapture = Number(b.evaluation.captureSearch?.expectedEncounters || 0);
  const atLeastAsGood =
    a.evaluation.storyClearGeometricScore >= b.evaluation.storyClearGeometricScore &&
    a.evaluation.storyClearCoverageScore >= b.evaluation.storyClearCoverageScore &&
    Number(ac.meaningfulElectiveCount || 0) >= Number(bc.meaningfulElectiveCount || 0) &&
    Number(ac.weakestSupportedBossGain || 0) >= Number(bc.weakestSupportedBossGain || 0) &&
    aCapture <= bCapture;
  const strictlyBetter =
    a.evaluation.storyClearGeometricScore > b.evaluation.storyClearGeometricScore ||
    a.evaluation.storyClearCoverageScore > b.evaluation.storyClearCoverageScore ||
    Number(ac.meaningfulElectiveCount || 0) > Number(bc.meaningfulElectiveCount || 0) ||
    Number(ac.weakestSupportedBossGain || 0) > Number(bc.weakestSupportedBossGain || 0) ||
    aCapture < bCapture;
  return atLeastAsGood && strictlyBetter;
}

async function cmdMeaningfulSix() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const replaceOnly = String(arg('replace', '')).trim();
  const runs = Number(arg('runs', '1'));
  const finalRuns = Number(arg('final-runs', '20'));
  const candidateCap = Number(arg('candidate-cap', '24'));
  const shortlistCap = Number(arg('shortlist-cap', '24'));
  const finalistCap = Number(arg('finalist-cap', '8'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) {
    throw new Error('meaningful-six requires an existing six-member --team=A,B,C,D,E,F');
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
  const baselineTeam = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(baselineTeam, starterName);
  if (!starter) throw new Error('meaningful-six baseline must contain the selected starter');
  if (!validateCandidateTeam(baselineTeam) || !teamRespectsExclusiveGroups(baselineTeam)) {
    throw new Error('meaningful-six baseline violates team constraints');
  }

  const screenRows = await screenCandidates(
    pool.candidates,
    story,
    moveAccess,
    runs,
    expContext,
    grindPolicy,
    objective,
  );
  const eligibleScreenRows = screenRows.filter(row =>
    row.candidate.exclusiveGroup !== 'starter' ||
    candidateIdentity(row.candidate) === candidateIdentity(starter)
  );
  const screened = selectCandidateScreenRows(eligibleScreenRows, candidateCap, objective)
    .map(row => row.candidate);

  const neighborhood = [];
  const seen = new Set();
  async function addTeam(team, source) {
    const key = team.map(candidateIdentity).sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    );
    neighborhood.push({ team, evaluation, source });
  }

  await addTeam(baselineTeam, 'baseline');
  for (const removed of baselineTeam) {
    if (candidateIdentity(removed) === candidateIdentity(starter)) continue;
    if (replaceOnly && removed.species !== replaceOnly) continue;
    const kept = baselineTeam.filter(mon => candidateIdentity(mon) !== candidateIdentity(removed));
    const existing = new Set(kept.map(candidateIdentity));
    for (const replacement of screened) {
      if (existing.has(candidateIdentity(replacement))) continue;
      if (replacement.exclusiveGroup === 'starter') continue;
      const team = [...kept, replacement];
      if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) continue;
      await addTeam(team, `replace:${removed.species}->${replacement.species}`);
    }
  }

  const storyRanked = [...neighborhood].sort((a, b) =>
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const shortlist = storyRanked.slice(0, Math.max(1, shortlistCap));
  const usageRanked = [...shortlist].sort((a, b) =>
    contributionUsageCompare(a.evaluation, b.evaluation) ||
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );

  const finalists = [];
  const finalistKeys = new Set();
  function addFinalist(state) {
    if (!state || finalists.length >= finalistCap) return;
    const key = stateTieKey(state);
    if (finalistKeys.has(key)) return;
    finalistKeys.add(key);
    finalists.push(state);
  }
  addFinalist(storyRanked.find(state => state.source === 'baseline'));
  const storySlots = Math.max(1, Math.ceil(finalistCap / 2));
  for (const state of storyRanked.slice(0, storySlots)) addFinalist(state);
  for (const state of usageRanked) addFinalist(state);
  for (const state of storyRanked) addFinalist(state);

  const finalEvaluationCache = new Map();
  async function evaluateFinalTeamAtRuns(team, requestedRuns) {
    const key = team.map(candidateIdentity).sort().join('|') +
      `@runs=${requestedRuns}@objective=${objective}`;
    if (!finalEvaluationCache.has(key)) {
      finalEvaluationCache.set(
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
    return finalEvaluationCache.get(key);
  }

  const rescored = [];
  for (const state of finalists) {
    const evaluation = await evaluateFinalTeamAtRuns(state.team, finalRuns);
    const contribution = await memberContributionProfile(
      { team: state.team, evaluation },
      evaluateFinalTeamAtRuns,
      finalRuns,
      starter,
    );
    rescored.push({
      team: state.team,
      source: state.source,
      evaluation,
      contribution,
      usage: contributionUsageSummary(evaluation),
    });
  }

  const baseline = rescored.find(row =>
    row.team.map(candidateIdentity).sort().join('|') ===
      baselineTeam.map(candidateIdentity).sort().join('|')
  ) || null;
  const meaningfulRanked = [...rescored].sort((a, b) =>
    memberContributionCompare(
      { evaluation: a.evaluation, memberContribution: a.contribution },
      { evaluation: b.evaluation, memberContribution: b.contribution },
      objective,
    ) ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );
  const storySafeRanked = baseline
    ? rescored
        .filter(row => storyNoRegression(row.evaluation, baseline.evaluation))
        .sort((a, b) => {
          const ac = a.contribution || {};
          const bc = b.contribution || {};
          if (Number(ac.meaningfulElectiveCount || 0) !== Number(bc.meaningfulElectiveCount || 0)) {
            return Number(bc.meaningfulElectiveCount || 0) - Number(ac.meaningfulElectiveCount || 0);
          }
          if (Number(ac.weakestSupportedBossGain || 0) !== Number(bc.weakestSupportedBossGain || 0)) {
            return Number(bc.weakestSupportedBossGain || 0) - Number(ac.weakestSupportedBossGain || 0);
          }
          const storyOrder = evaluationObjectiveCompare(a.evaluation, b.evaluation, objective);
          if (storyOrder !== 0) return storyOrder;
          const captureOrder =
            Number(a.evaluation.captureSearch?.expectedEncounters || 0) -
            Number(b.evaluation.captureSearch?.expectedEncounters || 0);
          if (captureOrder !== 0) return captureOrder;
          if (Number(ac.totalSupportedBossGain || 0) !== Number(bc.totalSupportedBossGain || 0)) {
            return Number(bc.totalSupportedBossGain || 0) - Number(ac.totalSupportedBossGain || 0);
          }
          return stateTieKey(a).localeCompare(stateTieKey(b));
        })
    : [];
  const recommended = storySafeRanked[0] || baseline || meaningfulRanked[0] || null;
  const pareto = rescored.filter((row, index) =>
    !rescored.some((other, otherIndex) =>
      index !== otherIndex && contributionParetoDominates(other, row)
    )
  ).sort((a, b) =>
    memberContributionCompare(
      { evaluation: a.evaluation, memberContribution: a.contribution },
      { evaluation: b.evaluation, memberContribution: b.contribution },
      objective,
    ) ||
    stateTieKey(a).localeCompare(stateTieKey(b))
  );

  function outputRow(row) {
    if (!row) return null;
    return {
      team: row.team.map(mon => mon.species),
      source: row.source,
      evaluation: compactEvaluationForAblation(row.evaluation),
      usage: row.usage,
      contribution: row.contribution,
    };
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'one-swap contribution-aware refinement of an existing six-member story team; recommendation is restricted to no-regression story candidates, and a member is meaningful only when removing it hurts at least one boss and that member is actually used in winning runs for a helped boss',
    version,
    starter: starter.species,
    baselineTeam: baselineTeam.map(mon => mon.species),
    replaceOnly: replaceOnly || null,
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    runsPerBoss: runs,
    finalRunsPerBoss: finalRuns,
    candidateCap,
    shortlistCap,
    finalistCap,
    screenedCandidates: screened.map(mon => mon.species),
    neighborhoodEvaluated: neighborhood.length,
    finalistsEvaluated: rescored.length,
    baseline: outputRow(baseline),
    meaningfulTop: outputRow(meaningfulRanked[0]),
    recommendedTop: outputRow(recommended),
    storySafeCandidateCount: storySafeRanked.length,
    storySafeCandidates: storySafeRanked.map(outputRow),
    paretoFront: pareto.map(outputRow),
    finalists: meaningfulRanked.map(outputRow),
  }, null, 2));
}


async function cmdTeamActivation() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const targetName = String(arg('target', 'Abra')).trim();
  const targetLevel = Math.max(1, Math.min(100, Math.floor(Number(arg('target-level', '16')))));
  const runs = Number(arg('runs', '20'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) throw new Error('team-activation requires --team=A,B,C,D,E,F');
  if (!Number.isFinite(targetLevel)) throw new Error('Invalid --target-level');

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
  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('team-activation requires the selected starter in the team');
  const target = team.find(mon => mon.species === targetName);
  if (!target) throw new Error(`Activation target not found in team: ${targetName}`);
  if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) {
    throw new Error('team-activation team violates team constraints');
  }

  const baseline = await evaluateCandidates(
    team,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );
  const activatedContext = {
    ...expContext,
    activationTargets: [{ key: candidateIdentity(target), level: targetLevel }],
  };
  const activated = await evaluateCandidates(
    team,
    story.bosses,
    runs,
    moveAccess,
    activatedContext,
    grindPolicy,
    objective,
  );

  const baselineByBoss = new Map((baseline.rows || []).map(row => [row.boss, row]));
  const activatedByBoss = new Map((activated.rows || []).map(row => [row.boss, row]));
  const bossDeltas = [...baselineByBoss.keys()].map(boss => {
    const before = baselineByBoss.get(boss);
    const after = activatedByBoss.get(boss);
    return {
      boss,
      baselineWinRate: Number(before?.winRate || 0),
      activatedWinRate: Number(after?.winRate || 0),
      delta: Number(after?.winRate || 0) - Number(before?.winRate || 0),
      baselineLevels: before?.playerLevels || {},
      activatedLevels: after?.playerLevels || {},
    };
  });
  const targetKey = candidateIdentity(target);

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'fixed-team activation-breakpoint test using the same natural EXP budget; EXP after target acquisition is preferentially invested until the requested level, then the normal allocator resumes',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    target: target.species,
    targetKey,
    targetLevel,
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    baseline: {
      ...compactEvaluationForAblation(baseline),
      naturalFinalLevels: baseline.expSchedule?.finalLevels || null,
      targetUsage: baseline.memberUsage?.[targetKey] || null,
      activation: baseline.expSchedule?.activationTargets || [],
      totalActivationExp: Number(baseline.expSchedule?.totalActivationExp || 0),
    },
    activated: {
      ...compactEvaluationForAblation(activated),
      naturalFinalLevels: activated.expSchedule?.finalLevels || null,
      targetUsage: activated.memberUsage?.[targetKey] || null,
      activation: activated.expSchedule?.activationTargets || [],
      totalActivationExp: Number(activated.expSchedule?.totalActivationExp || 0),
    },
    deltas: {
      score: activated.score - baseline.score,
      geometric: activated.storyClearGeometricScore - baseline.storyClearGeometricScore,
      coverage: activated.storyClearCoverageScore - baseline.storyClearCoverageScore,
      bottom5: activated.bottom5BossWinRate - baseline.bottom5BossWinRate,
      worst: activated.worstBossWinRate - baseline.worstBossWinRate,
    },
    bossDeltas,
  }, null, 2));
}


function compactEvaluationForAblation(evaluation) {
  return {
    score: evaluation.score,
    worstBossWinRate: evaluation.worstBossWinRate,
    bottom5BossWinRate: evaluation.bottom5BossWinRate,
    storyClearGeometricScore: evaluation.storyClearGeometricScore,
    storyClearCoverageScore: evaluation.storyClearCoverageScore,
    finalTeam: evaluation.finalTeam,
    finalLevels: evaluation.finalLevels,
    effectiveResourceProfile: evaluation.effectiveResourceProfile,
    captureExpectedEncounters: evaluation.captureSearch?.expectedEncounters ?? null,
    memberUsage: evaluation.memberUsage,
  };
}

function memberAblationSummary(full, removed, species) {
  const removedByBoss = new Map((removed.rows || []).map(row => [row.boss, row]));
  const bossDeltas = (full.rows || []).map(row => {
    const ablated = removedByBoss.get(row.boss);
    const fullRate = Number(row.winRate || 0);
    const removedRate = Number(ablated?.winRate || 0);
    return {
      boss: row.boss,
      fullWinRate: fullRate,
      withoutWinRate: removedRate,
      delta: fullRate - removedRate,
    };
  });
  const positive = bossDeltas.filter(row => row.delta > 1e-12);
  const negative = bossDeltas.filter(row => row.delta < -1e-12);
  const sortedPositive = [...positive].sort((a, b) => b.delta - a.delta || a.boss.localeCompare(b.boss));
  const sortedNegative = [...negative].sort((a, b) => a.delta - b.delta || a.boss.localeCompare(b.boss));
  return {
    species,
    scoreDelta: full.score - removed.score,
    geometricDelta: full.storyClearGeometricScore - removed.storyClearGeometricScore,
    coverageDelta: full.storyClearCoverageScore - removed.storyClearCoverageScore,
    bottom5Delta: full.bottom5BossWinRate - removed.bottom5BossWinRate,
    worstBossDelta: full.worstBossWinRate - removed.worstBossWinRate,
    bossesHelped: positive.length,
    bossesHurt: negative.length,
    maxBossWinRateGain: sortedPositive[0]?.delta || 0,
    maxBossWinRateLoss: sortedNegative[0]?.delta || 0,
    topHelpedBosses: sortedPositive.slice(0, 8),
    topHurtBosses: sortedNegative.slice(0, 8),
    without: compactEvaluationForAblation(removed),
  };
}

async function cmdTeamAblation() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const runs = Number(arg('runs', '20'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length < 2) throw new Error('team-ablation requires --team=A,B,...');
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
  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('team-ablation requires a starter in the selected team');
  if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) {
    throw new Error('team-ablation team violates team constraints');
  }

  const full = await evaluateCandidates(
    team,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );
  const members = [];
  for (const candidate of team) {
    if (candidateIdentity(candidate) === candidateIdentity(starter)) {
      members.push({
        species: candidate.species,
        mandatoryStarter: true,
        note: 'starter is mandatory for this route and is not ablated',
      });
      continue;
    }
    const reduced = team.filter(mon => candidateIdentity(mon) !== candidateIdentity(candidate));
    const evaluation = await evaluateCandidates(
      reduced,
      story.bosses,
      runs,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    );
    members.push(memberAblationSummary(full, evaluation, candidate.species));
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'member ablation of a fixed six-member story team; EXP and move resources are re-planned after removing each non-starter',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    full: compactEvaluationForAblation(full),
    members,
  }, null, 2));
}


async function cmdTeamUsage() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const runs = Number(arg('runs', '20'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length < 2) throw new Error('team-usage requires --team=A,B,...');
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
  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('team-usage requires the selected starter in the team');
  const evaluation = await evaluateCandidates(
    team,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'actual battle participation instrumentation for a fixed story team',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    score: evaluation.score,
    storyClearGeometricScore: evaluation.storyClearGeometricScore,
    storyClearCoverageScore: evaluation.storyClearCoverageScore,
    finalTeam: evaluation.finalTeam,
    finalLevels: evaluation.finalLevels,
    memberUsage: evaluation.memberUsage,
  }, null, 2));
}


function bossUsageForCandidate(evaluation, candidateKey, bossLabel) {
  const usage = evaluation?.memberUsage?.[candidateKey];
  const row = usage?.bossUsage?.find(item => item.boss === bossLabel);
  if (!row) {
    return {
      runsAvailable: 0,
      runsUsed: 0,
      winningRunsUsed: 0,
      activeTurns: 0,
      winningActiveTurns: 0,
      useRate: 0,
      winningUseRate: 0,
    };
  }
  const available = Number(row.runsAvailable || 0);
  return {
    runsAvailable: available,
    runsUsed: Number(row.runsUsed || 0),
    winningRunsUsed: Number(row.winningRunsUsed || 0),
    activeTurns: Number(row.activeTurns || 0),
    winningActiveTurns: Number(row.winningActiveTurns || 0),
    useRate: available ? Number(row.runsUsed || 0) / available : 0,
    winningUseRate: available ? Number(row.winningRunsUsed || 0) / available : 0,
  };
}

function candidateAceLevelPotential(candidate, boss) {
  if (Number(candidate.availableFrom || 0) > Number(boss.stage || 0)) return null;
  return Number(candidateBossUtility(candidate, boss, Number(boss.aceLevel || 1)) || 0);
}

async function cmdBossInteractionMatrix() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const runs = Number(arg('runs', '20'));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));
  const topPoolPerBoss = Math.max(1, Math.floor(Number(arg('top-pool-per-boss', '12'))));

  if (teamNames.length !== 6) {
    throw new Error('boss-interaction-matrix requires exactly six members via --team=A,B,C,D,E,F');
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

  const team = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(team, starterName);
  if (!starter) throw new Error('boss-interaction-matrix requires the selected starter in the team');
  if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) {
    throw new Error('boss-interaction-matrix team violates team constraints');
  }

  const full = await evaluateCandidates(
    team,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );

  const ablations = new Map();
  for (const candidate of team) {
    const key = candidateIdentity(candidate);
    if (key === candidateIdentity(starter)) continue;
    const reduced = team.filter(mon => candidateIdentity(mon) !== key);
    ablations.set(key, await evaluateCandidates(
      reduced,
      story.bosses,
      runs,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    ));
  }

  const starterKey = candidateIdentity(starter);
  const effectiveMoveAccess = resourceMoveAccessVariants(moveAccess)
    .find(variant => variant.resourceProfile === full.effectiveResourceProfile) || moveAccess;
  const legalPool = pool.candidates.filter(candidate =>
    candidate.exclusiveGroup !== 'starter' || candidateIdentity(candidate) === starterKey
  );

  const candidatePoolMatrix = legalPool.map(candidate => ({
    species: candidate.species,
    key: candidateIdentity(candidate),
    availableFrom: Number(candidate.availableFrom || 0),
    exclusiveGroup: candidate.exclusiveGroup || null,
    captureExpectedEncounters: Number(candidate.captureSearch?.expectedEncounters || 0),
    bossPotential: Object.fromEntries(story.bosses.map(boss => [
      boss.label,
      candidateAceLevelPotential(candidate, boss),
    ])),
  }));

  const bosses = full.rows.map((row, battleIndex) => {
    const boss = story.bosses.find(item => item.label === row.boss);
    if (!boss) return null;
    const levelsBefore = full.expSchedule?.battles?.[battleIndex]?.levelsBefore || {};
    const materializedLoadout = materializeCandidateTeam(
      orderCandidatesForBoss(team, boss, levelsBefore),
      boss.stage,
      boss.aceLevel,
      {
        moveAccess: effectiveMoveAccess,
        singleUsePlan: full.singleUsePlan,
        purchasablePlan: full.purchasablePlan,
        levelsByCandidate: levelsBefore,
      },
    );
    const loadoutByKey = new Map(materializedLoadout.map(mon => [mon._candidateKey, mon]));
    const memberSignals = team.map(candidate => {
      const key = candidateIdentity(candidate);
      const level = Number(levelsBefore[key]);
      const ablated = ablations.get(key);
      const ablatedRow = ablated?.rows?.find(item => item.boss === row.boss);
      const loadout = loadoutByKey.get(key) || null;
      return {
        species: candidate.species,
        materializedSpecies: loadout?.species || null,
        moves: loadout?.moves || [],
        ability: loadout?.ability || null,
        item: loadout?.item || null,
        key,
        mandatoryStarter: key === starterKey,
        available: Number(candidate.availableFrom || 0) <= Number(boss.stage || 0),
        naturalLevel: Number.isFinite(level) ? level : null,
        actualLevelCheapUtility: Number.isFinite(level)
          ? Number(candidateBossUtility(candidate, boss, level) || 0)
          : null,
        aceLevelPotential: candidateAceLevelPotential(candidate, boss),
        usage: bossUsageForCandidate(full, key, row.boss),
        reoptimizedAblationDelta: ablated
          ? Number(row.winRate || 0) - Number(ablatedRow?.winRate || 0)
          : null,
        withoutMemberWinRate: ablated ? Number(ablatedRow?.winRate || 0) : null,
      };
    });

    const availablePool = candidatePoolMatrix
      .map(candidate => ({
        species: candidate.species,
        key: candidate.key,
        availableFrom: candidate.availableFrom,
        exclusiveGroup: candidate.exclusiveGroup,
        captureExpectedEncounters: candidate.captureExpectedEncounters,
        aceLevelPotential: candidate.bossPotential[row.boss],
      }))
      .filter(candidate => candidate.aceLevelPotential !== null)
      .sort((a, b) =>
        Number(b.aceLevelPotential || 0) - Number(a.aceLevelPotential || 0) ||
        a.availableFrom - b.availableFrom ||
        a.species.localeCompare(b.species)
      );

    const positiveMarginalMembers = memberSignals.filter(signal =>
      Number(signal.reoptimizedAblationDelta || 0) > 1e-12
    );
    const winningUsedMembers = memberSignals.filter(signal =>
      Number(signal.usage?.winningRunsUsed || 0) > 0
    );

    return {
      boss: row.boss,
      stage: Number(boss.stage || 0),
      aceLevel: Number(row.aceLevel || boss.aceLevel || 0),
      fullWins: Number(row.wins || 0),
      fullLosses: Number(row.losses || 0),
      fullWinRate: Number(row.winRate || 0),
      observedZero: Number(row.wins || 0) === 0,
      positiveMarginalMemberCount: positiveMarginalMembers.length,
      winningUsedMemberCount: winningUsedMembers.length,
      memberSignals,
      topAvailablePoolByAceLevelPotential: availablePool.slice(0, topPoolPerBoss),
    };
  }).filter(Boolean);

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'diagnostic Boss x Pokemon / team interaction matrix; no optimization rule is changed. Includes the actual materialized species/moves used by the evaluated team at each boss. Ace-level potential is a cheap progression-agnostic proxy; reoptimized ablation includes EXP/resource replanning and is not frozen-state causality.',
    version,
    starter: starter.species,
    team: team.map(mon => mon.species),
    runsPerBoss: runs,
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    full: compactEvaluationForAblation(full),
    bosses,
    candidatePoolMatrix,
  }, null, 2));
}


function weakestElectiveMember(team, starter, evaluation, explicitSpecies = '') {
  const starterKey = candidateIdentity(starter);
  const explicit = explicitSpecies
    ? team.find(candidate =>
        candidateIdentity(candidate) !== starterKey &&
        candidate.species === explicitSpecies
      )
    : null;
  if (explicitSpecies && !explicit) {
    throw new Error(`Replacement target not found or is mandatory starter: ${explicitSpecies}`);
  }

  const ranked = team
    .filter(candidate => candidateIdentity(candidate) !== starterKey)
    .map(candidate => {
      const key = candidateIdentity(candidate);
      const usage = evaluation?.memberUsage?.[key] || {};
      const finalLevel = Number(
        evaluation?.expSchedule?.finalLevels?.[key] ??
        evaluation?.finalLevels?.[candidate.species] ??
        0
      );
      return {
        candidate,
        key,
        bossesUsedInWins: Number(usage.bossesUsedInWins || 0),
        winningMoveUses: Number(usage.winningMoveUses || 0),
        winningActiveTurns: Number(usage.winningActiveTurns || 0),
        peakWinningUseRate: Number(usage.peakWinningUseRate || 0),
        peakWinningActiveTurnsPerRun: Number(usage.peakWinningActiveTurnsPerRun || 0),
        finalLevel: Number.isFinite(finalLevel) ? finalLevel : 0,
      };
    })
    .sort((a, b) =>
      a.bossesUsedInWins - b.bossesUsedInWins ||
      a.winningMoveUses - b.winningMoveUses ||
      a.winningActiveTurns - b.winningActiveTurns ||
      a.peakWinningUseRate - b.peakWinningUseRate ||
      a.peakWinningActiveTurnsPerRun - b.peakWinningActiveTurnsPerRun ||
      a.finalLevel - b.finalLevel ||
      a.candidate.species.localeCompare(b.candidate.species)
    );

  return explicit
    ? ranked.find(row => candidateIdentity(row.candidate) === candidateIdentity(explicit))
    : ranked[0];
}

function counterfactualCandidatePool({
  pool,
  baselineTeam,
  starter,
  bosses,
  topPerBoss,
  candidateCap,
  explicitCandidates,
}) {
  const starterKey = candidateIdentity(starter);
  const existing = new Set(baselineTeam.map(candidateIdentity));
  const legal = pool.candidates.filter(candidate => {
    const key = candidateIdentity(candidate);
    if (existing.has(key)) return false;
    if (candidate.exclusiveGroup === 'starter' && key !== starterKey) return false;
    return true;
  });

  if (explicitCandidates.length) {
    const wanted = new Set(explicitCandidates);
    return legal
      .filter(candidate => wanted.has(candidate.species))
      .slice(0, candidateCap);
  }

  const selected = new Map();
  for (const boss of bosses) {
    const ranked = legal
      .map(candidate => ({
        candidate,
        potential: candidateAceLevelPotential(candidate, boss),
      }))
      .filter(row => row.potential !== null)
      .sort((a, b) =>
        Number(b.potential || 0) - Number(a.potential || 0) ||
        Number(a.candidate.availableFrom || 0) - Number(b.candidate.availableFrom || 0) ||
        a.candidate.species.localeCompare(b.candidate.species)
      )
      .slice(0, topPerBoss);

    ranked.forEach((row, index) => {
      const key = candidateIdentity(row.candidate);
      const current = selected.get(key) || {
        candidate: row.candidate,
        topBossCount: 0,
        reciprocalRank: 0,
        potentialSum: 0,
        bossPotential: {},
      };
      current.topBossCount += 1;
      current.reciprocalRank += 1 / (index + 1);
      current.potentialSum += Number(row.potential || 0);
      current.bossPotential[boss.label] = Number(row.potential || 0);
      selected.set(key, current);
    });
  }

  return [...selected.values()]
    .sort((a, b) =>
      b.topBossCount - a.topBossCount ||
      b.reciprocalRank - a.reciprocalRank ||
      b.potentialSum - a.potentialSum ||
      a.candidate.species.localeCompare(b.candidate.species)
    )
    .slice(0, candidateCap)
    .map(row => row.candidate);
}

function bossLevelAndLoadout(evaluation, team, candidate, boss, story, moveAccess) {
  // evaluation.rows follows the actually materialized route. story.bosses can contain
  // version/route entries omitted from that route, so indexing expSchedule with the
  // global story index can drift (most visibly for Kanto bosses).
  const battleIndex = (evaluation?.rows || []).findIndex(row => row.boss === boss.label);
  const levelsBefore = battleIndex >= 0
    ? evaluation?.expSchedule?.battles?.[battleIndex]?.levelsBefore || {}
    : {};
  const key = candidateIdentity(candidate);
  const level = Number(levelsBefore[key]);
  const effectiveMoveAccess = resourceMoveAccessVariants(moveAccess)
    .find(variant => variant.resourceProfile === evaluation.effectiveResourceProfile) || moveAccess;
  const materialized = materializeCandidateTeam(
    orderCandidatesForBoss(team, boss, levelsBefore),
    boss.stage,
    boss.aceLevel,
    {
      moveAccess: effectiveMoveAccess,
      singleUsePlan: evaluation.singleUsePlan,
      purchasablePlan: evaluation.purchasablePlan,
      levelsByCandidate: levelsBefore,
    },
  );
  const mon = materialized.find(item => item._candidateKey === key) || null;
  return {
    naturalLevel: Number.isFinite(level) ? level : null,
    materializedSpecies: mon?.species || null,
    moves: mon?.moves || [],
    ability: mon?.ability || null,
    item: mon?.item || null,
  };
}

async function cmdCounterfactualSpecialistProbe() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const replaceOnly = String(arg('replace', '')).trim();
  const targetBossNames = String(arg('targets', 'Clair,Lance,Misty,Blue,Red'))
    .split(',').map(value => value.trim()).filter(Boolean);
  const explicitCandidates = String(arg('candidates', ''))
    .split(',').map(value => value.trim()).filter(Boolean);
  const runs = Math.max(1, Math.floor(Number(arg('runs', '10'))));
  const topPerBoss = Math.max(1, Math.floor(Number(arg('top-per-boss', '3'))));
  const candidateCap = Math.max(1, Math.floor(Number(arg('candidate-cap', '10'))));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) {
    throw new Error('counterfactual-specialist-probe requires exactly six members via --team=A,B,C,D,E,F');
  }

  const story = await loadStory();
  const targetBosses = targetBossNames.map(name => {
    const boss = story.bosses.find(item => item.label === name);
    if (!boss) throw new Error(`Unknown target boss: ${name}`);
    return boss;
  });
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

  const baselineTeam = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(baselineTeam, starterName);
  if (!starter) throw new Error('counterfactual-specialist-probe requires the selected starter in the team');
  if (!validateCandidateTeam(baselineTeam) || !teamRespectsExclusiveGroups(baselineTeam)) {
    throw new Error('counterfactual-specialist-probe baseline team violates team constraints');
  }

  const baseline = await evaluateCandidates(
    baselineTeam,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );
  const weak = weakestElectiveMember(baselineTeam, starter, baseline, replaceOnly);
  if (!weak) throw new Error('No elective member is available for replacement');

  const kept = baselineTeam.filter(mon => candidateIdentity(mon) !== weak.key);
  const candidates = counterfactualCandidatePool({
    pool,
    baselineTeam,
    starter,
    bosses: targetBosses,
    topPerBoss,
    candidateCap,
    explicitCandidates,
  });

  const baselineRows = new Map((baseline.rows || []).map(row => [row.boss, row]));
  const probes = [];
  for (const replacement of candidates) {
    const team = [...kept, replacement];
    if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) continue;

    const evaluation = await evaluateCandidates(
      team,
      story.bosses,
      runs,
      moveAccess,
      expContext,
      grindPolicy,
      objective,
    );
    const replacementRows = new Map((evaluation.rows || []).map(row => [row.boss, row]));
    const targets = targetBosses.map(boss => {
      const before = baselineRows.get(boss.label);
      const after = replacementRows.get(boss.label);
      const baselineWinRate = Number(before?.winRate || 0);
      const replacementWinRate = Number(after?.winRate || 0);
      return {
        boss: boss.label,
        aceLevel: Number(boss.aceLevel || 0),
        baselineWins: Number(before?.wins || 0),
        replacementWins: Number(after?.wins || 0),
        baselineWinRate,
        replacementWinRate,
        delta: replacementWinRate - baselineWinRate,
        revivedObservedZero: Number(before?.wins || 0) === 0 && Number(after?.wins || 0) > 0,
        replacement: {
          ...bossLevelAndLoadout(
            evaluation,
            team,
            replacement,
            boss,
            story,
            moveAccess,
          ),
          usage: bossUsageForCandidate(
            evaluation,
            candidateIdentity(replacement),
            boss.label,
          ),
        },
      };
    });

    const revived = targets.filter(row => row.revivedObservedZero);
    const improved = targets.filter(row => row.delta > 1e-12);
    const regressed = targets.filter(row => row.delta < -1e-12);
    probes.push({
      replacement,
      team,
      evaluation,
      summary: {
        replacement: replacement.species,
        team: team.map(mon => mon.species),
        proxyPotential: Object.fromEntries(targetBosses.map(boss => [
          boss.label,
          candidateAceLevelPotential(replacement, boss),
        ])),
        revivedObservedZeroCount: revived.length,
        revivedObservedZeroBosses: revived.map(row => row.boss),
        improvedTargetCount: improved.length,
        regressedTargetCount: regressed.length,
        targetDeltaSum: targets.reduce((sum, row) => sum + row.delta, 0),
        maxTargetGain: Math.max(0, ...targets.map(row => row.delta)),
        scoreDelta: Number(evaluation.score || 0) - Number(baseline.score || 0),
        geometricDelta:
          Number(evaluation.storyClearGeometricScore || 0) -
          Number(baseline.storyClearGeometricScore || 0),
        coverageDelta:
          Number(evaluation.storyClearCoverageScore || 0) -
          Number(baseline.storyClearCoverageScore || 0),
        bottom5Delta:
          Number(evaluation.bottom5BossWinRate || 0) -
          Number(baseline.bottom5BossWinRate || 0),
        targets,
      },
    });
  }

  probes.sort((a, b) =>
    b.summary.revivedObservedZeroCount - a.summary.revivedObservedZeroCount ||
    b.summary.improvedTargetCount - a.summary.improvedTargetCount ||
    b.summary.targetDeltaSum - a.summary.targetDeltaSum ||
    b.summary.maxTargetGain - a.summary.maxTargetGain ||
    evaluationObjectiveCompare(a.evaluation, b.evaluation, objective) ||
    a.replacement.species.localeCompare(b.replacement.species)
  );

  const best = probes[0] || null;
  const baselineTargets = targetBosses.map(boss => {
    const row = baselineRows.get(boss.label);
    return {
      boss: boss.label,
      wins: Number(row?.wins || 0),
      losses: Number(row?.losses || 0),
      winRate: Number(row?.winRate || 0),
      observedZero: Number(row?.wins || 0) === 0,
    };
  });

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'bridge diagnostic: replace one weak/dead elective slot with hard-boss specialist candidates and re-plan the same natural route EXP/resource budget. This does not change the optimizer or objective.',
    version,
    starter: starter.species,
    baselineTeam: baselineTeam.map(mon => mon.species),
    runsPerBoss: runs,
    targetBosses: targetBosses.map(boss => boss.label),
    replaceOnly: replaceOnly || null,
    selectedWeakSlot: {
      species: weak.candidate.species,
      key: weak.key,
      bossesUsedInWins: weak.bossesUsedInWins,
      winningMoveUses: weak.winningMoveUses,
      winningActiveTurns: weak.winningActiveTurns,
      peakWinningUseRate: weak.peakWinningUseRate,
      peakWinningActiveTurnsPerRun: weak.peakWinningActiveTurnsPerRun,
      finalLevel: weak.finalLevel,
    },
    resourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    topPerBoss,
    candidateCap,
    explicitCandidates,
    screenedCandidates: candidates.map(candidate => candidate.species),
    baseline: {
      ...compactEvaluationForAblation(baseline),
      targets: baselineTargets,
    },
    bestProbe: best?.summary || null,
    probes: probes.map(row => row.summary),
  }, null, 2));
}


function matchupUsageForCandidate(result, candidateKey) {
  const usage = result?.p1Usage?.[candidateKey] || null;
  if (!usage) {
    return {
      runsAvailable: Number(result?.runs || 0),
      runsUsed: 0,
      winningRunsUsed: 0,
      appearances: 0,
      leadStarts: 0,
      moveUses: 0,
      activeTurns: 0,
      faints: 0,
      winningMoveUses: 0,
      winningActiveTurns: 0,
      useRate: 0,
      winningUseRate: 0,
    };
  }
  const available = Number(usage.runsAvailable || result?.runs || 0);
  const used = Number(usage.runsUsed || 0);
  const winningUsed = Number(usage.winningRunsUsed || 0);
  return {
    runsAvailable: available,
    runsUsed: used,
    winningRunsUsed: winningUsed,
    appearances: Number(usage.appearances || 0),
    leadStarts: Number(usage.leadStarts || 0),
    moveUses: Number(usage.moveUses || 0),
    activeTurns: Number(usage.activeTurns || 0),
    faints: Number(usage.faints || 0),
    winningMoveUses: Number(usage.winningMoveUses || 0),
    winningActiveTurns: Number(usage.winningActiveTurns || 0),
    useRate: available ? used / available : 0,
    winningUseRate: available ? winningUsed / available : 0,
  };
}

function compactFixedBattleResult(result, playerTeam, candidateKey = null) {
  return {
    wins: Number(result?.wins || 0),
    losses: Number(result?.losses || 0),
    ties: Number(result?.ties || 0),
    runs: Number(result?.runs || 0),
    winRate: Number(result?.winRate || 0),
    averageTurns: Number(result?.averageTurns || 0),
    playerLead: playerTeam?.[0]?.species || null,
    playerTeam: (playerTeam || []).map(mon => ({
      key: mon._candidateKey || mon.species,
      species: mon.species,
      level: Number(mon.level || 0),
      moves: mon.moves || [],
      ability: mon.ability || null,
      item: mon.item || null,
    })),
    candidateUsage: candidateKey
      ? matchupUsageForCandidate(result, candidateKey)
      : null,
  };
}

function localOracleDiagnosis(baselineFixed, probes) {
  const baselineWins = Number(baselineFixed?.wins || 0);
  if (baselineWins > 0) {
    return {
      classification: 'baseline-positive',
      rationale: 'The fixed baseline reproduced at least one win; this target is not an observed hard zero in the local rerun.',
    };
  }

  const snapshotDirect = probes.filter(row =>
    Number(row.snapshot?.wins || 0) > 0 &&
    Number(row.snapshot?.candidateUsage?.winningRunsUsed || 0) > 0
  );
  const aceDirect = probes.filter(row =>
    Number(row.aceOracle?.wins || 0) > 0 &&
    Number(row.aceOracle?.candidateUsage?.winningRunsUsed || 0) > 0
  );
  const snapshotAny = probes.filter(row => Number(row.snapshot?.wins || 0) > 0);
  const aceAny = probes.filter(row => Number(row.aceOracle?.wins || 0) > 0);

  if (snapshotDirect.length) {
    return {
      classification: 'composition-or-candidate-screening',
      rationale: 'At least one specialist wins at the frozen slot-level budget and is actually used in a winning run.',
      directSnapshotSolvers: snapshotDirect.map(row => row.candidate),
    };
  }
  if (aceDirect.length) {
    return {
      classification: 'progression-or-exp-allocation',
      rationale: 'No direct slot-level solver exists, but at least one ace-level specialist directly wins. The matchup is solvable if progression can reach that power.',
      directAceOnlySolvers: aceDirect.map(row => row.candidate),
    };
  }
  if (snapshotAny.length || aceAny.length) {
    return {
      classification: 'indirect-composition-or-battle-order-effect',
      rationale: 'A replacement changes the outcome without the replacement itself appearing in a winning run. This is a fixed-state composition/order effect, not direct specialist evidence.',
      snapshotIndirectSolvers: snapshotAny.map(row => row.candidate),
      aceIndirectSolvers: aceAny.map(row => row.candidate),
    };
  }
  return {
    classification: 'matchup-or-battle-policy-under-screened-oracle',
    rationale: 'No screened replacement wins even at the boss ace level with the baseline state frozen. This points away from pure progression shortage for the screened pool.',
  };
}

async function cmdBossLocalOracleProbe() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const replaceOnly = String(arg('replace', '')).trim();
  const targetBossNames = String(arg('targets', 'Clair,Lance,Misty,Blue,Red'))
    .split(',').map(value => value.trim()).filter(Boolean);
  const explicitCandidates = String(arg('candidates', ''))
    .split(',').map(value => value.trim()).filter(Boolean);
  const runs = Math.max(1, Math.floor(Number(arg('runs', '10'))));
  const topPerBoss = Math.max(1, Math.floor(Number(arg('top-per-boss', '8'))));
  const candidateCap = Math.max(1, Math.floor(Number(arg('candidate-cap', '10'))));
  const resourceProfile = normalizeResourceProfile(arg('resources', 'all'));
  const spendPolicy = normalizeSpendPolicy(arg('spend-policy', 'natural'));
  const expProfile = normalizeExpProfile(arg('exp-profile', 'normal-route'));
  const grindPolicy = normalizeGrindPolicy(arg('grind-policy', 'none'));
  const entryLevelPolicy = normalizeEntryLevelPolicy(arg('entry-level', 'midpoint'));
  const sameStageJoinPolicy = normalizeSameStageJoinPolicy(arg('same-stage-join', 'map-order'));
  const expAllocator = normalizeExpAllocator(arg('exp-allocator', 'boss-aware'));
  const objective = normalizeSearchObjective(arg('objective', 'story-clear'));

  if (teamNames.length !== 6) {
    throw new Error('boss-local-oracle-probe requires exactly six members via --team=A,B,C,D,E,F');
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

  const baselineTeam = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(baselineTeam, starterName);
  if (!starter) throw new Error('boss-local-oracle-probe requires the selected starter in the team');
  if (!validateCandidateTeam(baselineTeam) || !teamRespectsExclusiveGroups(baselineTeam)) {
    throw new Error('boss-local-oracle-probe baseline team violates team constraints');
  }

  const baseline = await evaluateCandidates(
    baselineTeam,
    story.bosses,
    runs,
    moveAccess,
    expContext,
    grindPolicy,
    objective,
  );
  if (!baseline.expSchedule) {
    throw new Error('boss-local-oracle-probe requires a non-ace EXP profile with a route snapshot');
  }

  const weak = weakestElectiveMember(baselineTeam, starter, baseline, replaceOnly);
  if (!weak) throw new Error('No elective member is available for replacement');
  const kept = baselineTeam.filter(mon => candidateIdentity(mon) !== weak.key);

  const effectiveMoveAccess = resourceMoveAccessVariants(moveAccess)
    .find(variant => variant.resourceProfile === baseline.effectiveResourceProfile) || moveAccess;

  const bosses = [];
  for (const bossName of targetBossNames) {
    const battleIndex = (baseline.rows || []).findIndex(row => row.boss === bossName);
    if (battleIndex < 0) {
      bosses.push({
        boss: bossName,
        skipped: true,
        reason: 'target boss is not present in the starter-specific evaluated route',
      });
      continue;
    }

    const boss = story.bosses.find(item => item.label === bossName);
    if (!boss) throw new Error('Unknown target boss: ' + bossName);
    const routeRow = baseline.rows[battleIndex];
    const levelsBefore = {
      ...(baseline.expSchedule?.battles?.[battleIndex]?.levelsBefore || {}),
    };

    const baselineOrdered = orderCandidatesForBoss(baselineTeam, boss, levelsBefore);
    const baselinePlayerTeam = materializeCandidateTeam(
      baselineOrdered,
      boss.stage,
      boss.aceLevel,
      {
        moveAccess: effectiveMoveAccess,
        singleUsePlan: baseline.singleUsePlan,
        purchasablePlan: baseline.purchasablePlan,
        levelsByCandidate: levelsBefore,
      },
    );
    const weakMaterialized = baselinePlayerTeam.find(mon => mon._candidateKey === weak.key) || null;
    const slotLevelRaw = Number(
      weakMaterialized?.level ??
      levelsBefore[weak.key]
    );
    const slotLevel = Number.isFinite(slotLevelRaw) ? slotLevelRaw : null;

    const enemyTeam = hgssTrainerToShowdownTeam(boss.trainer, boss);
    const seed = 1000 + Number(boss.stage || 0) * 100000 + battleIndex * 1000;
    const fixedBaselineResult = await simulateMatchup(
      baselinePlayerTeam,
      enemyTeam,
      runs,
      seed,
      { p2Trainer: boss },
    );
    const fixedBaseline = compactFixedBattleResult(
      fixedBaselineResult,
      baselinePlayerTeam,
      weak.key,
    );

    const candidates = counterfactualCandidatePool({
      pool,
      baselineTeam,
      starter,
      bosses: [boss],
      topPerBoss,
      candidateCap,
      explicitCandidates,
    });

    const probes = [];
    for (const replacement of candidates) {
      const replacementKey = candidateIdentity(replacement);
      if (Number(replacement.availableFrom || 0) > Number(boss.stage || 0)) continue;
      if (slotLevel === null) continue;

      const entryMinRaw = Number(replacement.entryLevelMin);
      const entryMin = Number.isFinite(entryMinRaw) ? entryMinRaw : 1;
      const snapshotLevel = Math.max(slotLevel, entryMin);
      const modes = [
        { label: 'snapshot', forcedLevel: snapshotLevel },
        { label: 'aceOracle', forcedLevel: Number(boss.aceLevel || snapshotLevel) },
      ];
      const local = {
        candidate: replacement.species,
        key: replacementKey,
        availableFrom: Number(replacement.availableFrom || 0),
        proxyPotential: candidateAceLevelPotential(replacement, boss),
        slotLevel,
        entryLevelMin: Number.isFinite(entryMinRaw) ? entryMinRaw : null,
      };

      for (const mode of modes) {
        const frozenLevels = { ...levelsBefore };
        delete frozenLevels[weak.key];
        frozenLevels[replacementKey] = mode.forcedLevel;
        const team = [...kept, replacement];
        const ordered = orderCandidatesForBoss(team, boss, frozenLevels);
        const playerTeam = materializeCandidateTeam(
          ordered,
          boss.stage,
          boss.aceLevel,
          {
            moveAccess: effectiveMoveAccess,
            singleUsePlan: baseline.singleUsePlan,
            purchasablePlan: baseline.purchasablePlan,
            levelsByCandidate: frozenLevels,
          },
        );
        const materializedReplacement = playerTeam.find(mon => mon._candidateKey === replacementKey) || null;
        if (!materializedReplacement) {
          local[mode.label] = {
            forcedLevel: mode.forcedLevel,
            skipped: true,
            reason: 'replacement did not materialize at this boss',
          };
          continue;
        }
        const result = await simulateMatchup(
          playerTeam,
          enemyTeam,
          runs,
          seed,
          { p2Trainer: boss },
        );
        local[mode.label] = {
          forcedLevel: mode.forcedLevel,
          materializedSpecies: materializedReplacement.species,
          moves: materializedReplacement.moves || [],
          ability: materializedReplacement.ability || null,
          item: materializedReplacement.item || null,
          ...compactFixedBattleResult(result, playerTeam, replacementKey),
        };
      }
      probes.push(local);
    }

    probes.sort((a, b) =>
      Number(b.aceOracle?.candidateUsage?.winningRunsUsed || 0) -
        Number(a.aceOracle?.candidateUsage?.winningRunsUsed || 0) ||
      Number(b.aceOracle?.winRate || 0) - Number(a.aceOracle?.winRate || 0) ||
      Number(b.snapshot?.candidateUsage?.winningRunsUsed || 0) -
        Number(a.snapshot?.candidateUsage?.winningRunsUsed || 0) ||
      Number(b.snapshot?.winRate || 0) - Number(a.snapshot?.winRate || 0) ||
      Number(b.proxyPotential || 0) - Number(a.proxyPotential || 0) ||
      a.candidate.localeCompare(b.candidate)
    );

    bosses.push({
      boss: boss.label,
      stage: Number(boss.stage || 0),
      aceLevel: Number(boss.aceLevel || 0),
      routeBattleIndex: battleIndex,
      seed,
      routeBaseline: {
        wins: Number(routeRow?.wins || 0),
        losses: Number(routeRow?.losses || 0),
        ties: Number(routeRow?.ties || 0),
        winRate: Number(routeRow?.winRate || 0),
        playerLevels: routeRow?.playerLevels || {},
        playerLead: routeRow?.playerLead || null,
      },
      fixedBaseline,
      baselineReproductionMatches:
        Number(routeRow?.wins || 0) === Number(fixedBaselineResult?.wins || 0) &&
        Number(routeRow?.losses || 0) === Number(fixedBaselineResult?.losses || 0) &&
        Number(routeRow?.ties || 0) === Number(fixedBaselineResult?.ties || 0),
      replacedSlot: {
        species: weak.candidate.species,
        key: weak.key,
        slotLevel,
        materializedSpecies: weakMaterialized?.species || null,
        moves: weakMaterialized?.moves || [],
      },
      screenedCandidates: candidates.map(candidate => candidate.species),
      diagnosis: localOracleDiagnosis(fixedBaseline, probes),
      probes,
    });
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'boss-local fixed-state/oracle diagnostic. Baseline route progression, resource ownership, and all non-replaced member levels are frozen. Only one elective slot is replaced for the target battle. snapshot uses the frozen slot level (raised only to the candidate minimum encounter level if necessary); aceOracle forces only the replacement to the boss ace level. The optimizer/objective/route allocator are not changed.',
    version,
    starter: starter.species,
    baselineTeam: baselineTeam.map(mon => mon.species),
    runsPerBoss: runs,
    targetBosses: targetBossNames,
    selectedWeakSlot: {
      species: weak.candidate.species,
      key: weak.key,
      bossesUsedInWins: weak.bossesUsedInWins,
      winningMoveUses: weak.winningMoveUses,
      winningActiveTurns: weak.winningActiveTurns,
      finalLevel: weak.finalLevel,
    },
    resourceProfile,
    effectiveResourceProfile: baseline.effectiveResourceProfile,
    spendPolicy,
    expProfile,
    grindPolicy,
    entryLevelPolicy,
    sameStageJoinPolicy,
    expAllocator,
    objective,
    topPerBoss,
    candidateCap,
    explicitCandidates,
    frozenResourcePolicy: 'reuse baseline single-use and purchasable ownership exactly; replacement receives no resource re-planning',
    baseline: compactEvaluationForAblation(baseline),
    bosses,
  }, null, 2));
}



function localOraclePlans(team, boss, levelsByCandidate, moveAccess) {
  const levelsByBattle = [levelsByCandidate];
  const singleUsePlan = planSingleUseMachines(
    team,
    [boss],
    moveAccess,
    { levelsByBattle },
  );
  const purchasable = planPurchasableMachines(
    team,
    [boss],
    moveAccess,
    singleUsePlan,
    { levelsByBattle },
  );
  return {
    singleUsePlan,
    purchasablePlan: purchasable.assignments,
    purchaseCosts: purchasable.costs,
  };
}

async function cmdBossLocalResourcePolicyProbe() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const teamNames = String(arg('team', '')).split(',').map(value => value.trim()).filter(Boolean);
  const targetBossNames = String(arg('targets', 'Lance,Red'))
    .split(',').map(value => value.trim()).filter(Boolean);
  const explicitCandidates = String(arg('candidates', ''))
    .split(',').map(value => value.trim()).filter(Boolean);
  const runs = Math.max(1, Math.floor(Number(arg('runs', '10'))));
  const topPerBoss = Math.max(1, Math.floor(Number(arg('top-per-boss', '8'))));
  const candidateCap = Math.max(1, Math.floor(Number(arg('candidate-cap', '10'))));

  if (teamNames.length !== 6) {
    throw new Error('boss-local-resource-policy-probe requires exactly six members via --team=A,B,C,D,E,F');
  }

  const story = await loadStory();
  const [pool, requestedMoveAccess, expContext] = await Promise.all([
    loadCanonicalPool(version, story),
    loadMoveAccess('all', 'natural'),
    loadExpContext(
      story, 'normal-route', version, 'none', 'midpoint', 'map-order', 'boss-aware',
    ),
  ]);
  const baselineTeam = selectByNames(pool.candidates, teamNames);
  const starter = findStarterCandidate(baselineTeam, starterName);
  if (!starter) throw new Error('boss-local-resource-policy-probe requires the selected starter in the team');

  const baseline = await evaluateCandidates(
    baselineTeam,
    story.bosses,
    runs,
    requestedMoveAccess,
    expContext,
    'none',
    'story-clear',
  );
  const weak = weakestElectiveMember(baselineTeam, starter, baseline, '');
  if (!weak) throw new Error('No elective member is available for replacement');
  const kept = baselineTeam.filter(mon => candidateIdentity(mon) !== weak.key);
  const frozenMoveAccess = resourceMoveAccessVariants(requestedMoveAccess)
    .find(variant => variant.resourceProfile === baseline.effectiveResourceProfile) || requestedMoveAccess;
  const unlockedMoveAccess = resourceMoveAccessVariants(requestedMoveAccess)
    .find(variant => variant.resourceProfile === 'all') || requestedMoveAccess;

  const bosses = [];
  for (const bossName of targetBossNames) {
    const battleIndex = (baseline.rows || []).findIndex(row => row.boss === bossName);
    const boss = story.bosses.find(item => item.label === bossName);
    if (battleIndex < 0 || !boss) {
      bosses.push({ boss: bossName, skipped: true, reason: 'boss not in evaluated route' });
      continue;
    }

    const levelsBefore = {
      ...(baseline.expSchedule?.battles?.[battleIndex]?.levelsBefore || {}),
    };
    const seed = 1000 + Number(boss.stage || 0) * 100000 + battleIndex * 1000;
    const enemyTeam = hgssTrainerToShowdownTeam(boss.trainer, boss);
    const candidates = counterfactualCandidatePool({
      pool,
      baselineTeam,
      starter,
      bosses: [boss],
      topPerBoss,
      candidateCap,
      explicitCandidates,
    });

    const probes = [];
    for (const replacement of candidates) {
      if (Number(replacement.availableFrom || 0) > Number(boss.stage || 0)) continue;
      const replacementKey = candidateIdentity(replacement);
      const team = [...kept, replacement];
      if (!validateCandidateTeam(team) || !teamRespectsExclusiveGroups(team)) continue;

      const frozenLevels = { ...levelsBefore };
      delete frozenLevels[weak.key];
      frozenLevels[replacementKey] = Number(boss.aceLevel || 1);

      async function evaluateMode(label, moveAccess, singleUsePlan, purchasablePlan, p1AiMode) {
        const ordered = orderCandidatesForBoss(team, boss, frozenLevels);
        const playerTeam = materializeCandidateTeam(
          ordered,
          boss.stage,
          boss.aceLevel,
          { moveAccess, singleUsePlan, purchasablePlan, levelsByCandidate: frozenLevels },
        );
        const replacementMon = playerTeam.find(mon => mon._candidateKey === replacementKey) || null;
        if (!replacementMon) {
          return { label, skipped: true, reason: 'replacement did not materialize' };
        }
        const result = await simulateMatchup(
          playerTeam,
          enemyTeam,
          runs,
          seed,
          { p2Trainer: boss, p1AiMode },
        );
        return {
          label,
          p1AiMode,
          replacement: {
            species: replacementMon.species,
            level: replacementMon.level,
            moves: replacementMon.moves || [],
            ability: replacementMon.ability || null,
            item: replacementMon.item || null,
          },
          ...compactFixedBattleResult(result, playerTeam, replacementKey),
        };
      }

      const frozenGreedy = await evaluateMode(
        'frozen-resource-greedy',
        frozenMoveAccess,
        baseline.singleUsePlan,
        baseline.purchasablePlan,
        'greedy',
      );

      const localPlans = localOraclePlans(team, boss, frozenLevels, unlockedMoveAccess);
      const unlockedGreedy = await evaluateMode(
        'unlocked-resource-greedy',
        unlockedMoveAccess,
        localPlans.singleUsePlan,
        localPlans.purchasablePlan,
        'greedy',
      );
      const unlockedAggressive = await evaluateMode(
        'unlocked-resource-aggressive',
        unlockedMoveAccess,
        localPlans.singleUsePlan,
        localPlans.purchasablePlan,
        'aggressive',
      );
      const unlockedNoSwitch = await evaluateMode(
        'unlocked-resource-no-switch',
        unlockedMoveAccess,
        localPlans.singleUsePlan,
        localPlans.purchasablePlan,
        'no-switch',
      );

      const rosterAceLevels = {};
      for (const candidate of team) {
        const key = candidateIdentity(candidate);
        const current = Number(frozenLevels[key] || 0);
        rosterAceLevels[key] = Math.max(current, Number(boss.aceLevel || 1));
      }
      const rosterAcePlans = localOraclePlans(team, boss, rosterAceLevels, unlockedMoveAccess);

      async function evaluateRosterAceMode(label, p1AiMode) {
        const ordered = orderCandidatesForBoss(team, boss, rosterAceLevels);
        const playerTeam = materializeCandidateTeam(
          ordered,
          boss.stage,
          boss.aceLevel,
          {
            moveAccess: unlockedMoveAccess,
            singleUsePlan: rosterAcePlans.singleUsePlan,
            purchasablePlan: rosterAcePlans.purchasablePlan,
            levelsByCandidate: rosterAceLevels,
          },
        );
        const result = await simulateMatchup(
          playerTeam,
          enemyTeam,
          runs,
          seed,
          { p2Trainer: boss, p1AiMode },
        );
        return {
          label,
          p1AiMode,
          ...compactFixedBattleResult(result, playerTeam, replacementKey),
        };
      }

      const rosterAceGreedy = await evaluateRosterAceMode(
        'roster-ace-unlocked-greedy',
        'greedy',
      );
      const rosterAceNoSwitch = await evaluateRosterAceMode(
        'roster-ace-unlocked-no-switch',
        'no-switch',
      );
      const rosterAceAggressive = await evaluateRosterAceMode(
        'roster-ace-unlocked-aggressive',
        'aggressive',
      );

      let classification = 'still-unsolved';
      if (Number(frozenGreedy.wins || 0) > 0) classification = 'level-only-solver';
      else if (Number(unlockedGreedy.wins || 0) > 0) classification = 'resource-loadout-sensitive';
      else if (
        Number(unlockedAggressive.wins || 0) > 0 ||
        Number(unlockedNoSwitch.wins || 0) > 0
      ) classification = 'player-policy-sensitive';
      else if (Number(rosterAceGreedy.wins || 0) > 0) {
        classification = 'global-progression-ceiling';
      } else if (
        Number(rosterAceNoSwitch.wins || 0) > 0 ||
        Number(rosterAceAggressive.wins || 0) > 0
      ) {
        classification = 'global-progression-plus-policy';
      }

      probes.push({
        candidate: replacement.species,
        key: replacementKey,
        proxyPotential: candidateAceLevelPotential(replacement, boss),
        localPurchaseCosts: localPlans.purchaseCosts,
        classification,
        frozenGreedy,
        unlockedGreedy,
        unlockedAggressive,
        unlockedNoSwitch,
        rosterAceGreedy,
        rosterAceNoSwitch,
        rosterAceAggressive,
      });
    }

    probes.sort((a, b) => {
      const bestRate = row => Math.max(
        Number(row.frozenGreedy?.winRate || 0),
        Number(row.unlockedGreedy?.winRate || 0),
        Number(row.unlockedAggressive?.winRate || 0),
        Number(row.unlockedNoSwitch?.winRate || 0),
        Number(row.rosterAceGreedy?.winRate || 0),
        Number(row.rosterAceNoSwitch?.winRate || 0),
        Number(row.rosterAceAggressive?.winRate || 0),
      );
      return bestRate(b) - bestRate(a) ||
        Number(b.proxyPotential || 0) - Number(a.proxyPotential || 0) ||
        a.candidate.localeCompare(b.candidate);
    });

    bosses.push({
      boss: boss.label,
      aceLevel: Number(boss.aceLevel || 0),
      replacedSlot: {
        species: weak.candidate.species,
        key: weak.key,
        naturalLevel: Number(levelsBefore[weak.key] || 0),
      },
      screenedCandidates: candidates.map(candidate => candidate.species),
      anyFrozenSolver: probes.some(row => Number(row.frozenGreedy?.wins || 0) > 0),
      anyResourceSolver: probes.some(row => Number(row.unlockedGreedy?.wins || 0) > 0),
      anyPolicySolver: probes.some(row =>
        Number(row.unlockedAggressive?.wins || 0) > 0 ||
        Number(row.unlockedNoSwitch?.wins || 0) > 0
      ),
      anyRosterAceSolver: probes.some(row =>
        Number(row.rosterAceGreedy?.wins || 0) > 0 ||
        Number(row.rosterAceNoSwitch?.wins || 0) > 0 ||
        Number(row.rosterAceAggressive?.wins || 0) > 0
      ),
      probes,
    });
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'last-cause diagnostic for hard bosses. Freeze route levels, force the replacement to boss ace level, then compare baseline resource ownership against a boss-local all-resource replan and simple player switching-policy variants. A second upper bound raises every team member to at least the boss ace level. Diagnostic only; no optimizer rule changes.',
    version,
    starter: starter.species,
    baselineTeam: baselineTeam.map(mon => mon.species),
    selectedWeakSlot: weak.candidate.species,
    runsPerMode: runs,
    resourceOracle: 'boss-local single-use/purchasable TM ownership is replanned from the full all-resource pool without route-history or natural-money limits',
    playerPolicies: {
      greedy: 'current player policy',
      aggressive: 'same move scorer, but lower switch threshold, shorter cooldown, and higher switch cap',
      noSwitch: 'same move scorer with voluntary switching disabled',
    },
    bosses,
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


function redCaptureChoice(form, commonLevel) {
  const level = Math.max(1, Math.min(100, Math.floor(Number(commonLevel || 1))));
  const options = (form.redCaptureOptions || [])
    .filter(option =>
      level >= Number(option.evolutionMinLevel || 1) &&
      level >= Number(option.minLevel || 1)
    )
    .map(option => {
      const captureLevel = Math.min(level, Number(option.maxLevel || option.minLevel || 1));
      return {
        ...option,
        captureLevel,
      };
    })
    .filter(option => option.captureLevel >= Number(option.minLevel || 1))
    .sort((a, b) =>
      Number(b.captureLevel) - Number(a.captureLevel) ||
      Number(a.evolutionMinLevel || 1) - Number(b.evolutionMinLevel || 1) ||
      Number(a.expectedEncounters ?? Infinity) - Number(b.expectedEncounters ?? Infinity) ||
      String(a.captureSpecies).localeCompare(String(b.captureSpecies))
    );
  return options[0] || null;
}

function redFormLevelRow(form, red, commonLevel) {
  const capture = redCaptureChoice(form, commonLevel);
  if (!capture) return null;
  const targetExp = expAtLevel(form.growthRate, commonLevel);
  const captureExp = expAtLevel(form.growthRate, capture.captureLevel);
  if (targetExp === null || captureExp === null) return null;
  return {
    form,
    familyId: form.familyId,
    species: form.species,
    commonLevel,
    capture,
    grindExp: Math.max(0, targetExp - captureExp),
    proxyUtility: Math.max(0, Number(candidateBossUtility(form, red, commonLevel) || 0)),
  };
}

function redFamilyParetoRows(rows) {
  const byFamily = new Map();
  for (const row of rows) {
    const bucket = byFamily.get(row.familyId) || [];
    bucket.push(row);
    byFamily.set(row.familyId, bucket);
  }
  const out = [];
  for (const bucket of byFamily.values()) {
    for (const row of bucket) {
      const dominated = bucket.some(other =>
        other !== row &&
        Number(other.proxyUtility) >= Number(row.proxyUtility) &&
        Number(other.grindExp) <= Number(row.grindExp) &&
        (
          Number(other.proxyUtility) > Number(row.proxyUtility) ||
          Number(other.grindExp) < Number(row.grindExp)
        )
      );
      if (!dominated) out.push(row);
    }
  }
  return out;
}

function redTeamKey(rows, level) {
  return level + ':' + rows
    .map(row => row.familyId + '/' + row.species)
    .sort()
    .join('|');
}

function redBeamTeams(starterRows, candidateRows, level, beamWidth = 120) {
  const lambdas = [0, 0.15, 0.35, 0.7, 1.5, 3.0];
  const candidatePool = [...candidateRows].sort((a, b) =>
    Number(b.proxyUtility) - Number(a.proxyUtility) ||
    Number(a.grindExp) - Number(b.grindExp) ||
    a.familyId.localeCompare(b.familyId) ||
    a.species.localeCompare(b.species)
  );

  function keepDiverse(states) {
    const chosen = new Map();
    const perView = Math.max(4, Math.ceil(beamWidth / (lambdas.length + 2)));
    const views = [
      [...states].sort((a, b) =>
        Number(b.proxyUtility) - Number(a.proxyUtility) ||
        Number(a.totalExp) - Number(b.totalExp)
      ),
      [...states].sort((a, b) =>
        Number(a.totalExp) - Number(b.totalExp) ||
        Number(b.proxyUtility) - Number(a.proxyUtility)
      ),
      ...lambdas.map(lambda => [...states].sort((a, b) => {
        const aScore = Number(a.proxyUtility) - lambda * (Number(a.totalExp) / 1_000_000);
        const bScore = Number(b.proxyUtility) - lambda * (Number(b.totalExp) / 1_000_000);
        return bScore - aScore ||
          Number(a.totalExp) - Number(b.totalExp);
      })),
    ];
    for (const view of views) {
      for (const state of view.slice(0, perView)) {
        const key = redTeamKey(state.members, level);
        if (!chosen.has(key)) chosen.set(key, state);
      }
    }
    return [...chosen.values()].slice(0, beamWidth);
  }

  const finals = [];
  for (const starterRow of starterRows) {
    let states = [{
      members: [starterRow],
      families: new Set([starterRow.familyId]),
      proxyUtility: Number(starterRow.proxyUtility),
      totalExp: Number(starterRow.grindExp),
      lastIndex: -1,
    }];

    while (states.length && states[0].members.length < 6) {
      const expanded = [];
      for (const state of states) {
        for (let index = state.lastIndex + 1; index < candidatePool.length; index += 1) {
          const row = candidatePool[index];
          if (state.families.has(row.familyId)) continue;
          expanded.push({
            members: [...state.members, row],
            families: new Set([...state.families, row.familyId]),
            proxyUtility: state.proxyUtility + Number(row.proxyUtility),
            totalExp: state.totalExp + Number(row.grindExp),
            lastIndex: index,
          });
        }
      }
      states = keepDiverse(expanded);
    }
    finals.push(...states.filter(state => state.members.length === 6));
  }

  const unique = new Map();
  for (const state of keepDiverse(finals)) {
    unique.set(redTeamKey(state.members, level), state);
  }
  return [...unique.values()];
}

function redSearchCandidatePool(levelRows, starterFamily, candidateCap = 42) {
  const nonStarter = levelRows.filter(row => row.familyId !== starterFamily);
  const selected = new Map();
  function add(rows) {
    for (const row of rows) selected.set(row.familyId + '/' + row.species, row);
  }

  add([...nonStarter]
    .sort((a, b) =>
      Number(b.proxyUtility) - Number(a.proxyUtility) ||
      Number(a.grindExp) - Number(b.grindExp)
    )
    .slice(0, candidateCap));
  add([...nonStarter]
    .sort((a, b) => {
      const ae = Number(a.proxyUtility) / (1 + Number(a.grindExp) / 100000);
      const be = Number(b.proxyUtility) / (1 + Number(b.grindExp) / 100000);
      return be - ae || Number(a.grindExp) - Number(b.grindExp);
    })
    .slice(0, candidateCap));
  const useful = nonStarter.filter(row => Number(row.proxyUtility) > 0);
  add([...useful]
    .sort((a, b) =>
      Number(a.grindExp) - Number(b.grindExp) ||
      Number(b.proxyUtility) - Number(a.proxyUtility)
    )
    .slice(0, Math.max(12, Math.floor(candidateCap / 2))));

  return [...selected.values()]
    .sort((a, b) =>
      Number(b.proxyUtility) - Number(a.proxyUtility) ||
      Number(a.grindExp) - Number(b.grindExp)
    )
    .slice(0, Math.max(candidateCap, Math.floor(candidateCap * 1.75)));
}

async function redEvaluateTeam(state, red, enemyTeam, moveAccess, runs, seedBase) {
  const commonLevel = Number(state.members[0]?.commonLevel || 1);
  const forms = state.members.map(row => row.form);
  const levels = Object.fromEntries(forms.map(form => [candidateIdentity(form), commonLevel]));
  const ordered = orderCandidatesForBoss(forms, red, levels);
  let playerTeam = materializeCandidateTeam(
    ordered,
    red.stage,
    commonLevel,
    {
      moveAccess,
      levelsByCandidate: levels,
    },
  );

  const extraMachines = [
    ...(moveAccess.singleUseMachines || []),
    ...(moveAccess.purchasableMachines || []),
  ].filter(machine => Number(machine.availableFrom || 0) <= Number(red.stage || 0));

  playerTeam = playerTeam.map(mon => ({
    ...mon,
    moves: selectCandidateMoves(
      mon.species,
      commonLevel,
      red.stage,
      moveAccess,
      extraMachines,
    ),
  }));

  const battle = await simulateMatchup(
    playerTeam,
    enemyTeam,
    runs,
    seedBase,
    { p2Trainer: red, p1AiMode: 'greedy' },
  );
  return {
    key: redTeamKey(state.members, commonLevel),
    commonLevel,
    totalGrindExp: Number(state.totalExp),
    proxyUtility: Number(state.proxyUtility),
    wins: Number(battle.wins || 0),
    losses: Number(battle.losses || 0),
    ties: Number(battle.ties || 0),
    winRate: Number(battle.winRate || 0),
    averageTurns: Number(battle.averageTurns || 0),
    team: state.members.map(row => ({
      familyId: row.familyId,
      species: row.species,
      growthRate: row.form.growthRate,
      captureSpecies: row.capture.captureSpecies,
      captureLevel: Number(row.capture.captureLevel),
      captureSource: {
        type: row.capture.type,
        map: row.capture.map,
        method: row.capture.method,
      },
      evolutionMinLevel: Number(row.capture.evolutionMinLevel || 1),
      grindExp: Number(row.grindExp),
      proxyUtility: Number(row.proxyUtility),
    })),
    battleTeam: playerTeam.map(mon => ({
      species: mon.species,
      level: Number(mon.level),
      moves: mon.moves || [],
      ability: mon.ability || null,
      item: mon.item || null,
    })),
  };
}

async function cmdRedMinGrindSearch() {
  const version = String(arg('version', 'HEARTGOLD')).toUpperCase();
  const starterName = String(arg('starter', 'Cyndaquil'));
  const levelMin = Math.max(1, Math.min(100, Math.floor(Number(arg('level-min', '45')))));
  const levelMax = Math.max(levelMin, Math.min(100, Math.floor(Number(arg('level-max', '95')))));
  const candidateCap = Math.max(12, Math.floor(Number(arg('candidate-cap', '42'))));
  const beamWidth = Math.max(20, Math.floor(Number(arg('beam-width', '120'))));
  const screenCap = Math.max(20, Math.floor(Number(arg('screen-cap', '120'))));
  const screenRuns = Math.max(1, Math.floor(Number(arg('screen-runs', '5'))));
  const finalistCap = Math.max(4, Math.floor(Number(arg('finalist-cap', '24'))));
  const finalRuns = Math.max(screenRuns, Math.floor(Number(arg('final-runs', '50'))));
  const targetWinRate = Math.max(0.05, Math.min(1, Number(arg('target-win-rate', '0.5'))));

  if (!['Chikorita', 'Cyndaquil', 'Totodile'].includes(starterName)) {
    throw new Error('starter must be Chikorita, Cyndaquil, or Totodile');
  }

  const story = await loadStory();
  const red = story.bosses.find(boss => boss.label === 'Red');
  if (!red) throw new Error('Red boss definition not found');
  const access = await readJson('config/story-access.canonical.json');
  const [redPool, moveAccess] = await Promise.all([
    buildRedOnlyCandidateForms({
      commit: story.config.sourceCommit,
      bosses: story.bosses,
      access,
      version,
      targetBossLabel: 'Red',
      excludeLegendary: true,
    }),
    loadMoveAccess('all', 'unbounded'),
  ]);
  const enemyTeam = hgssTrainerToShowdownTeam(red.trainer, red);

  const proxyPairs = [];
  const levelSummaries = [];
  for (let commonLevel = levelMin; commonLevel <= levelMax; commonLevel += 1) {
    const levelRows = redFamilyParetoRows(
      redPool.forms
        .map(form => redFormLevelRow(form, red, commonLevel))
        .filter(Boolean)
    );
    const starterRows = levelRows
      .filter(row =>
        row.familyId === starterName &&
        (row.form.redCaptureOptions || []).some(option => option.type === 'starter')
      )
      .sort((a, b) =>
        Number(b.proxyUtility) - Number(a.proxyUtility) ||
        Number(a.grindExp) - Number(b.grindExp)
      )
      .slice(0, 3);
    if (!starterRows.length) continue;

    const candidates = redSearchCandidatePool(levelRows, starterName, candidateCap);
    const teams = redBeamTeams(starterRows, candidates, commonLevel, beamWidth)
      .sort((a, b) =>
        Number(a.totalExp) - Number(b.totalExp) ||
        Number(b.proxyUtility) - Number(a.proxyUtility)
      );

    levelSummaries.push({
      commonLevel,
      feasibleForms: levelRows.length,
      candidateForms: candidates.length,
      generatedTeams: teams.length,
      cheapestProxyTeamExp: teams[0]?.totalExp ?? null,
      strongestProxy: teams.reduce((best, row) => Math.max(best, Number(row.proxyUtility)), 0),
    });
    proxyPairs.push(...teams.map(state => ({ ...state, commonLevel })));
  }

  const byKey = new Map();
  for (const state of proxyPairs) {
    const key = redTeamKey(state.members, state.commonLevel);
    const prior = byKey.get(key);
    if (!prior || Number(state.proxyUtility) > Number(prior.proxyUtility)) byKey.set(key, state);
  }
  const uniquePairs = [...byKey.values()];

  const candidatesForScreen = new Map();
  const costSorted = [...uniquePairs].sort((a, b) =>
    Number(a.totalExp) - Number(b.totalExp) ||
    Number(b.proxyUtility) - Number(a.proxyUtility)
  );
  let bestProxySeen = -Infinity;
  for (const state of costSorted) {
    if (Number(state.proxyUtility) > bestProxySeen + 1e-12) {
      candidatesForScreen.set(redTeamKey(state.members, state.commonLevel), state);
      bestProxySeen = Number(state.proxyUtility);
    }
  }
  for (const state of [...uniquePairs]
    .sort((a, b) =>
      Number(b.proxyUtility) - Number(a.proxyUtility) ||
      Number(a.totalExp) - Number(b.totalExp)
    )
    .slice(0, Math.floor(screenCap / 3))) {
    candidatesForScreen.set(redTeamKey(state.members, state.commonLevel), state);
  }
  for (const state of [...uniquePairs]
    .sort((a, b) => {
      const ae = Number(a.proxyUtility) / (1 + Number(a.totalExp) / 1_000_000);
      const be = Number(b.proxyUtility) / (1 + Number(b.totalExp) / 1_000_000);
      return be - ae || Number(a.totalExp) - Number(b.totalExp);
    })
    .slice(0, Math.floor(screenCap / 3))) {
    candidatesForScreen.set(redTeamKey(state.members, state.commonLevel), state);
  }

  // Preserve strength candidates across the full level range. A final
  // cheapest-first truncation would otherwise remove all high-level teams
  // before the real simulator gets a chance to test them.
  const perLevel = new Map();
  for (const state of uniquePairs) {
    const bucket = perLevel.get(Number(state.commonLevel)) || [];
    bucket.push(state);
    perLevel.set(Number(state.commonLevel), bucket);
  }
  const screenSelected = new Map();
  function addScreenState(state) {
    if (!state || screenSelected.size >= screenCap) return;
    screenSelected.set(redTeamKey(state.members, state.commonLevel), state);
  }

  for (const level of [...perLevel.keys()].sort((a, b) => a - b)) {
    const bucket = perLevel.get(level) || [];
    addScreenState([...bucket].sort((a, b) =>
      Number(b.proxyUtility) - Number(a.proxyUtility) ||
      Number(a.totalExp) - Number(b.totalExp)
    )[0]);
  }
  for (const level of [...perLevel.keys()].sort((a, b) => a - b)) {
    if (screenSelected.size >= screenCap) break;
    const bucket = perLevel.get(level) || [];
    addScreenState([...bucket].sort((a, b) => {
      const ae = Number(a.proxyUtility) / (1 + Number(a.totalExp) / 1_000_000);
      const be = Number(b.proxyUtility) / (1 + Number(b.totalExp) / 1_000_000);
      return be - ae || Number(a.totalExp) - Number(b.totalExp);
    })[0]);
  }
  for (const state of [...candidatesForScreen.values()]
    .sort((a, b) =>
      Number(b.proxyUtility) - Number(a.proxyUtility) ||
      Number(a.totalExp) - Number(b.totalExp)
    )) {
    if (screenSelected.size >= screenCap) break;
    addScreenState(state);
  }
  for (const state of costSorted) {
    if (screenSelected.size >= screenCap) break;
    addScreenState(state);
  }

  const screenStates = [...screenSelected.values()];

  const screened = [];
  for (const state of screenStates) {
    screened.push(await redEvaluateTeam(
      state,
      red,
      enemyTeam,
      moveAccess,
      screenRuns,
      770001,
    ));
  }

  const finalists = new Map();
  const screenThresholdWins = Math.max(1, Math.ceil(targetWinRate * screenRuns));
  for (const row of [...screened]
    .filter(row => row.wins >= Math.max(1, screenThresholdWins - 1))
    .sort((a, b) =>
      Number(a.totalGrindExp) - Number(b.totalGrindExp) ||
      Number(b.winRate) - Number(a.winRate)
    )
    .slice(0, finalistCap)) {
    finalists.set(row.key, row);
  }
  for (const row of [...screened]
    .sort((a, b) =>
      Number(b.winRate) - Number(a.winRate) ||
      Number(a.totalGrindExp) - Number(b.totalGrindExp)
    )
    .slice(0, Math.max(6, Math.floor(finalistCap / 2)))) {
    finalists.set(row.key, row);
  }

  const finalRows = [];
  for (const screenedRow of finalists.values()) {
    const state = byKey.get(screenedRow.key);
    if (!state) continue;
    finalRows.push(await redEvaluateTeam(
      state,
      red,
      enemyTeam,
      moveAccess,
      finalRuns,
      880001,
    ));
  }
  finalRows.sort((a, b) =>
    Number(a.totalGrindExp) - Number(b.totalGrindExp) ||
    Number(b.winRate) - Number(a.winRate)
  );

  const targets = [0.5, 0.7, 0.9];
  const bestByTarget = Object.fromEntries(targets.map(target => {
    const feasible = finalRows
      .filter(row => Number(row.winRate) + 1e-12 >= target)
      .sort((a, b) =>
        Number(a.totalGrindExp) - Number(b.totalGrindExp) ||
        Number(a.commonLevel) - Number(b.commonLevel) ||
        Number(b.winRate) - Number(a.winRate)
      );
    return [String(target), feasible[0] || null];
  }));

  console.log(JSON.stringify({
    schemaVersion: 1,
    purpose: 'Red-only minimum-grind team search. All six members use one common level; objective cost is the sum of EXP required from the best source-backed capture level at or below that common level to the common level. Story route, other bosses, and route EXP allocation are intentionally ignored.',
    version,
    starter: starterName,
    targetBoss: 'Red',
    targetBossAceLevel: Number(red.aceLevel || 0),
    assumptions: {
      legendaryAndMythical: 'excluded',
      captureLevel: 'highest source-backed legal capture level at or below the requested common level, using all sources available by Red',
      evolutions: 'level thresholds enforced; trade/stone/friendship/other non-level evolutions treated as feasible without extra EXP',
      commonLevel: 'all six battle members have exactly the same level',
      tmPolicy: 'all Red-stage legal TM/HM/tutor/shop moves may be selected independently for each member; route ownership and money are ignored',
      heldItems: 'no player held-item optimization; existing simulator defaults are used',
      battlePolicy: 'current greedy player policy versus source-guided Red trainer AI',
    },
    search: {
      levelMin,
      levelMax,
      candidateCap,
      beamWidth,
      generatedProxyPairs: uniquePairs.length,
      screenCap,
      screenedTeams: screened.length,
      screenedLevelMin: screened.length ? Math.min(...screened.map(row => Number(row.commonLevel))) : null,
      screenedLevelMax: screened.length ? Math.max(...screened.map(row => Number(row.commonLevel))) : null,
      screenRuns,
      targetWinRate,
      finalistCap,
      finalTeams: finalRows.length,
      finalRuns,
    },
    pool: {
      formCount: redPool.forms.length,
      familyCount: redPool.familyCount,
      notes: redPool.notes,
    },
    levelSummaries,
    bestByTarget,
    finalResults: finalRows.slice(0, 20),
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
  'allocator-depth-compare': cmdAllocatorDepthCompare,
  'allocator-saturation-compare': cmdAllocatorSaturationCompare,
  'team-ablation': cmdTeamAblation,
  'team-usage': cmdTeamUsage,
  'team-activation': cmdTeamActivation,
  'boss-interaction-matrix': cmdBossInteractionMatrix,
  'counterfactual-specialist-probe': cmdCounterfactualSpecialistProbe,
  'boss-local-oracle-probe': cmdBossLocalOracleProbe,
  'boss-local-resource-policy-probe': cmdBossLocalResourcePolicyProbe,
  'red-min-grind-search': cmdRedMinGrindSearch,
  'meaningful-six': cmdMeaningfulSix,
  'trainer-ai-compare': cmdTrainerAiCompare,
  'tutor-smoke': cmdTutorSmoke,
  'hm-smoke': cmdHmSmoke,
  'tm-smoke': cmdTmSmoke,
  'shop-tm-smoke': cmdShopTmSmoke,
  smoke: cmdSmoke,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Use one of: smoke, resource-budget-smoke, resource-monotonic-smoke, move-score-smoke, resource-smoke, route-smoke, exp-envelope, exp-envelope-smoke, exp-budget, exp-budget-smoke, exp-segment-smoke, exp-allocator-smoke, team-order-smoke, objective-smoke, capture-smoke, exp-route-smoke, exp-smoke, switch-smoke, trainer-ai-smoke, allocator-cross-compare, allocator-depth-compare, allocator-saturation-compare, team-ablation, team-usage, team-activation, boss-interaction-matrix, counterfactual-specialist-probe, boss-local-oracle-probe, boss-local-resource-policy-probe, red-min-grind-search, meaningful-six, tutor-smoke, hm-smoke, tm-smoke, shop-tm-smoke, extract, pool, validate, simulate, search, convergence, optimize');
  process.exitCode = 2;
} else {
  await commands[command]();
}
