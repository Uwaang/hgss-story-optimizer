import { fetchText } from './hgss-data.mjs';

const PRET_RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';
const PRET_API_ROOT = 'https://api.github.com/repos/pret/pokeheartgold';

const SLOT_WEIGHTS = {
  land: [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1],
  surf: [60, 30, 5, 4, 1],
  old_rod: [40, 30, 15, 10, 5],
  good_rod: [40, 30, 15, 10, 5],
  super_rod: [40, 30, 15, 10, 5],
  rock_smash: [80, 20],
};

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function speciesConstant(name) {
  return String(name || '').startsWith('SPECIES_') ? String(name) : `SPECIES_${name}`;
}

export function expAtLevel(growthRate, level) {
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

export function levelAtExp(growthRate, exp) {
  const value = Math.max(0, Number(exp || 0));
  let level = 1;
  for (let candidate = 2; candidate <= 100; candidate += 1) {
    const threshold = expAtLevel(growthRate, candidate);
    if (threshold === null || threshold > value) break;
    level = candidate;
  }
  return level;
}

function resolveVersioned(value, version) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('HEARTGOLD' in value || 'SOULSILVER' in value) return resolveVersioned(value[version], version);
    if ('gold' in value || 'silver' in value) {
      return resolveVersioned(value[version === 'HEARTGOLD' ? 'gold' : 'silver'], version);
    }
  }
  return value;
}

function speciesValues(value, version) {
  const resolved = resolveVersioned(value, version);
  if (Array.isArray(resolved)) return resolved.flatMap(item => speciesValues(item, version));
  if (typeof resolved === 'string') return [speciesConstant(resolved)];
  if (resolved && typeof resolved === 'object') {
    return Object.values(resolved).flatMap(item => speciesValues(item, version));
  }
  return [];
}

function levelRange(value, version) {
  const resolved = resolveVersioned(value, version);
  if (Number.isFinite(Number(resolved))) {
    const level = Number(resolved);
    return { min: level, max: level };
  }
  if (resolved && typeof resolved === 'object') {
    const min = Number(resolveVersioned(resolved.min, version));
    const max = Number(resolveVersioned(resolved.max, version));
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }
  return { min: null, max: null };
}

function averageWildExpForSlot(slot, version, expYieldBySpecies) {
  const species = speciesValues(slot?.species, version);
  const range = levelRange(slot?.level, version);
  if (!species.length || range.min === null || range.max === null) return 0;

  const lo = Math.min(range.min, range.max);
  const hi = Math.max(range.min, range.max);
  let sum = 0;
  let count = 0;
  for (const speciesConst of species) {
    const yieldValue = Number(expYieldBySpecies.get(speciesConst));
    if (!Number.isFinite(yieldValue)) continue;
    for (let level = lo; level <= hi; level += 1) {
      sum += Math.floor((yieldValue * level) / 7);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function encounterMethodSlots(encounter, method) {
  if (method === 'land') return { slots: encounter.land?.mons || [], rate: encounter.land?.rate || 0 };
  if (method === 'surf') return { slots: encounter.surf?.mons || [], rate: encounter.surf?.rate || 0 };
  if (method === 'rock_smash') {
    return { slots: encounter.rock_smash?.mons || [], rate: encounter.rock_smash?.rate || 0 };
  }
  const rod = encounter.fishing?.[method];
  if (rod) return { slots: rod.mons || [], rate: rod.rate || 0 };
  return { slots: [], rate: 0 };
}

function expectedWildExp(encounter, method, version, expYieldBySpecies) {
  const weights = SLOT_WEIGHTS[method];
  if (!weights) return null;
  const { slots, rate } = encounterMethodSlots(encounter, method);
  if (!slots.length) return null;

  let expectedExpPerBattle = 0;
  for (let i = 0; i < Math.min(slots.length, weights.length); i += 1) {
    expectedExpPerBattle += averageWildExpForSlot(slots[i], version, expYieldBySpecies) * weights[i] / 100;
  }
  return {
    method,
    expectedExpPerBattle,
    encounterRate: Number(rate || 0),
    expectedExpPer100Checks: expectedExpPerBattle * Number(rate || 0),
  };
}

function buildBestWildByStage(encounterJson, access, version, expYieldBySpecies) {
  const byMap = new Map((encounterJson.encounters || []).map(row => [row.map, row]));
  const cumulativeMaps = new Set();
  const result = new Map();

  for (const stageDef of access?.stages || []) {
    const stage = Number(stageDef.stage);
    for (const map of stageDef.addMaps || []) cumulativeMaps.add(map);

    const options = [];
    for (const map of cumulativeMaps) {
      const encounter = byMap.get(map);
      if (!encounter) continue;
      for (const [method, unlockStage] of Object.entries(access.methodUnlockStage || {})) {
        if (!(method in SLOT_WEIGHTS) || stage < Number(unlockStage)) continue;
        const expected = expectedWildExp(encounter, method, version, expYieldBySpecies);
        if (expected && expected.expectedExpPerBattle > 0) options.push({ map, ...expected });
      }
    }

    options.sort((a, b) =>
      b.expectedExpPerBattle - a.expectedExpPerBattle ||
      b.expectedExpPer100Checks - a.expectedExpPer100Checks ||
      a.map.localeCompare(b.map)
    );
    result.set(stage, {
      stage,
      best: options[0] || null,
      top: options.slice(0, 10),
    });
  }
  return result;
}

export function trainerBattleExp(trainer, expYieldBySpecies) {
  let total = 0;
  const details = [];
  for (const mon of trainer?.party || []) {
    const species = speciesConstant(mon.species);
    const yieldValue = Number(expYieldBySpecies.get(species));
    if (!Number.isFinite(yieldValue)) {
      throw new Error(`Missing EXP yield for ${species}`);
    }
    const base = Math.floor((yieldValue * Number(mon.level)) / 7);
    const trainerExp = Math.floor((base * 150) / 100);
    total += trainerExp;
    details.push({
      species,
      level: Number(mon.level),
      expYield: yieldValue,
      baseExp: base,
      trainerExp,
    });
  }
  return { total, details };
}

function collectTrainerRefs(value, out = new Map()) {
  if (typeof value === 'string') {
    const regex = /std_trainer(_2)?\((TRAINER_[A-Z0-9_]+)\)/g;
    for (const match of value.matchAll(regex)) {
      const key = match[2];
      const existing = out.get(key) || { key, isDouble: false };
      if (match[1]) existing.isDouble = true;
      out.set(key, existing);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTrainerRefs(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectTrainerRefs(item, out);
  }
  return out;
}

function parsePrizeMoneyTable(text) {
  const result = new Map();
  const start = text.indexOf('sPrizeMoneyTbl:');
  if (start < 0) return result;
  const block = text.slice(start, text.indexOf('.public sBattleScriptCommandTable', start));
  const row = /\.short\s+(TRAINERCLASS_[A-Z0-9_]+),\s*(\d+)/g;
  for (const match of block.matchAll(row)) {
    result.set(match[1], Number(match[2]));
  }
  return result;
}

export function trainerPrizeMoney(trainer, prizeMultiplierByClass, isDouble = false) {
  const party = trainer?.party || [];
  if (!party.length) return 0;
  const lastLevel = Number(party[party.length - 1].level || 0);
  const multiplier = Number(prizeMultiplierByClass.get(trainer.class) || 0);
  const doubleMultiplier = isDouble ? 2 : 1;
  return lastLevel * 4 * multiplier * doubleMultiplier;
}

async function loadZoneEventPaths(commit) {
  const tree = await fetchJson(`${PRET_API_ROOT}/git/trees/${commit}?recursive=1`);
  const byMap = new Map();
  for (const entry of tree.tree || []) {
    const match = String(entry.path || '').match(
      /^files\/fielddata\/eventdata\/zone_event\/\d+_([A-Z0-9]+)\.json$/
    );
    if (match) byMap.set(match[1], entry.path);
  }
  return byMap;
}

function earliestMapStages(access) {
  const result = new Map();
  for (const stageDef of access?.stages || []) {
    for (const map of stageDef.addMaps || []) {
      if (!result.has(map)) result.set(map, Number(stageDef.stage));
    }
  }
  return result;
}

function stageMapOrder(access) {
  return new Map(
    (access?.stages || []).map(stageDef => [
      Number(stageDef.stage),
      [...(stageDef.addMaps || [])],
    ])
  );
}

export async function buildExpWorld({
  commit,
  access,
  trainerSource,
  version = 'HEARTGOLD',
  timing = null,
}) {
  const [personalJson, encounterJson, prizeMoneySource, eventPaths] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/personal.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    fetchText(`${PRET_RAW_ROOT}/${commit}/asm/overlay_12_battle_command.s`),
    loadZoneEventPaths(commit),
  ]);

  const expYieldBySpecies = new Map(
    (personalJson.baseStats || []).map(row => [
      `SPECIES_${row.species}`,
      Number(row.expYield),
    ])
  );

  const prizeMultiplierByClass = parsePrizeMoneyTable(prizeMoneySource);
  const mapStages = earliestMapStages(access);
  const mapRows = [...mapStages.entries()]
    .map(([map, stage]) => ({ map, stage, path: eventPaths.get(map) || null }))
    .filter(row => row.path);

  const eventJsons = await Promise.all(
    mapRows.map(row => fetchJson(`${PRET_RAW_ROOT}/${commit}/${row.path}`))
  );

  const seenTrainerKeys = new Set();
  const stageTrainerRewards = new Map();
  const stageMoneyRewards = new Map();
  const trainerRows = [];

  for (let index = 0; index < mapRows.length; index += 1) {
    const row = mapRows[index];
    const refs = collectTrainerRefs(eventJsons[index]);

    for (const { key, isDouble } of refs.values()) {
      if (seenTrainerKeys.has(key)) continue;
      seenTrainerKeys.add(key);

      const trainerId = trainerSource.constants.get(key);
      if (trainerId === undefined) continue;
      const trainer = trainerSource.trainers[trainerId];
      if (!trainer) continue;

      const reward = trainerBattleExp(trainer, expYieldBySpecies);
      const prizeMoney = trainerPrizeMoney(trainer, prizeMultiplierByClass, isDouble);
      const trainerRow = {
        key,
        trainerId,
        map: row.map,
        stage: row.stage,
        isDouble,
        totalExp: reward.total,
        prizeMoney,
        party: reward.details,
      };
      trainerRows.push(trainerRow);

      const stageBucket = stageTrainerRewards.get(row.stage) || {
        stage: row.stage,
        totalExp: 0,
        trainers: [],
      };
      stageBucket.totalExp += reward.total;
      stageBucket.trainers.push(trainerRow);
      stageTrainerRewards.set(row.stage, stageBucket);

      const moneyBucket = stageMoneyRewards.get(row.stage) || {
        stage: row.stage,
        totalMoney: 0,
        trainers: [],
      };
      moneyBucket.totalMoney += prizeMoney;
      moneyBucket.trainers.push(trainerRow);
      stageMoneyRewards.set(row.stage, moneyBucket);
    }
  }

  const mapTrainerRewards = new Map();
  for (const trainerRow of trainerRows) {
    const bucket = mapTrainerRewards.get(trainerRow.map) || {
      map: trainerRow.map,
      stage: trainerRow.stage,
      totalExp: 0,
      totalMoney: 0,
      trainers: [],
    };
    bucket.totalExp += trainerRow.totalExp;
    bucket.totalMoney += Number(trainerRow.prizeMoney || 0);
    bucket.trainers.push(trainerRow);
    mapTrainerRewards.set(trainerRow.map, bucket);
  }

  const bestWildByStage = buildBestWildByStage(encounterJson, access, version, expYieldBySpecies);

  return {
    commit,
    version,
    expYieldBySpecies,
    prizeMultiplierByClass,
    bestWildByStage,
    stageTrainerRewards,
    stageMoneyRewards,
    mapTrainerRewards,
    stageMapOrder: stageMapOrder(access),
    expTiming: timing,
    mapTrainerRows: trainerRows,
    mapCount: mapRows.length,
    unresolvedMaps: [...mapStages.entries()]
      .filter(([map]) => !eventPaths.has(map))
      .map(([map, stage]) => ({ map, stage })),
  };
}

function candidateKey(candidate) {
  return candidate.familyId || candidate.species;
}

function entryLevel(candidate, policy = 'midpoint') {
  const min = Number(candidate.entryLevelMin);
  const max = Number(candidate.entryLevelMax);
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!hasMin && !hasMax) return null;

  let value;
  if (policy === 'min') value = hasMin ? min : max;
  else if (policy === 'max') value = hasMax ? max : min;
  else if (policy === 'midpoint') {
    if (hasMin && hasMax) value = Math.floor((min + max) / 2);
    else value = hasMin ? min : max;
  } else {
    throw new Error(`Unknown entry-level policy: ${policy}`);
  }
  return Math.max(1, Math.floor(value));
}

function createCandidateState(candidate, entryLevelPolicy = 'midpoint') {
  const level = entryLevel(candidate, entryLevelPolicy);
  const growthRate = candidate.growthRate || null;
  const initialExp = level === null ? null : expAtLevel(growthRate, level);
  return {
    candidate,
    key: candidateKey(candidate),
    species: candidate.species,
    availableFrom: Number(candidate.availableFrom || 0),
    growthRate,
    entryLevel: level,
    exp: initialExp,
    level,
    unknown: level === null || initialExp === null,
  };
}

function progressWithinLevel(state) {
  if (state.unknown || state.level >= 100) return 1;
  const here = expAtLevel(state.growthRate, state.level);
  const next = expAtLevel(state.growthRate, state.level + 1);
  if (here === null || next === null || next <= here) return 1;
  return (state.exp - here) / (next - here);
}

export function allocateBalancedExp(states, amount) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const eligible = states.filter(state => !state.unknown && state.level < 100);

  while (remaining > 0 && eligible.length) {
    eligible.sort((a, b) =>
      a.level - b.level ||
      progressWithinLevel(a) - progressWithinLevel(b) ||
      a.key.localeCompare(b.key)
    );
    const state = eligible[0];
    const nextThreshold = expAtLevel(state.growthRate, state.level + 1);
    if (nextThreshold === null) break;

    const need = Math.max(1, nextThreshold - state.exp);
    const grant = Math.min(remaining, need);
    state.exp += grant;
    allocated += grant;
    remaining -= grant;
    state.level = levelAtExp(state.growthRate, state.exp);

    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      if (eligible[i].level >= 100) eligible.splice(i, 1);
    }
  }

  return { allocated, unallocated: remaining };
}

export function allocateBossAwareExp(states, amount, boss, levelUtility) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const eligible = states.filter(state => !state.unknown && state.level < 100);

  while (remaining > 0 && eligible.length) {
    let best = null;
    for (const state of eligible) {
      const nextThreshold = expAtLevel(state.growthRate, state.level + 1);
      if (nextThreshold === null) continue;
      const need = Math.max(1, nextThreshold - state.exp);
      const currentUtility = Number(levelUtility?.(state.candidate, boss, state.level) || 0);
      const nextUtility = Number(levelUtility?.(state.candidate, boss, state.level + 1) || 0);
      const gain = Math.max(0, nextUtility - currentUtility);
      // Absolute matchup value keeps useful members trainable even between
      // discrete move/evolution breakpoints; marginal gain rewards breakpoints.
      const priority = (0.25 * Math.max(0, nextUtility) + 2 * gain + 0.01) / need;
      if (
        !best ||
        priority > best.priority ||
        (priority === best.priority && nextUtility > best.nextUtility) ||
        (priority === best.priority && nextUtility === best.nextUtility &&
          state.key.localeCompare(best.state.key) < 0)
      ) {
        best = { state, need, priority, nextUtility };
      }
    }
    if (!best) break;

    const grant = Math.min(remaining, best.need);
    best.state.exp += grant;
    allocated += grant;
    remaining -= grant;
    best.state.level = levelAtExp(best.state.growthRate, best.state.exp);

    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      if (eligible[i].level >= 100) eligible.splice(i, 1);
    }
  }

  return { allocated, unallocated: remaining };
}

function stageMapResources(expWorld, stage, excludedKeys) {
  const bucket = expWorld.stageTrainerRewards.get(Number(stage));
  if (!bucket) return { totalExp: 0, totalMoney: 0, trainers: [] };
  const trainers = bucket.trainers.filter(row => !excludedKeys.has(row.key));
  return {
    totalExp: trainers.reduce((sum, row) => sum + row.totalExp, 0),
    totalMoney: trainers.reduce((sum, row) => sum + Number(row.prizeMoney || 0), 0),
    trainers,
  };
}

function singleMapResources(expWorld, map, excludedKeys) {
  const bucket = expWorld.mapTrainerRewards?.get(map);
  if (!bucket) return { totalExp: 0, totalMoney: 0, trainers: [] };
  const trainers = bucket.trainers.filter(row => !excludedKeys.has(row.key));
  return {
    totalExp: trainers.reduce((sum, row) => sum + row.totalExp, 0),
    totalMoney: trainers.reduce((sum, row) => sum + Number(row.prizeMoney || 0), 0),
    trainers,
  };
}

function candidateAcquisitionMaps(candidate) {
  return new Set(
    (candidate?.sources || [])
      .map(source => source?.map)
      .filter(Boolean)
  );
}

function snapshotLevels(states) {
  return Object.fromEntries(
    [...states]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(state => [state.key, state.level])
  );
}

function aceGapForStates(states, targetLevel) {
  let total = 0;
  const details = [];
  for (const state of states) {
    if (state.unknown || state.level >= targetLevel) continue;
    const targetExp = expAtLevel(state.growthRate, targetLevel);
    if (targetExp === null) continue;
    const need = Math.max(0, targetExp - state.exp);
    total += need;
    details.push({ key: state.key, fromLevel: state.level, targetLevel, exp: need });
  }
  return { total, details };
}

function applyAcePaidGrind(states, targetLevel) {
  const gap = aceGapForStates(states, targetLevel);
  for (const detail of gap.details) {
    const state = states.find(item => item.key === detail.key);
    if (!state) continue;
    state.exp += detail.exp;
    state.level = levelAtExp(state.growthRate, state.exp);
  }
  return gap;
}

export function buildTeamExpSchedule({
  candidates,
  routeBosses,
  expWorld,
  profile = 'all-accessible',
  grindPolicy = 'none',
  entryLevelPolicy = 'midpoint',
  sameStageJoinPolicy = 'map-order',
  allocator = 'balanced',
  levelUtility = null,
}) {
  if (!['major', 'normal-route', 'all-accessible'].includes(profile)) {
    throw new Error(`Unknown EXP profile: ${profile}`);
  }
  if (!['none', 'ace-paid'].includes(grindPolicy)) {
    throw new Error(`Unknown grind policy: ${grindPolicy}`);
  }
  if (!['min', 'midpoint', 'max'].includes(entryLevelPolicy)) {
    throw new Error(`Unknown entry-level policy: ${entryLevelPolicy}`);
  }
  if (!['map-order', 'before-map-exp', 'after-map-exp'].includes(sameStageJoinPolicy)) {
    throw new Error(`Unknown same-stage join policy: ${sameStageJoinPolicy}`);
  }
  if (!['balanced', 'boss-aware'].includes(allocator)) {
    throw new Error(`Unknown EXP allocator: ${allocator}`);
  }
  if (allocator === 'boss-aware' && typeof levelUtility !== 'function') {
    throw new Error('boss-aware EXP allocator requires levelUtility(candidate, boss, level)');
  }

  const pending = candidates.map(candidate => createCandidateState(candidate, entryLevelPolicy));
  const states = [];
  const stateKeys = new Set();
  const excludedMapTrainerKeys = new Set(routeBosses.map(boss => boss.key));
  const stageStarted = new Set();
  const processedMaps = new Set();
  const battles = [];
  let totalMapExp = 0;
  let totalMajorExp = 0;
  let totalAllocatedExp = 0;
  let totalUnallocatedExp = 0;
  let totalGrindExp = 0;
  let totalExpectedGrindBattles = 0;
  const startingMoney = 3000;
  let totalMapMoney = 0;
  let totalMajorMoney = 0;
  let currentMoney = startingMoney;

  function addAvailable(stage, map = null, onlyMapped = false) {
    const added = [];
    for (const state of pending) {
      if (state.availableFrom > stage || stateKeys.has(state.key)) continue;
      if (state.availableFrom === stage && map !== null) {
        const maps = candidateAcquisitionMaps(state.candidate);
        if (!maps.has(map)) continue;
      } else if (state.availableFrom === stage && onlyMapped) {
        const maps = candidateAcquisitionMaps(state.candidate);
        if (!maps.size) continue;
      }
      states.push({ ...state });
      stateKeys.add(state.key);
      added.push(state.key);
    }
    return added;
  }

  function addAvailableBeforeBoss(stage, bossLabel) {
    const added = [];
    for (const state of pending) {
      if (state.availableFrom !== stage || stateKeys.has(state.key)) continue;
      if (state.candidate?.joinBeforeBoss !== bossLabel) continue;
      states.push({ ...state });
      stateKeys.add(state.key);
      added.push(state.key);
    }
    return added;
  }

  function allocate(amount, targetBoss) {
    return allocator === 'boss-aware'
      ? allocateBossAwareExp(states, amount, targetBoss, levelUtility)
      : allocateBalancedExp(states, amount);
  }

  function configuredMapsBeforeBoss(stage, bossLabel) {
    const available = new Set(expWorld.stageMapOrder?.get(stage) || []);
    const windows = expWorld.expTiming?.windows || [];
    const maps = [];
    for (const window of windows) {
      if (Number(window.stage) !== Number(stage) || window.beforeBoss !== bossLabel) continue;
      for (const map of window.maps || []) {
        if (available.has(map) && !processedMaps.has(map) && !maps.includes(map)) maps.push(map);
      }
    }
    return maps;
  }

  for (const [battleIndex, boss] of routeBosses.entries()) {
    const stage = Number(boss.stage);
    const firstBattleInStage = !stageStarted.has(stage);
    const nextBoss = routeBosses[battleIndex + 1] || null;
    const lastBattleInStage = !nextBoss || Number(nextBoss.stage) !== stage;

    if (firstBattleInStage) {
      stageStarted.add(stage);
      if (stage === 0 || sameStageJoinPolicy === 'before-map-exp') {
        addAvailable(stage);
      }
    }

    let mapExpBefore = 0;
    let mapMoneyBefore = 0;
    let mapTrainerCount = 0;
    const mapSegments = [];
    let joinedAfterMapExp = [];

    if (sameStageJoinPolicy === 'map-order') {
      const joinedBeforeBossWindow = addAvailableBeforeBoss(stage, boss.label);
      let maps = configuredMapsBeforeBoss(stage, boss.label);

      // Any accessible map not explicitly assigned in exp-timing.json is
      // conservatively delayed until the last scored boss in its stage.
      if (lastBattleInStage) {
        const stageMaps = expWorld.stageMapOrder?.get(stage) || [];
        for (const map of stageMaps) {
          if (!processedMaps.has(map) && !maps.includes(map)) maps.push(map);
        }
      }

      for (const map of maps) {
        const joinedBeforeMapExp = [
          ...joinedBeforeBossWindow.splice(0),
          ...addAvailable(stage, map),
        ];
        const source = profile === 'major'
          ? { totalExp: 0, totalMoney: 0, trainers: [] }
          : singleMapResources(expWorld, map, excludedMapTrainerKeys);
        mapExpBefore += source.totalExp;
        mapMoneyBefore += source.totalMoney;
        mapTrainerCount += source.trainers.length;
        const allocation = allocate(source.totalExp, boss);
        totalAllocatedExp += allocation.allocated;
        totalUnallocatedExp += allocation.unallocated;
        processedMaps.add(map);
        mapSegments.push({
          map,
          joinedBeforeMapExp,
          trainerCount: source.trainers.length,
          exp: source.totalExp,
          money: source.totalMoney,
        });
      }

      // If a boss window has no map bucket, preserve explicit manual joins in
      // diagnostics instead of silently losing them.
      if (joinedBeforeBossWindow.length) {
        mapSegments.push({
          map: null,
          joinedBeforeMapExp: joinedBeforeBossWindow,
          trainerCount: 0,
          exp: 0,
          money: 0,
          reason: 'manual-before-boss',
        });
      }

      if (profile !== 'major') {
        totalMapExp += mapExpBefore;
        totalMapMoney += mapMoneyBefore;
        currentMoney += mapMoneyBefore;
      }

      // Remaining same-stage candidates with no reliable map/window are
      // delayed until the final scored boss of the stage.
      if (lastBattleInStage) joinedAfterMapExp = addAvailable(stage);
    } else if (firstBattleInStage) {
      if (profile === 'normal-route' || profile === 'all-accessible') {
        const source = stageMapResources(expWorld, stage, excludedMapTrainerKeys);
        mapExpBefore = source.totalExp;
        mapMoneyBefore = source.totalMoney;
        mapTrainerCount = source.trainers.length;
        const allocation = allocate(mapExpBefore, boss);
        totalAllocatedExp += allocation.allocated;
        totalUnallocatedExp += allocation.unallocated;
        totalMapExp += mapExpBefore;
        totalMapMoney += mapMoneyBefore;
        currentMoney += mapMoneyBefore;
      }
      joinedAfterMapExp = addAvailable(stage);
    }

    const wild = expWorld.bestWildByStage?.get(stage)?.best || null;
    const aceGapBefore = aceGapForStates(states, Number(boss.aceLevel));
    const expectedAceGapBattles = wild?.expectedExpPerBattle > 0
      ? Math.ceil(aceGapBefore.total / wild.expectedExpPerBattle)
      : (aceGapBefore.total ? null : 0);

    let grindExpBefore = 0;
    let expectedGrindBattles = 0;
    if (grindPolicy === 'ace-paid' && aceGapBefore.total > 0) {
      const applied = applyAcePaidGrind(states, Number(boss.aceLevel));
      grindExpBefore = applied.total;
      expectedGrindBattles = wild?.expectedExpPerBattle > 0
        ? Math.ceil(grindExpBefore / wild.expectedExpPerBattle)
        : null;
      totalGrindExp += grindExpBefore;
      if (expectedGrindBattles !== null) totalExpectedGrindBattles += expectedGrindBattles;
    }

    const levelsBefore = snapshotLevels(states);
    const moneyBefore = currentMoney;
    const majorReward = trainerBattleExp(boss.trainer, expWorld.expYieldBySpecies);
    const majorPrizeMoney = trainerPrizeMoney(
      boss.trainer,
      expWorld.prizeMultiplierByClass,
      false,
    );
    battles.push({
      battleIndex,
      key: boss.key,
      label: boss.label,
      stage,
      aceLevel: boss.aceLevel,
      mapExpBefore,
      mapMoneyBefore,
      mapTrainerCount,
      mapSegments,
      joinedAfterMapExp,
      moneyBefore,
      bestWildGrind: wild,
      aceGapExpBefore: aceGapBefore.total,
      expectedAceGapBattles,
      grindExpBefore,
      expectedGrindBattles,
      levelsBefore,
      rewardAfter: majorReward.total,
      prizeMoneyAfter: majorPrizeMoney,
    });

    const allocation = allocate(majorReward.total, routeBosses[battleIndex + 1] || boss);
    totalMajorExp += majorReward.total;
    totalMajorMoney += majorPrizeMoney;
    currentMoney += majorPrizeMoney;
    totalAllocatedExp += allocation.allocated;
    totalUnallocatedExp += allocation.unallocated;
  }

  return {
    profile,
    grindPolicy,
    entryLevelPolicy,
    entryLevelAssumption: entryLevelPolicy === 'midpoint'
      ? 'midpoint of source-backed encounter/gift level range'
      : `${entryLevelPolicy} source-backed encounter/gift level`,
    sameStageJoinPolicy,
    allocator,
    allocatorDescription: allocator === 'boss-aware'
      ? 'boss-aware matchup utility per EXP-to-next-level'
      : 'balanced-lowest-level-first',
    totalMapExp,
    totalMajorExp,
    totalNaturalExp: totalMapExp + totalMajorExp,
    startingMoney,
    totalMapMoney,
    totalMajorMoney,
    totalNaturalMoney: startingMoney + totalMapMoney + totalMajorMoney,
    finalMoneyBeforePurchases: currentMoney,
    totalGrindExp,
    totalExpectedGrindBattles,
    totalAllocatedExp,
    totalUnallocatedExp,
    unknownEntryLevels: states.filter(state => state.unknown).map(state => state.species),
    battles,
    finalLevels: snapshotLevels(states),
  };
}
