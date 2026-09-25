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

function collectTrainerKeys(value, out = new Set()) {
  if (typeof value === 'string') {
    const regex = /std_trainer(?:_2)?\((TRAINER_[A-Z0-9_]+)\)/g;
    for (const match of value.matchAll(regex)) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTrainerKeys(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectTrainerKeys(item, out);
  }
  return out;
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

export async function buildExpWorld({ commit, access, trainerSource, version = 'HEARTGOLD' }) {
  const [personalJson, encounterJson, eventPaths] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/personal.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    loadZoneEventPaths(commit),
  ]);

  const expYieldBySpecies = new Map(
    (personalJson.baseStats || []).map(row => [
      `SPECIES_${row.species}`,
      Number(row.expYield),
    ])
  );

  const mapStages = earliestMapStages(access);
  const mapRows = [...mapStages.entries()]
    .map(([map, stage]) => ({ map, stage, path: eventPaths.get(map) || null }))
    .filter(row => row.path);

  const eventJsons = await Promise.all(
    mapRows.map(row => fetchJson(`${PRET_RAW_ROOT}/${commit}/${row.path}`))
  );

  const seenTrainerKeys = new Set();
  const stageTrainerRewards = new Map();
  const trainerRows = [];

  for (let index = 0; index < mapRows.length; index += 1) {
    const row = mapRows[index];
    const keys = collectTrainerKeys(eventJsons[index]);

    for (const key of keys) {
      if (seenTrainerKeys.has(key)) continue;
      seenTrainerKeys.add(key);

      const trainerId = trainerSource.constants.get(key);
      if (trainerId === undefined) continue;
      const trainer = trainerSource.trainers[trainerId];
      if (!trainer) continue;

      const reward = trainerBattleExp(trainer, expYieldBySpecies);
      const trainerRow = {
        key,
        trainerId,
        map: row.map,
        stage: row.stage,
        totalExp: reward.total,
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
    }
  }

  const bestWildByStage = buildBestWildByStage(encounterJson, access, version, expYieldBySpecies);

  return {
    commit,
    version,
    expYieldBySpecies,
    bestWildByStage,
    stageTrainerRewards,
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

function entryLevel(candidate) {
  const max = Number(candidate.entryLevelMax);
  if (Number.isFinite(max)) return Math.max(1, Math.floor(max));
  const min = Number(candidate.entryLevelMin);
  if (Number.isFinite(min)) return Math.max(1, Math.floor(min));
  return null;
}

function createCandidateState(candidate) {
  const level = entryLevel(candidate);
  const growthRate = candidate.growthRate || null;
  const initialExp = level === null ? null : expAtLevel(growthRate, level);
  return {
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

function stageMapExp(expWorld, stage, excludedKeys) {
  const bucket = expWorld.stageTrainerRewards.get(Number(stage));
  if (!bucket) return { total: 0, trainers: [] };
  const trainers = bucket.trainers.filter(row => !excludedKeys.has(row.key));
  return {
    total: trainers.reduce((sum, row) => sum + row.totalExp, 0),
    trainers,
  };
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
}) {
  if (!['major', 'all-accessible'].includes(profile)) {
    throw new Error(`Unknown EXP profile: ${profile}`);
  }
  if (!['none', 'ace-paid'].includes(grindPolicy)) {
    throw new Error(`Unknown grind policy: ${grindPolicy}`);
  }

  const pending = candidates.map(createCandidateState);
  const states = [];
  const stateKeys = new Set();
  const excludedMapTrainerKeys = new Set(routeBosses.map(boss => boss.key));
  const stageStarted = new Set();
  const battles = [];
  let totalMapExp = 0;
  let totalMajorExp = 0;
  let totalAllocatedExp = 0;
  let totalUnallocatedExp = 0;
  let totalGrindExp = 0;
  let totalExpectedGrindBattles = 0;

  function addAvailable(stage) {
    for (const state of pending) {
      if (state.availableFrom > stage || stateKeys.has(state.key)) continue;
      states.push({ ...state });
      stateKeys.add(state.key);
    }
  }

  for (const [battleIndex, boss] of routeBosses.entries()) {
    const stage = Number(boss.stage);
    addAvailable(stage);

    let mapExpBefore = 0;
    let mapTrainerCount = 0;
    if (!stageStarted.has(stage)) {
      stageStarted.add(stage);
      if (profile === 'all-accessible') {
        const source = stageMapExp(expWorld, stage, excludedMapTrainerKeys);
        mapExpBefore = source.total;
        mapTrainerCount = source.trainers.length;
        const allocation = allocateBalancedExp(states, mapExpBefore);
        totalMapExp += mapExpBefore;
        totalAllocatedExp += allocation.allocated;
        totalUnallocatedExp += allocation.unallocated;
      }
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
    const majorReward = trainerBattleExp(boss.trainer, expWorld.expYieldBySpecies);
    battles.push({
      battleIndex,
      key: boss.key,
      label: boss.label,
      stage,
      aceLevel: boss.aceLevel,
      mapExpBefore,
      mapTrainerCount,
      bestWildGrind: wild,
      aceGapExpBefore: aceGapBefore.total,
      expectedAceGapBattles,
      grindExpBefore,
      expectedGrindBattles,
      levelsBefore,
      rewardAfter: majorReward.total,
    });

    const allocation = allocateBalancedExp(states, majorReward.total);
    totalMajorExp += majorReward.total;
    totalAllocatedExp += allocation.allocated;
    totalUnallocatedExp += allocation.unallocated;
  }

  return {
    profile,
    grindPolicy,
    entryLevelAssumption: 'highest source-backed encounter/gift level',
    allocator: 'balanced-lowest-level-first',
    totalMapExp,
    totalMajorExp,
    totalNaturalExp: totalMapExp + totalMajorExp,
    totalGrindExp,
    totalExpectedGrindBattles,
    totalAllocatedExp,
    totalUnallocatedExp,
    unknownEntryLevels: states.filter(state => state.unknown).map(state => state.species),
    battles,
    finalLevels: snapshotLevels(states),
  };
}
