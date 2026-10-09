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
  // Keep EXP state keys identical to battle.mjs. Trade-aware evolution
  // variants share a familyId but have distinct searchKey values; using only
  // familyId here makes materializeCandidateTeam miss levelsByCandidate and
  // silently fall back to the boss ace level.
  return candidate.searchKey || candidate.familyId || candidate.species;
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

function normalizedSourceLevelDistribution(source, candidate) {
  const explicit = (source?.levelDistribution || [])
    .map(row => ({
      level: Number(row?.level),
      probability: Number(row?.probability),
    }))
    .filter(row =>
      Number.isFinite(row.level) &&
      row.level >= 1 &&
      row.level <= 100 &&
      Number.isFinite(row.probability) &&
      row.probability > 0
    );
  if (explicit.length) {
    const total = explicit.reduce((sum, row) => sum + row.probability, 0);
    return explicit.map(row => ({
      level: row.level,
      probability: row.probability / total,
    }));
  }

  const sourceMin = Number(source?.minLevel);
  const sourceMax = Number(source?.maxLevel);
  const min = Number.isFinite(sourceMin) ? sourceMin : Number(candidate?.entryLevelMin);
  const max = Number.isFinite(sourceMax) ? sourceMax : Number(candidate?.entryLevelMax);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return [];
  const start = Math.max(1, Math.floor(Number.isFinite(min) ? min : max));
  const end = Math.min(100, Math.floor(Number.isFinite(max) ? max : min));
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const count = hi - lo + 1;
  return Array.from({ length: count }, (_, index) => ({
    level: lo + index,
    probability: 1 / count,
  }));
}

function expectedEntryState(candidate) {
  const growthRate = candidate.growthRate || null;
  if (!growthRate) return null;

  const rawSources = Array.isArray(candidate.sources) && candidate.sources.length
    ? candidate.sources
    : [null];
  const options = [];
  for (const source of rawSources) {
    const distribution = normalizedSourceLevelDistribution(source, candidate);
    if (!distribution.length) continue;
    let expectedExp = 0;
    let expectedLevel = 0;
    let valid = true;
    for (const row of distribution) {
      const exp = expAtLevel(growthRate, row.level);
      if (exp === null) {
        valid = false;
        break;
      }
      expectedExp += row.probability * exp;
      expectedLevel += row.probability * row.level;
    }
    if (!valid) continue;
    options.push({
      expectedExp,
      expectedLevel,
      distribution,
      source,
    });
  }
  if (!options.length) return null;

  // Capture friction is intentionally not an optimization objective in the
  // route model. If multiple legal earliest-stage sources exist, use the one
  // with the highest expected capture EXP instead of assuming the maximum slot
  // level from the union of all sources.
  options.sort((a, b) =>
    b.expectedExp - a.expectedExp ||
    b.expectedLevel - a.expectedLevel ||
    String(a.source?.map || '').localeCompare(String(b.source?.map || '')) ||
    String(a.source?.method || '').localeCompare(String(b.source?.method || ''))
  );
  const best = options[0];
  return {
    ...best,
    level: levelAtExp(growthRate, best.expectedExp),
  };
}

function createCandidateState(candidate, entryLevelPolicy = 'midpoint') {
  const growthRate = candidate.growthRate || null;
  const expected = entryLevelPolicy === 'expected' ? expectedEntryState(candidate) : null;
  const level = expected ? expected.level : entryLevel(candidate, entryLevelPolicy);
  const initialExp = expected
    ? expected.expectedExp
    : (level === null ? null : expAtLevel(growthRate, level));
  return {
    candidate,
    key: candidateKey(candidate),
    species: candidate.species,
    availableFrom: Number(candidate.availableFrom || 0),
    growthRate,
    entryLevel: level,
    entryExpectedLevel: expected?.expectedLevel ?? null,
    entrySource: expected?.source || null,
    initialExp,
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

function allocateBossAwareExpInternal(
  states,
  amount,
  boss,
  levelUtility,
  { softLevelScale = null } = {},
) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const eligible = states.filter(state => !state.unknown && state.level < 100);

  while (remaining > 0 && eligible.length) {
    const minimumLevel = Math.min(...eligible.map(state => state.level));
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
      const basePriority = (0.25 * Math.max(0, nextUtility) + 2 * gain + 0.01) / need;
      const levelGap = Math.max(0, state.level - minimumLevel);
      const fairness = softLevelScale === null
        ? 1
        : 1 / (1 + (levelGap / Math.max(1, Number(softLevelScale))) ** 2);
      const priority = basePriority * fairness;
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

export function allocateBossAwareExp(states, amount, boss, levelUtility) {
  return allocateBossAwareExpInternal(states, amount, boss, levelUtility);
}

export function allocateBossAwareSoftExp(
  states,
  amount,
  boss,
  levelUtility,
  softLevelScale = 8,
) {
  return allocateBossAwareExpInternal(
    states,
    amount,
    boss,
    levelUtility,
    { softLevelScale },
  );
}



export function allocateBossAwareDepthExp(
  states,
  amount,
  boss,
  levelUtility,
  { depth = 2 } = {},
) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const eligible = states.filter(state => !state.unknown && state.level < 100);
  const aceLevel = Math.max(1, Math.floor(Number(boss?.aceLevel || 1)));
  const targetDepth = Math.max(1, Math.floor(Number(depth || 2)));

  while (remaining > 0 && eligible.length) {
    const potentialRows = eligible
      .map(state => ({
        state,
        aceUtility: Math.max(
          0,
          Number(levelUtility?.(state.candidate, boss, aceLevel) || 0),
        ),
      }))
      .sort((a, b) =>
        b.aceUtility - a.aceUtility ||
        a.state.key.localeCompare(b.state.key)
      );
    const depthKeys = new Set(
      potentialRows
        .filter(row => row.aceUtility > 1e-9)
        .slice(0, targetDepth)
        .map(row => row.state.key)
    );
    const aceUtilityByKey = new Map(
      potentialRows.map(row => [row.state.key, row.aceUtility])
    );

    let best = null;
    for (const state of eligible) {
      const nextThreshold = expAtLevel(state.growthRate, state.level + 1);
      if (nextThreshold === null) continue;
      const need = Math.max(1, nextThreshold - state.exp);
      const currentUtility = Math.max(
        0,
        Number(levelUtility?.(state.candidate, boss, state.level) || 0),
      );
      const nextUtility = Math.max(
        0,
        Number(levelUtility?.(state.candidate, boss, state.level + 1) || 0),
      );
      const gain = Math.max(0, nextUtility - currentUtility);
      const baseNumerator =
        0.25 * nextUtility +
        2 * gain +
        0.01;

      let depthBonus = 0;
      const aceUtility = Number(aceUtilityByKey.get(state.key) || 0);
      if (depthKeys.has(state.key) && aceUtility > 1e-9) {
        const cappedLevel = Math.min(state.level, aceLevel);
        const cappedUtility = Math.max(
          0,
          Number(levelUtility?.(state.candidate, boss, cappedLevel) || 0),
        );
        const readiness = Math.max(0, Math.min(1, cappedUtility / aceUtility));
        const rawBonus = 0.25 * aceUtility * Math.max(0, 1 - readiness);
        // The roster-depth signal can at most double the old boss-aware
        // numerator. This adds a bounded incentive for a second viable answer
        // without suppressing the existing carry or equalizing all six slots.
        depthBonus = Math.min(rawBonus, baseNumerator);
      }

      const priority = (baseNumerator + depthBonus) / need;
      if (
        !best ||
        priority > best.priority ||
        (priority === best.priority && depthBonus > best.depthBonus) ||
        (priority === best.priority && depthBonus === best.depthBonus &&
          nextUtility > best.nextUtility) ||
        (priority === best.priority && depthBonus === best.depthBonus &&
          nextUtility === best.nextUtility &&
          state.key.localeCompare(best.state.key) < 0)
      ) {
        best = { state, need, priority, depthBonus, nextUtility };
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

export function allocateBossAwareSaturationExp(states, amount, boss, levelUtility) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const eligible = states.filter(state => !state.unknown && state.level < 100);
  const aceLevel = Math.max(1, Math.floor(Number(boss?.aceLevel || 1)));

  while (remaining > 0 && eligible.length) {
    let best = null;
    for (const state of eligible) {
      const nextThreshold = expAtLevel(state.growthRate, state.level + 1);
      if (nextThreshold === null) continue;
      const need = Math.max(1, nextThreshold - state.exp);

      // Evaluate readiness only up to the current boss's ace level. This makes
      // the allocator care about building additional viable answers instead of
      // repeatedly over-leveling the already-ready carry. Unlike the old
      // boss-aware-soft rule, it never penalizes a member just for being above
      // the team's minimum level.
      const cappedCurrentLevel = Math.min(state.level, aceLevel);
      const cappedNextLevel = Math.min(state.level + 1, aceLevel);
      const aceUtility = Math.max(
        0,
        Number(levelUtility?.(state.candidate, boss, aceLevel) || 0),
      );
      const currentUtility = Math.max(
        0,
        Number(levelUtility?.(state.candidate, boss, cappedCurrentLevel) || 0),
      );
      const nextUtility = Math.max(
        0,
        Number(levelUtility?.(state.candidate, boss, cappedNextLevel) || 0),
      );
      const readiness = aceUtility > 1e-9
        ? Math.max(0, Math.min(1, currentUtility / aceUtility))
        : 1;
      const readinessGap = Math.max(0, 1 - readiness);
      const gain = Math.max(0, nextUtility - currentUtility);

      // Existing boss-aware structure, but the absolute-utility term fades as
      // the member reaches its own ace-level matchup potential. A strong carry
      // can still receive EXP through genuine marginal gain, while useful but
      // under-developed answers get a chance to become battle-ready.
      const priority =
        (0.25 * nextUtility * readinessGap + 2 * gain + 0.01) / need;

      if (
        !best ||
        priority > best.priority ||
        (priority === best.priority && aceUtility > best.aceUtility) ||
        (priority === best.priority && aceUtility === best.aceUtility &&
          nextUtility > best.nextUtility) ||
        (priority === best.priority && aceUtility === best.aceUtility &&
          nextUtility === best.nextUtility &&
          state.key.localeCompare(best.state.key) < 0)
      ) {
        best = { state, need, priority, aceUtility, nextUtility };
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
function cachedLevelUtility(candidate, boss, level, levelUtility, cache = null) {
  if (!cache) return Number(levelUtility?.(candidate, boss, level) || 0);
  let byBoss = cache.get(candidate);
  if (!byBoss) {
    byBoss = new Map();
    cache.set(candidate, byBoss);
  }
  let byLevel = byBoss.get(boss);
  if (!byLevel) {
    byLevel = new Map();
    byBoss.set(boss, byLevel);
  }
  const normalizedLevel = Math.max(1, Math.min(100, Math.floor(Number(level || 1))));
  if (!byLevel.has(normalizedLevel)) {
    byLevel.set(normalizedLevel, Number(levelUtility?.(candidate, boss, normalizedLevel) || 0));
  }
  return byLevel.get(normalizedLevel);
}

function bossUtilityLevelFactor(boss, level) {
  const actualLevel = Math.max(1, Math.min(100, Math.floor(Number(level || 1))));
  const aceLevel = Math.max(1, Number(boss?.aceLevel || actualLevel));
  const levelRatio = actualLevel / aceLevel;
  return Math.max(0.25, Math.min(2.0, levelRatio ** 1.4));
}

function normalizedCachedLevelUtility(candidate, boss, level, levelUtility, cache = null) {
  const raw = cachedLevelUtility(candidate, boss, level, levelUtility, cache);
  return raw / Math.max(1e-9, bossUtilityLevelFactor(boss, level));
}

function weightedBreakpointJump(candidate, bosses, targetLevel, levelUtility, discount = 0.72, cache = null) {
  const future = (bosses || []).filter(Boolean);
  if (!future.length || targetLevel <= 1) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (let i = 0; i < future.length; i += 1) {
    const weight = Math.max(0.01, Number(discount) ** i);
    const previousCore = normalizedCachedLevelUtility(
      candidate,
      future[i],
      targetLevel - 1,
      levelUtility,
      cache,
    );
    const targetCore = normalizedCachedLevelUtility(
      candidate,
      future[i],
      targetLevel,
      levelUtility,
      cache,
    );
    weighted += weight * Math.max(0, targetCore - previousCore);
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0;
}

export function allocateBreakpointAwareExp(
  states,
  amount,
  futureBosses,
  levelUtility,
  {
    bossHorizon = 4,
    levelLookahead = 12,
    discount = 0.72,
    utilityCache = null,
    breakpointWeight = 1,
  } = {},
) {
  let remaining = Math.max(0, Math.floor(Number(amount || 0)));
  let allocated = 0;
  const horizon = (futureBosses || [])
    .filter(Boolean)
    .slice(0, Math.max(1, Number(bossHorizon) || 4));
  const immediateBoss = horizon[0] || null;
  const eligible = states.filter(state => !state.unknown && state.level < 100);
  if (!immediateBoss) return allocateBalancedExp(states, remaining);

  while (remaining > 0 && eligible.length) {
    let best = null;
    for (const state of eligible) {
      const nextLevel = state.level + 1;
      const nextThreshold = expAtLevel(state.growthRate, nextLevel);
      if (nextThreshold === null) continue;
      const nextNeed = Math.max(1, nextThreshold - state.exp);
      const currentUtility = cachedLevelUtility(
        state.candidate,
        immediateBoss,
        state.level,
        levelUtility,
        utilityCache,
      );
      const nextUtility = cachedLevelUtility(
        state.candidate,
        immediateBoss,
        nextLevel,
        levelUtility,
        utilityCache,
      );
      const immediateGain = Math.max(0, nextUtility - currentUtility);
      // Preserve the existing boss-aware numerator as the baseline. Distant
      // targets must amortize that value across their full EXP cost; otherwise
      // any tiny future bonus would make a far breakpoint beat the next level.
      const immediateNumerator =
        0.25 * Math.max(0, nextUtility) +
        2 * immediateGain +
        0.01;
      const immediatePriority = immediateNumerator / nextNeed;

      let stateBest = {
        state,
        need: nextNeed,
        priority: immediatePriority,
        targetLevel: nextLevel,
        nextUtility,
        breakpointJump: 0,
      };

      const maxTargetLevel = Math.min(
        100,
        state.level + Math.max(1, Number(levelLookahead) || 12),
      );
      for (let targetLevel = nextLevel; targetLevel <= maxTargetLevel; targetLevel += 1) {
        const breakpointJump = weightedBreakpointJump(
          state.candidate,
          horizon,
          targetLevel,
          levelUtility,
          discount,
          utilityCache,
        );
        // After removing the smooth level factor, positive jumps represent
        // actual move/evolution matchup changes rather than ordinary stat growth.
        if (breakpointJump <= 1e-9) continue;

        const targetExp = expAtLevel(state.growthRate, targetLevel);
        if (targetExp === null) continue;
        const need = Math.max(1, targetExp - state.exp);
        const rawBreakpointBonus =
          Math.max(0, Number(breakpointWeight) || 0) * breakpointJump;
        // Keep foresight bounded: a breakpoint may at most triple the
        // immediate boss-aware numerator (baseline + 2x bonus). This lets a
        // nearby evolution/move breakpoint win, but blocks long-range jumps
        // such as funding many ordinary levels just to reach a distant form.
        const breakpointBonus = Math.min(
          rawBreakpointBonus,
          2 * Math.max(0.01, immediateNumerator),
        );
        const priority = (immediateNumerator + breakpointBonus) / need;

        if (
          priority > stateBest.priority ||
          (priority === stateBest.priority && breakpointJump > stateBest.breakpointJump) ||
          (priority === stateBest.priority && breakpointJump === stateBest.breakpointJump &&
            targetLevel < stateBest.targetLevel)
        ) {
          stateBest = {
            state,
            need,
            priority,
            targetLevel,
            nextUtility,
            breakpointJump,
          };
        }
      }

      if (
        !best ||
        stateBest.priority > best.priority ||
        (stateBest.priority === best.priority && stateBest.breakpointJump > best.breakpointJump) ||
        (stateBest.priority === best.priority && stateBest.breakpointJump === best.breakpointJump &&
          stateBest.nextUtility > best.nextUtility) ||
        (stateBest.priority === best.priority && stateBest.breakpointJump === best.breakpointJump &&
          stateBest.nextUtility === best.nextUtility &&
          state.key.localeCompare(best.state.key) < 0)
      ) {
        best = stateBest;
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

function snapshotExp(states) {
  return Object.fromEntries(
    [...states]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(state => [state.key, Number(state.exp || 0)])
  );
}

function snapshotRouteAllocatedExp(states) {
  return Object.fromEntries(
    [...states]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(state => [
        state.key,
        Math.max(0, Number(state.exp || 0) - Number(state.initialExp || 0)),
      ])
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
  grindBudget = 0,
  grindPlanBattles = {},
  entryLevelPolicy = 'midpoint',
  sameStageJoinPolicy = 'map-order',
  allocator = 'balanced',
  levelUtility = null,
  bossAwareSoftLevelScale = 8,
  breakpointBossHorizon = 4,
  breakpointLevelLookahead = 12,
  breakpointDiscount = 0.72,
  activationTargets = [],
  recipientPolicy = {},
}) {
  if (!['major', 'normal-route', 'all-accessible'].includes(profile)) {
    throw new Error(`Unknown EXP profile: ${profile}`);
  }
  if (!['none', 'ace-paid', 'budgeted', 'planned'].includes(grindPolicy)) {
    throw new Error(`Unknown grind policy: ${grindPolicy}`);
  }
  const normalizedGrindBudget = Math.max(0, Math.floor(Number(grindBudget || 0)));
  const normalizedGrindPlanBattles = Object.fromEntries(
    Object.entries(grindPlanBattles || {}).map(([key, value]) => {
      const count = Math.max(0, Math.floor(Number(value || 0)));
      if (!Number.isFinite(count)) {
        throw new Error(`Invalid planned grind battle count for ${key}: ${value}`);
      }
      return [String(key), count];
    })
  );
  if (!Number.isFinite(normalizedGrindBudget)) {
    throw new Error(`Invalid grind budget: ${grindBudget}`);
  }
  if (!['min', 'midpoint', 'max', 'expected'].includes(entryLevelPolicy)) {
    throw new Error(`Unknown entry-level policy: ${entryLevelPolicy}`);
  }
  if (!['map-order', 'before-map-exp', 'after-map-exp'].includes(sameStageJoinPolicy)) {
    throw new Error(`Unknown same-stage join policy: ${sameStageJoinPolicy}`);
  }
  if (!['balanced', 'boss-aware-soft', 'boss-aware', 'boss-aware-depth', 'boss-aware-saturation', 'breakpoint-aware'].includes(allocator)) {
    throw new Error(`Unknown EXP allocator: ${allocator}`);
  }
  if (allocator !== 'balanced' && typeof levelUtility !== 'function') {
    throw new Error(
      `${allocator} EXP allocator requires levelUtility(candidate, boss, level)`
    );
  }
  if (!Number.isInteger(Number(bossAwareSoftLevelScale)) || Number(bossAwareSoftLevelScale) < 1) {
    throw new Error(`Invalid boss-aware-soft level gap: ${bossAwareSoftLevelScale}`);
  }
  if (!Number.isInteger(Number(breakpointBossHorizon)) || Number(breakpointBossHorizon) < 1) {
    throw new Error(`Invalid breakpoint boss horizon: ${breakpointBossHorizon}`);
  }
  if (!Number.isInteger(Number(breakpointLevelLookahead)) || Number(breakpointLevelLookahead) < 1) {
    throw new Error(`Invalid breakpoint level lookahead: ${breakpointLevelLookahead}`);
  }
  if (!Number.isFinite(Number(breakpointDiscount)) || Number(breakpointDiscount) <= 0 || Number(breakpointDiscount) > 1) {
    throw new Error(`Invalid breakpoint discount: ${breakpointDiscount}`);
  }

  const normalizedActivationTargets = (activationTargets || []).map(target => {
    const key = String(target?.key || '').trim();
    const level = Math.max(1, Math.min(100, Math.floor(Number(target?.level || 0))));
    if (!key || !Number.isFinite(level) || level < 1) {
      throw new Error(`Invalid activation target: ${JSON.stringify(target)}`);
    }
    return { key, level };
  });

  const normalizedRecipientPolicy = Object.fromEntries(
    Object.entries(recipientPolicy || {}).map(([checkpoint, keys]) => {
      if (!Array.isArray(keys)) {
        throw new Error(
          `EXP recipient policy for ${checkpoint} must be an array of candidate keys`
        );
      }
      return [
        String(checkpoint),
        [...new Set(keys.map(key => String(key).trim()).filter(Boolean))],
      ];
    })
  );

  const pending = candidates.map(candidate => createCandidateState(candidate, entryLevelPolicy));
  const knownCandidateKeys = new Set(pending.map(state => state.key));
  for (const [checkpoint, keys] of Object.entries(normalizedRecipientPolicy)) {
    const unknown = keys.filter(key => !knownCandidateKeys.has(key));
    if (unknown.length) {
      throw new Error(
        `EXP recipient policy for ${checkpoint} references unknown candidate key(s): ${unknown.join(', ')}`
      );
    }
  }
  const states = [];
  const stateKeys = new Set();
  const trainerWindows = expWorld.expTiming?.trainerWindows || [];
  const deferredTrainerKeys = new Set(
    trainerWindows.flatMap(window => window.trainers || [])
  );
  const excludedMapTrainerKeys = new Set([
    ...routeBosses.map(boss => boss.key),
    ...deferredTrainerKeys,
  ]);
  const trainerRowByKey = new Map(
    (expWorld.mapTrainerRows || []).map(row => [row.key, row])
  );
  const processedTrainerWindowKeys = new Set();
  const stageStarted = new Set();
  const processedMaps = new Set();
  const battles = [];
  let totalMapExp = 0;
  let totalMajorExp = 0;
  let totalAllocatedExp = 0;
  let totalUnallocatedExp = 0;
  let totalGrindExp = 0;
  let totalReleasedGrindBudget = 0;
  let totalExpectedGrindBattles = 0;
  const grindAllocatedByKey = new Map();
  const startingMoney = 3000;
  let totalMapMoney = 0;
  let totalMajorMoney = 0;
  let currentMoney = startingMoney;
  const breakpointUtilityCache = new Map();
  let totalActivationExp = 0;
  const activationAllocatedByKey = new Map();

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

  function addAvailableUnmapped(stage) {
    const added = [];
    for (const state of pending) {
      if (state.availableFrom !== stage || stateKeys.has(state.key)) continue;
      const maps = candidateAcquisitionMaps(state.candidate);
      if (maps.size) continue;
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

  function configuredRecipientKeys(targetBoss, targetIndex) {
    const lookup = [
      String(targetIndex),
      String(targetBoss?.key || ''),
      String(targetBoss?.label || ''),
    ];
    for (const token of lookup) {
      if (token && Object.prototype.hasOwnProperty.call(normalizedRecipientPolicy, token)) {
        return normalizedRecipientPolicy[token];
      }
    }
    return null;
  }

  function activeRecipientStates(targetBoss, targetIndex) {
    const configured = configuredRecipientKeys(targetBoss, targetIndex);
    if (!configured) return states;
    const active = new Set(configured);
    return states.filter(state => active.has(state.key));
  }

  function recipientSnapshot(targetBoss, targetIndex) {
    const activeStates = activeRecipientStates(targetBoss, targetIndex);
    const active = new Set(activeStates.map(state => state.key));
    return {
      activeRecipientKeys: activeStates.map(state => state.key).sort(),
      benchedRecipientKeys: states
        .filter(state => !active.has(state.key))
        .map(state => state.key)
        .sort(),
    };
  }

  function allocateActivationExp(amount, eligibleStates = states) {
    let remaining = Math.max(0, Math.floor(Number(amount || 0)));
    let allocated = 0;
    for (const target of normalizedActivationTargets) {
      if (remaining <= 0) break;
      const state = eligibleStates.find(item => item.key === target.key);
      if (!state || state.unknown || state.level >= target.level) continue;
      const targetExp = expAtLevel(state.growthRate, target.level);
      if (targetExp === null) continue;
      const need = Math.max(0, targetExp - state.exp);
      if (need <= 0) continue;
      const grant = Math.min(remaining, need);
      state.exp += grant;
      state.level = levelAtExp(state.growthRate, state.exp);
      allocated += grant;
      remaining -= grant;
      activationAllocatedByKey.set(
        target.key,
        Number(activationAllocatedByKey.get(target.key) || 0) + grant,
      );
    }
    return { allocated, unallocated: remaining };
  }

  function allocate(amount, targetBoss, targetIndex) {
    const eligibleStates = activeRecipientStates(targetBoss, targetIndex);
    const activation = allocateActivationExp(amount, eligibleStates);
    totalActivationExp += activation.allocated;
    const remaining = activation.unallocated;
    let base;
    if (allocator === 'breakpoint-aware') {
      const startIndex = Math.max(0, Number(targetIndex) || 0);
      const futureBosses = routeBosses.slice(
        startIndex,
        startIndex + Math.max(1, Number(breakpointBossHorizon) || 4),
      );
      if (!futureBosses.length && targetBoss) futureBosses.push(targetBoss);
      base = allocateBreakpointAwareExp(
        eligibleStates,
        remaining,
        futureBosses,
        levelUtility,
        {
          bossHorizon: breakpointBossHorizon,
          levelLookahead: breakpointLevelLookahead,
          discount: breakpointDiscount,
          utilityCache: breakpointUtilityCache,
        },
      );
    } else if (allocator === 'boss-aware') {
      base = allocateBossAwareExp(eligibleStates, remaining, targetBoss, levelUtility);
    } else if (allocator === 'boss-aware-soft') {
      base = allocateBossAwareSoftExp(
        eligibleStates,
        remaining,
        targetBoss,
        levelUtility,
        bossAwareSoftLevelScale,
      );
    } else if (allocator === 'boss-aware-depth') {
      base = allocateBossAwareDepthExp(
        eligibleStates,
        remaining,
        targetBoss,
        levelUtility,
        { depth: 2 },
      );
    } else if (allocator === 'boss-aware-saturation') {
      base = allocateBossAwareSaturationExp(
        eligibleStates,
        remaining,
        targetBoss,
        levelUtility,
      );
    } else {
      base = allocateBalancedExp(eligibleStates, remaining);
    }
    return {
      allocated: activation.allocated + Number(base?.allocated || 0),
      unallocated: Number(base?.unallocated || 0),
    };
  }

  function snapshotGrindAllocatedByKey() {
    return Object.fromEntries(
      [...grindAllocatedByKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, Number(value || 0)])
    );
  }

  function allocateTrackedGrind(amount, boss, battleIndex) {
    const requested = Math.max(0, Math.floor(Number(amount || 0)));
    if (!requested) return { allocated: 0, unallocated: 0, byKey: {} };
    const before = new Map(states.map(state => [state.key, Number(state.exp || 0)]));
    const result = allocate(requested, boss, battleIndex);
    const byKey = {};
    for (const state of states) {
      const delta = Math.max(0, Number(state.exp || 0) - Number(before.get(state.key) || 0));
      if (!delta) continue;
      byKey[state.key] = delta;
      grindAllocatedByKey.set(
        state.key,
        Number(grindAllocatedByKey.get(state.key) || 0) + delta,
      );
    }
    return { ...result, byKey };
  }

  function totalNaturalExpAvailableBeforeFinalBoss() {
    let total = 0;
    if (profile !== 'major') {
      const seenMaps = new Set();
      for (const maps of expWorld.stageMapOrder?.values?.() || []) {
        for (const map of maps || []) {
          if (seenMaps.has(map)) continue;
          seenMaps.add(map);
          total += Number(singleMapResources(
            expWorld,
            map,
            excludedMapTrainerKeys,
          ).totalExp || 0);
        }
      }
      const seenDeferred = new Set();
      for (const window of trainerWindows) {
        for (const key of window.trainers || []) {
          if (seenDeferred.has(key)) continue;
          seenDeferred.add(key);
          total += Number(trainerRowByKey.get(key)?.totalExp || 0);
        }
      }
    }
    for (const boss of routeBosses.slice(0, -1)) {
      total += Number(
        trainerBattleExp(boss.trainer, expWorld.expYieldBySpecies).total || 0
      );
    }
    return total;
  }

  const naturalExpBeforeFinalBossPotential =
    totalNaturalExpAvailableBeforeFinalBoss();

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

  function configuredTrainerRewardsBeforeBoss(stage, bossLabel) {
    const rows = [];
    for (const window of trainerWindows) {
      if (Number(window.stage) !== Number(stage) || window.beforeBoss !== bossLabel) continue;
      for (const key of window.trainers || []) {
        if (processedTrainerWindowKeys.has(key)) continue;
        const trainer = trainerRowByKey.get(key);
        if (!trainer) continue;
        rows.push({
          ...trainer,
          deferredWindowId: window.id || null,
          deferredWindowSource: window.source || null,
          deferredWindowNote: window.note || null,
        });
        processedTrainerWindowKeys.add(key);
      }
    }
    return rows;
  }

  for (const [battleIndex, boss] of routeBosses.entries()) {
    const stage = Number(boss.stage);
    const firstBattleInStage = !stageStarted.has(stage);
    const nextBoss = routeBosses[battleIndex + 1] || null;
    const lastBattleInStage = !nextBoss || Number(nextBoss.stage) !== stage;

    if (firstBattleInStage) {
      stageStarted.add(stage);
      if (sameStageJoinPolicy === 'before-map-exp') {
        addAvailable(stage);
      } else if (stage === 0 && sameStageJoinPolicy === 'map-order') {
        // The starter/manual unmapped acquisitions exist before Route 29 EXP,
        // but stage-0 wild members must wait until their actual source map is
        // processed. Previously all stage-0 candidates were added here,
        // allowing later catches to receive earlier-route EXP retroactively.
        addAvailableUnmapped(stage);
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
        const allocation = allocate(source.totalExp, boss, battleIndex);
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
        const allocation = allocate(mapExpBefore, boss, battleIndex);
        totalAllocatedExp += allocation.allocated;
        totalUnallocatedExp += allocation.unallocated;
        totalMapExp += mapExpBefore;
        totalMapMoney += mapMoneyBefore;
        currentMoney += mapMoneyBefore;
      }
      joinedAfterMapExp = addAvailable(stage);
    }

    const trainerWindowRows = configuredTrainerRewardsBeforeBoss(stage, boss.label);
    const trainerWindowExp = profile === 'major'
      ? 0
      : trainerWindowRows.reduce((sum, row) => sum + Number(row.totalExp || 0), 0);
    const trainerWindowMoney = profile === 'major'
      ? 0
      : trainerWindowRows.reduce((sum, row) => sum + Number(row.prizeMoney || 0), 0);
    if (trainerWindowExp > 0 || trainerWindowMoney > 0) {
      const allocation = allocate(trainerWindowExp, boss, battleIndex);
      totalAllocatedExp += allocation.allocated;
      totalUnallocatedExp += allocation.unallocated;
      totalMapExp += trainerWindowExp;
      totalMapMoney += trainerWindowMoney;
      currentMoney += trainerWindowMoney;
      mapExpBefore += trainerWindowExp;
      mapMoneyBefore += trainerWindowMoney;
      mapTrainerCount += trainerWindowRows.length;
    }

    const wild = expWorld.bestWildByStage?.get(stage)?.best || null;
    const activeRecipientsForBoss = activeRecipientStates(boss, battleIndex);
    const aceGapBefore = aceGapForStates(activeRecipientsForBoss, Number(boss.aceLevel));
    const expectedAceGapBattles = wild?.expectedExpPerBattle > 0
      ? Math.ceil(aceGapBefore.total / wild.expectedExpPerBattle)
      : (aceGapBefore.total ? null : 0);

    let grindExpBefore = 0;
    let grindAllocatedThisCheckpoint = {};
    let expectedGrindBattles = 0;
    if (grindPolicy === 'ace-paid' && aceGapBefore.total > 0) {
      const before = new Map(states.map(state => [state.key, Number(state.exp || 0)]));
      const applied = applyAcePaidGrind(activeRecipientsForBoss, Number(boss.aceLevel));
      grindExpBefore = applied.total;
      for (const state of states) {
        const delta = Math.max(0, Number(state.exp || 0) - Number(before.get(state.key) || 0));
        if (!delta) continue;
        grindAllocatedThisCheckpoint[state.key] = delta;
        grindAllocatedByKey.set(
          state.key,
          Number(grindAllocatedByKey.get(state.key) || 0) + delta,
        );
      }
      totalReleasedGrindBudget += grindExpBefore;
      expectedGrindBattles = wild?.expectedExpPerBattle > 0
        ? Math.ceil(grindExpBefore / wild.expectedExpPerBattle)
        : null;
      totalGrindExp += grindExpBefore;
      if (expectedGrindBattles !== null) totalExpectedGrindBattles += expectedGrindBattles;
    } else if (grindPolicy === 'planned') {
      const plannedBattles = Number(
        normalizedGrindPlanBattles[String(boss.label)] ??
        normalizedGrindPlanBattles[String(boss.key)] ??
        normalizedGrindPlanBattles[String(battleIndex)] ??
        0
      );
      if (plannedBattles > 0) {
        if (!(wild?.expectedExpPerBattle > 0)) {
          throw new Error(
            `Planned grind before ${boss.label} requires a modeled wild EXP source`
          );
        }
        const requestedExp = Math.max(
          0,
          Math.floor(plannedBattles * Number(wild.expectedExpPerBattle))
        );
        const applied = allocateTrackedGrind(requestedExp, boss, battleIndex);
        grindExpBefore = Number(applied.allocated || 0);
        grindAllocatedThisCheckpoint = applied.byKey || {};
        totalReleasedGrindBudget += grindExpBefore;
        totalGrindExp += grindExpBefore;
        expectedGrindBattles = plannedBattles;
        totalExpectedGrindBattles += plannedBattles;
      }
    } else if (grindPolicy === 'budgeted' && normalizedGrindBudget > 0) {
      const cumulativeNaturalBeforeBoss = Number(totalMapExp + totalMajorExp);
      const releaseFraction = naturalExpBeforeFinalBossPotential > 0
        ? Math.max(0, Math.min(1, cumulativeNaturalBeforeBoss / naturalExpBeforeFinalBossPotential))
        : (battleIndex === routeBosses.length - 1 ? 1 : 0);
      const targetReleased = battleIndex === routeBosses.length - 1
        ? normalizedGrindBudget
        : Math.floor(normalizedGrindBudget * releaseFraction);
      const newlyReleased = Math.max(
        0,
        Math.min(normalizedGrindBudget, targetReleased) - totalReleasedGrindBudget,
      );
      if (newlyReleased > 0) {
        const applied = allocateTrackedGrind(newlyReleased, boss, battleIndex);
        grindExpBefore = Number(applied.allocated || 0);
        grindAllocatedThisCheckpoint = applied.byKey || {};
        totalReleasedGrindBudget += newlyReleased;
        totalGrindExp += grindExpBefore;
        expectedGrindBattles = wild?.expectedExpPerBattle > 0
          ? Math.ceil(grindExpBefore / wild.expectedExpPerBattle)
          : (grindExpBefore > 0 ? null : 0);
        if (expectedGrindBattles !== null) totalExpectedGrindBattles += expectedGrindBattles;
      }
    }

    const levelsBefore = snapshotLevels(states);
    const expBefore = snapshotExp(states);
    const routeAllocatedExpBefore = snapshotRouteAllocatedExp(states);
    const recipientState = recipientSnapshot(boss, battleIndex);
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
      trainerWindowSegments: trainerWindowRows.map(row => ({
        key: row.key,
        map: row.map,
        exp: Number(row.totalExp || 0),
        money: Number(row.prizeMoney || 0),
        windowId: row.deferredWindowId,
        source: row.deferredWindowSource,
        note: row.deferredWindowNote,
      })),
      joinedAfterMapExp,
      moneyBefore,
      bestWildGrind: wild,
      aceGapExpBefore: aceGapBefore.total,
      aceGapExpDetails: aceGapBefore.details,
      expectedAceGapBattles,
      grindExpBefore,
      grindBudgetReleasedBefore: totalReleasedGrindBudget,
      grindAllocatedThisCheckpoint,
      grindAllocatedByKeyBefore: snapshotGrindAllocatedByKey(),
      expectedGrindBattles,
      levelsBefore,
      expBefore,
      routeAllocatedExpBefore,
      activeRecipientKeysBefore: recipientState.activeRecipientKeys,
      benchedRecipientKeysBefore: recipientState.benchedRecipientKeys,
      rewardAfter: majorReward.total,
      prizeMoneyAfter: majorPrizeMoney,
    });

    const nextAllocationIndex = Math.min(battleIndex + 1, routeBosses.length - 1);
    const allocation = allocate(
      majorReward.total,
      routeBosses[nextAllocationIndex] || boss,
      nextAllocationIndex,
    );
    totalMajorExp += majorReward.total;
    totalMajorMoney += majorPrizeMoney;
    currentMoney += majorPrizeMoney;
    totalAllocatedExp += allocation.allocated;
    totalUnallocatedExp += allocation.unallocated;
  }

  return {
    profile,
    grindPolicy,
    grindBudget: grindPolicy === 'budgeted' ? normalizedGrindBudget : 0,
    grindPlanBattles: grindPolicy === 'planned' ? normalizedGrindPlanBattles : {},
    naturalExpBeforeFinalBossPotential,
    entryLevelPolicy,
    entryLevelAssumption: entryLevelPolicy === 'expected'
      ? 'expected capture EXP from source-backed encounter level distributions; highest-expectation legal earliest-stage source when capture friction is excluded'
      : entryLevelPolicy === 'midpoint'
        ? 'midpoint of source-backed encounter/gift level range'
        : `${entryLevelPolicy} source-backed encounter/gift level`,
    sameStageJoinPolicy,
    allocator,
    allocatorDescription: allocator === 'breakpoint-aware'
      ? `boss-aware baseline plus actual move/evolution breakpoint bonus across ${breakpointBossHorizon} bosses and ${breakpointLevelLookahead} levels`
      : allocator === 'boss-aware'
        ? 'boss-aware matchup utility per EXP-to-next-level'
        : allocator === 'boss-aware-depth'
          ? 'boss-aware utility plus a bounded bonus for the top two ace-level matchup answers that are not yet battle-ready'
          : allocator === 'boss-aware-saturation'
            ? 'boss-aware utility with ace-readiness saturation to reduce carry overinvestment without level-equality pressure'
            : allocator === 'boss-aware-soft'
            ? `boss-aware utility with level-gap penalty scale ${bossAwareSoftLevelScale}`
            : 'balanced-lowest-level-first',
    bossAwareSoftLevelScale: allocator === 'boss-aware-soft'
      ? Number(bossAwareSoftLevelScale)
      : null,
    breakpointBossHorizon: allocator === 'breakpoint-aware'
      ? Number(breakpointBossHorizon)
      : null,
    breakpointLevelLookahead: allocator === 'breakpoint-aware'
      ? Number(breakpointLevelLookahead)
      : null,
    breakpointDiscount: allocator === 'breakpoint-aware'
      ? Number(breakpointDiscount)
      : null,
    recipientPolicy: normalizedRecipientPolicy,
    activationTargets: normalizedActivationTargets.map(target => {
      const state = states.find(item => item.key === target.key);
      return {
        key: target.key,
        targetLevel: target.level,
        finalLevel: state?.level ?? null,
        achieved: Boolean(state && !state.unknown && state.level >= target.level),
        allocatedExp: Number(activationAllocatedByKey.get(target.key) || 0),
      };
    }),
    totalActivationExp,
    totalMapExp,
    totalMajorExp,
    totalNaturalExp: totalMapExp + totalMajorExp,
    startingMoney,
    totalMapMoney,
    totalMajorMoney,
    totalNaturalMoney: startingMoney + totalMapMoney + totalMajorMoney,
    finalMoneyBeforePurchases: currentMoney,
    totalGrindExp,
    totalReleasedGrindBudget,
    unusedGrindBudget: grindPolicy === 'budgeted'
      ? Math.max(0, normalizedGrindBudget - totalGrindExp)
      : 0,
    grindAllocatedByKey: snapshotGrindAllocatedByKey(),
    totalExpectedGrindBattles,
    totalAllocatedExp,
    totalUnallocatedExp,
    unknownEntryLevels: states.filter(state => state.unknown).map(state => state.species),
    battles,
    finalLevels: snapshotLevels(states),
  };
}
