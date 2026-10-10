import Showdown from 'pokemon-showdown';
import { constantToName, fetchText } from './hgss-data.mjs';

const { Dex } = Showdown;
const GEN4_DEX = Dex.mod('gen4');

const PRET_RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';

const ENCOUNTER_SLOT_WEIGHTS = {
  land: [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1],
  surf: [60, 30, 5, 4, 1],
  old_rod: [40, 30, 15, 10, 5],
  good_rod: [40, 30, 15, 10, 5],
  super_rod: [40, 30, 15, 10, 5],
  rock_smash: [80, 20],
};
const HEADBUTT_SLOT_WEIGHTS = [50, 15, 15, 10, 5, 5];

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function resolveVersioned(value, version) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('HEARTGOLD' in value || 'SOULSILVER' in value) {
      return resolveVersioned(value[version], version);
    }
    if ('gold' in value || 'silver' in value) {
      const legacyKey = version === 'HEARTGOLD' ? 'gold' : 'silver';
      return resolveVersioned(value[legacyKey], version);
    }
  }
  return value;
}

function speciesValues(value, version, out = []) {
  value = resolveVersioned(value, version);
  if (typeof value === 'string') {
    if (value.startsWith('SPECIES_') && value !== 'SPECIES_NONE') out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) speciesValues(v, version, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) speciesValues(v, version, out);
  }
  return out;
}

function levelRange(level, version) {
  const resolved = resolveVersioned(level, version);
  if (Number.isFinite(Number(resolved))) {
    const value = Number(resolved);
    return { min: value, max: value };
  }
  if (resolved && typeof resolved === 'object') {
    const min = Number(resolveVersioned(resolved.min, version));
    const max = Number(resolveVersioned(resolved.max, version));
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }
  return { min: null, max: null };
}

function methodMons(encounter, method) {
  if (method === 'land') return encounter.land?.mons || [];
  if (method === 'surf') return encounter.surf?.mons || [];
  if (method === 'rock_smash') return encounter.rock_smash?.mons || [];
  return encounter.fishing?.[method]?.mons || [];
}

function encounterRateForMethod(encounter, method) {
  if (method === 'land') return Number(encounter.land?.rate || 0);
  if (method === 'surf') return Number(encounter.surf?.rate || 0);
  if (method === 'rock_smash') return Number(encounter.rock_smash?.rate || 0);
  return Number(encounter.fishing?.[method]?.rate || 0);
}

function speciesForLandTime(value, version, time) {
  const resolved = resolveVersioned(value, version);
  if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    if (time in resolved) return [...new Set(speciesValues(resolved[time], version))];
  }
  return [...new Set(speciesValues(resolved, version))];
}

function addRangeProbability(levelWeights, range, probability) {
  const lo = Number(range?.min);
  const hi = Number(range?.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || probability <= 0) return;
  const start = Math.min(lo, hi);
  const end = Math.max(lo, hi);
  const count = Math.max(1, end - start + 1);
  for (let level = start; level <= end; level += 1) {
    levelWeights[level] = Number(levelWeights[level] || 0) + probability / count;
  }
}

function normalizedLevelDistribution(levelWeights) {
  const entries = Object.entries(levelWeights || {})
    .map(([level, weight]) => ({ level: Number(level), weight: Number(weight) }))
    .filter(row => Number.isFinite(row.level) && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => a.level - b.level);
  const total = entries.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) return [];
  return entries.map(row => ({
    level: row.level,
    probability: row.weight / total,
  }));
}

function methodEntries(encounter, method, version) {
  const mons = methodMons(encounter, method);
  const weights = ENCOUNTER_SLOT_WEIGHTS[method] || [];
  const bySpecies = new Map();

  function add(speciesConst, range, probability, time = null) {
    if (!speciesConst || probability <= 0) return;
    const row = bySpecies.get(speciesConst) || {
      speciesConst,
      minLevel: null,
      maxLevel: null,
      probabilityByTime: {},
      levelWeightsByTime: {},
      levelWeights: {},
      encounterProbability: 0,
      bestTime: null,
    };
    if (Number.isFinite(range.min)) {
      row.minLevel = Number.isFinite(row.minLevel) ? Math.min(row.minLevel, range.min) : range.min;
    }
    if (Number.isFinite(range.max)) {
      row.maxLevel = Number.isFinite(row.maxLevel) ? Math.max(row.maxLevel, range.max) : range.max;
    }
    if (time) {
      row.probabilityByTime[time] = (row.probabilityByTime[time] || 0) + probability;
      if (!row.levelWeightsByTime[time]) row.levelWeightsByTime[time] = {};
      addRangeProbability(row.levelWeightsByTime[time], range, probability);
    } else {
      row.encounterProbability += probability;
      addRangeProbability(row.levelWeights, range, probability);
    }
    bySpecies.set(speciesConst, row);
  }

  for (let index = 0; index < mons.length; index += 1) {
    const mon = mons[index];
    const probability = Number(weights[index] || 0);
    const range = levelRange(mon.level, version);
    if (method === 'land') {
      for (const time of ['morn', 'day', 'nite']) {
        for (const speciesConst of speciesForLandTime(mon.species, version, time)) {
          add(speciesConst, range, probability, time);
        }
      }
    } else {
      for (const speciesConst of [...new Set(speciesValues(mon.species, version))]) {
        add(speciesConst, range, probability);
      }
    }
  }

  const encounterRate = encounterRateForMethod(encounter, method);
  return [...bySpecies.values()].map(row => {
    if (method === 'land') {
      const times = Object.entries(row.probabilityByTime);
      times.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      row.bestTime = times[0]?.[0] || null;
      row.encounterProbability = Number(times[0]?.[1] || 0);
    }
    const levelWeights = method === 'land'
      ? (row.levelWeightsByTime[row.bestTime] || {})
      : row.levelWeights;
    return {
      speciesConst: row.speciesConst,
      minLevel: row.minLevel,
      maxLevel: row.maxLevel,
      encounterProbability: row.encounterProbability,
      expectedEncounters: row.encounterProbability > 0 ? 100 / row.encounterProbability : null,
      encounterRate,
      bestTime: row.bestTime,
      levelDistribution: normalizedLevelDistribution(levelWeights),
    };
  });
}

function headbuttEntries(table, version) {
  const bySpecies = new Map();
  const groups = [
    ['common', table?.CommonMons || []],
    ['rare', table?.RareMons || []],
    ['secret', table?.SecretMons || []],
  ];

  for (const [group, slots] of groups) {
    const groupProbability = new Map();
    const levels = new Map();
    const levelWeightsBySpecies = new Map();
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const probability = Number(HEADBUTT_SLOT_WEIGHTS[index] || 0);
      const species = [...new Set(speciesValues(slot.species, version))];
      for (const speciesConst of species) {
        groupProbability.set(speciesConst, (groupProbability.get(speciesConst) || 0) + probability);
        const range = levels.get(speciesConst) || { min: null, max: null };
        const min = Number(slot.minLevel);
        const max = Number(slot.maxLevel);
        if (Number.isFinite(min)) range.min = Number.isFinite(range.min) ? Math.min(range.min, min) : min;
        if (Number.isFinite(max)) range.max = Number.isFinite(range.max) ? Math.max(range.max, max) : max;
        levels.set(speciesConst, range);
        const levelWeights = levelWeightsBySpecies.get(speciesConst) || {};
        addRangeProbability(levelWeights, { min, max }, probability);
        levelWeightsBySpecies.set(speciesConst, levelWeights);
      }
    }

    for (const [speciesConst, probability] of groupProbability) {
      const range = levels.get(speciesConst) || { min: null, max: null };
      const existing = bySpecies.get(speciesConst);
      if (!existing || probability > existing.encounterProbability) {
        bySpecies.set(speciesConst, {
          speciesConst,
          minLevel: range.min,
          maxLevel: range.max,
          encounterProbability: probability,
          expectedEncounters: probability > 0 ? 100 / probability : null,
          headbuttTreeGroup: group,
          conditionalTreeGroup: true,
          levelDistribution: normalizedLevelDistribution(
            levelWeightsBySpecies.get(speciesConst) || {}
          ),
        });
      }
    }
  }

  return [...bySpecies.values()];
}

function bestCaptureSource(sources) {
  const fixed = (sources || []).find(source =>
    !['wild', 'headbutt'].includes(source.type)
  );
  if (fixed) {
    return {
      mode: 'fixed-or-gift',
      expectedEncounters: 0,
      source: fixed,
    };
  }

  const standard = (sources || [])
    .filter(source => source.type === 'wild' && Number.isFinite(Number(source.expectedEncounters)))
    .sort((a, b) => Number(a.expectedEncounters) - Number(b.expectedEncounters));
  if (standard.length) {
    return {
      mode: 'wild',
      expectedEncounters: Number(standard[0].expectedEncounters),
      source: standard[0],
    };
  }

  const headbutt = (sources || [])
    .filter(source => source.type === 'headbutt' && Number.isFinite(Number(source.expectedEncounters)))
    .sort((a, b) => Number(a.expectedEncounters) - Number(b.expectedEncounters));
  if (headbutt.length) {
    return {
      mode: 'headbutt-lower-bound',
      expectedEncounters: Number(headbutt[0].expectedEncounters),
      conditionalTreeGroup: true,
      source: headbutt[0],
    };
  }

  return {
    mode: 'unknown',
    expectedEncounters: null,
    source: null,
  };
}

function buildEncounterIndex(encounters) {
  return new Map(encounters.map(x => [x.map, x]));
}

function firstLinearLevelEvolution(speciesConst, evoByBase) {
  const evos = evoByBase.get(speciesConst) || [];
  const levelEvos = evos.filter(x => x.method === 'EVO_LEVEL' && Number.isFinite(Number(x.param)));
  return levelEvos.length === 1 ? levelEvos[0] : null;
}

function buildLevelEvolutionStages(speciesConst, availableFrom, bosses, evoByBase) {
  const transitions = [];
  let current = speciesConst;
  const seen = new Set([current]);
  while (true) {
    const evo = firstLinearLevelEvolution(current, evoByBase);
    if (!evo || seen.has(evo.target)) break;
    const nextBattle = bosses.find(
      boss => Number(boss.stage) >= Number(availableFrom) && boss.aceLevel >= Number(evo.param)
    );
    if (!nextBattle) break;
    const stage = Number(nextBattle.stage);
    transitions.push({
      stage,
      level: Number(evo.param),
      species: constantToName(evo.target, 'SPECIES_'),
      derived: 'level-evolution',
      reason: `level ${evo.param}`,
    });
    current = evo.target;
    seen.add(current);
  }
  return transitions;
}

function familyRoot(speciesConst, parentByTarget) {
  let current = speciesConst;
  const seen = new Set();
  while (parentByTarget.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parentByTarget.get(current);
  }
  return constantToName(current, 'SPECIES_');
}


function normalizeEvolutionPolicy(value) {
  const policy = String(value || 'level-only').toLowerCase();
  if (!['level-only', 'trade-aware'].includes(policy)) {
    throw new Error('evolutionPolicy must be level-only or trade-aware');
  }
  return policy;
}

function evolutionCheckpointIndex(bosses, source = {}) {
  if (source.beforeBoss) {
    const index = (bosses || []).findIndex(boss => String(boss.label) === String(source.beforeBoss));
    if (index >= 0) return index;
  }
  if (source.afterBoss) {
    const index = (bosses || []).findIndex(boss => String(boss.label) === String(source.afterBoss));
    if (index >= 0) return index + 1;
  }
  const stage = Number(source.availableFrom ?? 0);
  const index = (bosses || []).findIndex(boss => Number(boss.stage) >= stage);
  return index >= 0 ? index : (bosses || []).length;
}

function effectiveEvolutionItemAccess(baseAccess, earliest, personalRows, bosses) {
  const result = new Map();
  for (const [item, row] of Object.entries(baseAccess?.items || {})) {
    result.set(item, {
      item,
      availableFrom: Number(row.availableFrom),
      checkpointIndex: evolutionCheckpointIndex(bosses, row),
      beforeBoss: row.beforeBoss || null,
      afterBoss: row.afterBoss || null,
      repeatable: Boolean(row.repeatable),
      count: Math.max(1, Number(row.count || 1)),
      source: row.source || null,
      note: row.note || '',
    });
  }

  const personalBySpecies = new Map(
    (personalRows || []).map(row => [`SPECIES_${row.species}`, row])
  );
  for (const wild of earliest.values()) {
    const personal = personalBySpecies.get(wild.speciesConst);
    for (const item of personal?.items || []) {
      if (!item || item === 'ITEM_NONE') continue;
      const candidate = {
        item,
        availableFrom: Number(wild.availableFrom),
        checkpointIndex: evolutionCheckpointIndex(bosses, { availableFrom: wild.availableFrom }),
        repeatable: true,
        count: null,
        source: {
          type: 'wild-held',
          species: constantToName(wild.speciesConst, 'SPECIES_'),
          maps: (wild.sources || []).map(source => source.map).filter(Boolean),
        },
        note: 'Rare held-item probability is intentionally not penalized; legality only.',
      };
      const existing = result.get(item);
      if (
        !existing ||
        candidate.checkpointIndex < Number(existing.checkpointIndex) ||
        (
          candidate.checkpointIndex === Number(existing.checkpointIndex) &&
          candidate.repeatable && !existing.repeatable
        )
      ) {
        result.set(item, candidate);
      }
    }
  }
  return result;
}

const CONDITIONAL_LEVEL_EVOLUTION_METHODS = new Set([
  'EVO_LEVEL_ATK_EQ_DEF',
  'EVO_LEVEL_ATK_GT_DEF',
  'EVO_LEVEL_ATK_LT_DEF',
  'EVO_LEVEL_FEMALE',
  'EVO_LEVEL_MALE',
  'EVO_LEVEL_NINJASK',
  'EVO_LEVEL_PID_HI',
  'EVO_LEVEL_PID_LO',
  'EVO_LEVEL_SHEDINJA',
]);

function conditionalLevelEvolutionCondition(method) {
  const conditions = {
    EVO_LEVEL_ATK_EQ_DEF: 'atk=def',
    EVO_LEVEL_ATK_GT_DEF: 'atk>def',
    EVO_LEVEL_ATK_LT_DEF: 'atk<def',
    EVO_LEVEL_FEMALE: 'female',
    EVO_LEVEL_MALE: 'male',
    EVO_LEVEL_NINJASK: 'ninjask-branch',
    EVO_LEVEL_PID_HI: 'pid-high',
    EVO_LEVEL_PID_LO: 'pid-low',
    EVO_LEVEL_SHEDINJA: 'shedinja-branch',
  };
  return conditions[method] || null;
}

const FRIENDSHIP_EVOLUTION_METHODS = new Set([
  'EVO_FRIENDSHIP',
  'EVO_FRIENDSHIP_DAY',
  'EVO_FRIENDSHIP_NIGHT',
]);

function priorEvolutionLevel(entryLevelMax, transitions) {
  const entry = Number(entryLevelMax);
  if (!Number.isFinite(entry)) return null;
  let priorLevel = Math.max(1, Math.floor(entry));
  for (const transition of transitions || []) {
    if (
      transition?.derived === 'level-evolution' &&
      Number.isFinite(Number(transition.level))
    ) {
      priorLevel = Math.max(priorLevel, Number(transition.level));
    }
  }
  return priorLevel;
}

function nextLevelEvolutionTrigger(entryLevelMax, transitions) {
  const priorLevel = priorEvolutionLevel(entryLevelMax, transitions);
  if (!Number.isFinite(Number(priorLevel)) || priorLevel >= 100) return null;
  return priorLevel + 1;
}

function naturalMoveEvolutionLevel(fromSpecies, moveConst, entryLevelMax, transitions) {
  const priorLevel = priorEvolutionLevel(entryLevelMax, transitions);
  if (!Number.isFinite(Number(priorLevel))) return null;
  const species = GEN4_DEX.species.get(fromSpecies);
  const moveName = constantToName(moveConst, 'MOVE_');
  const move = GEN4_DEX.moves.get(moveName);
  if (!species.exists || !move.exists) return null;
  const learnset = GEN4_DEX.species.getLearnsetData(species.id).learnset || {};
  const levels = (learnset[move.id] || [])
    .map(source => /^4L(\d+)$/.exec(source))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .filter(level => Number.isFinite(level) && level > priorLevel)
    .sort((a, b) => a - b);
  return levels[0] ?? null;
}

function moveReminderCanTeachEvolutionMove(fromSpecies, moveConst, currentLevel) {
  const level = Number(currentLevel);
  if (!Number.isFinite(level)) return false;
  const species = GEN4_DEX.species.get(fromSpecies);
  const moveName = constantToName(moveConst, 'MOVE_');
  const move = GEN4_DEX.moves.get(moveName);
  if (!species.exists || !move.exists) return false;
  const learnset = GEN4_DEX.species.getLearnsetData(species.id).learnset || {};
  return (learnset[move.id] || []).some(source => {
    const match = /^4L(\d+)$/.exec(source);
    return match && Number(match[1]) <= level;
  });
}

const HELD_ITEM_LEVEL_EVOLUTION_METHODS = new Set([
  'EVO_ITEM_DAY',
  'EVO_ITEM_NIGHT',
]);

function evolutionTransitionFor(
  evo,
  fromConst,
  availableFrom,
  bosses,
  tradeUnlockStage,
  itemAccess,
  order,
  options = {},
) {
  const fromSpecies = constantToName(fromConst, 'SPECIES_');
  const targetSpecies = constantToName(evo.target, 'SPECIES_');
  if (
    (evo.method === 'EVO_LEVEL' || CONDITIONAL_LEVEL_EVOLUTION_METHODS.has(evo.method)) &&
    Number.isFinite(Number(evo.param))
  ) {
    const nextBattle = bosses.find(
      boss => Number(boss.stage) >= Number(availableFrom) && Number(boss.aceLevel) >= Number(evo.param)
    );
    const condition = conditionalLevelEvolutionCondition(evo.method);
    return {
      order,
      stage: Number(nextBattle?.stage ?? availableFrom),
      level: Number(evo.param),
      fromSpecies,
      species: targetSpecies,
      derived: 'level-evolution',
      evolutionMethod: evo.method,
      evolutionCondition: condition,
      reason: condition
        ? `level ${evo.param} + ${condition}`
        : `level ${evo.param}`,
    };
  }
  if (FRIENDSHIP_EVOLUTION_METHODS.has(evo.method)) {
    const triggerLevel = nextLevelEvolutionTrigger(
      options.entryLevelMax,
      options.priorTransitions,
    );
    if (!Number.isFinite(Number(triggerLevel))) return null;
    const condition = evo.method === 'EVO_FRIENDSHIP_DAY'
      ? 'friendship-day'
      : evo.method === 'EVO_FRIENDSHIP_NIGHT'
        ? 'friendship-night'
        : 'friendship';
    return {
      order,
      stage: Number(availableFrom || 0),
      level: Number(triggerLevel),
      fromSpecies,
      species: targetSpecies,
      derived: 'level-evolution',
      evolutionMethod: evo.method,
      evolutionCondition: condition,
      requiresLevelUp: true,
      reason: `${condition} + level-up (minimum level ${triggerLevel})`,
    };
  }
  if (evo.method === 'EVO_HAS_MOVE') {
    const triggerLevel = naturalMoveEvolutionLevel(
      fromSpecies,
      String(evo.param),
      options.entryLevelMax,
      options.priorTransitions,
    );
    if (triggerLevel != null && Number.isFinite(Number(triggerLevel))) {
      const nextBattle = bosses.find(
        boss => Number(boss.stage) >= Number(availableFrom) && Number(boss.aceLevel) >= Number(triggerLevel)
      );
      return {
        order,
        stage: Number(nextBattle?.stage ?? availableFrom),
        level: Number(triggerLevel),
        fromSpecies,
        species: targetSpecies,
        derived: 'level-evolution',
        evolutionMethod: evo.method,
        evolutionCondition: 'known-move-natural',
        requiredMove: String(evo.param),
        requiresLevelUp: true,
        reason: `learn ${evo.param} naturally at level ${triggerLevel} + evolve on that level-up`,
      };
    }

    const priorLevel = priorEvolutionLevel(
      options.entryLevelMax,
      options.priorTransitions,
    );
    const reminder = options.moveReminderAccess || null;
    if (
      reminder &&
      Number.isFinite(Number(reminder.availableFrom)) &&
      moveReminderCanTeachEvolutionMove(fromSpecies, String(evo.param), priorLevel)
    ) {
      const conditionStage = Math.max(
        Number(availableFrom || 0),
        Number(reminder.availableFrom),
      );
      return {
        order,
        stage: conditionStage,
        checkpointIndex: evolutionCheckpointIndex(bosses, { availableFrom: conditionStage }),
        fromSpecies,
        species: targetSpecies,
        derived: 'level-up-trigger-evolution',
        evolutionMethod: evo.method,
        evolutionCondition: 'known-move-reminder',
        requiredMove: String(evo.param),
        requiresLevelUp: true,
        requiresLevelUpAfterCheckpoint: true,
        conditionSource: reminder.source || null,
        reason: `relearn ${evo.param} once Move Reminder is available, then evolve on a subsequent level-up`,
      };
    }
    return null;
  }

  if (HELD_ITEM_LEVEL_EVOLUTION_METHODS.has(evo.method)) {
    const access = itemAccess.get(String(evo.param));
    if (!access || !Number.isFinite(Number(access.availableFrom))) return null;
    const acquisitionCheckpoint = evolutionCheckpointIndex(bosses, { availableFrom });
    const checkpointIndex = Math.max(
      Number(acquisitionCheckpoint),
      Number(access.checkpointIndex),
    );
    const condition = evo.method === 'EVO_ITEM_NIGHT' ? 'item-night' : 'item-day';
    return {
      order,
      stage: Math.max(Number(availableFrom || 0), Number(access.availableFrom)),
      checkpointIndex,
      fromSpecies,
      species: targetSpecies,
      derived: 'level-up-trigger-evolution',
      evolutionMethod: evo.method,
      evolutionCondition: condition,
      requiredItem: String(evo.param),
      itemRepeatable: Boolean(access.repeatable),
      itemSource: access.source || null,
      requiresLevelUp: true,
      requiresLevelUpAfterCheckpoint: true,
      reason: `hold ${evo.param} during ${condition === 'item-night' ? 'night' : 'day'} and level up after item access`,
    };
  }
  if (evo.method === 'EVO_TRADE') {
    return {
      order,
      stage: Math.max(Number(availableFrom || 0), Number(tradeUnlockStage || 0)),
      checkpointIndex: evolutionCheckpointIndex(bosses, {
        availableFrom: Math.max(Number(availableFrom || 0), Number(tradeUnlockStage || 0)),
      }),
      fromSpecies,
      species: targetSpecies,
      derived: 'trade-evolution',
      evolutionMethod: evo.method,
      requiredItem: null,
      reason: 'trade',
    };
  }
  if (evo.method === 'EVO_TRADE_ITEM') {
    const access = itemAccess.get(String(evo.param));
    if (!access || !Number.isFinite(Number(access.availableFrom))) return null;
    return {
      order,
      stage: Math.max(
        Number(availableFrom || 0),
        Number(tradeUnlockStage || 0),
        Number(access.availableFrom),
      ),
      checkpointIndex: Number(access.checkpointIndex),
      fromSpecies,
      species: targetSpecies,
      derived: 'trade-item-evolution',
      evolutionMethod: evo.method,
      requiredItem: String(evo.param),
      itemRepeatable: Boolean(access.repeatable),
      itemSource: access.source || null,
      reason: `trade holding ${evo.param}`,
    };
  }
  if (new Set(['EVO_STONE', 'EVO_STONE_MALE', 'EVO_STONE_FEMALE']).has(evo.method)) {
    const access = itemAccess.get(String(evo.param));
    if (!access || !Number.isFinite(Number(access.availableFrom))) return null;
    const acquisitionCheckpoint = evolutionCheckpointIndex(bosses, { availableFrom });
    const checkpointIndex = Math.max(
      Number(acquisitionCheckpoint),
      Number(access.checkpointIndex),
    );
    const condition = evo.method === 'EVO_STONE_MALE'
      ? 'male'
      : evo.method === 'EVO_STONE_FEMALE'
        ? 'female'
        : null;
    return {
      order,
      stage: Math.max(Number(availableFrom || 0), Number(access.availableFrom)),
      checkpointIndex,
      fromSpecies,
      species: targetSpecies,
      derived: 'stone-evolution',
      evolutionMethod: evo.method,
      evolutionCondition: condition,
      requiredItem: String(evo.param),
      itemRepeatable: Boolean(access.repeatable),
      itemSource: access.source || null,
      reason: condition
        ? `${condition} + use ${evo.param}`
        : `use ${evo.param}`,
    };
  }
  return null;
}

function buildTradeAwareEvolutionPaths(
  speciesConst,
  availableFrom,
  bosses,
  evoByBase,
  evolutionAccess,
  itemAccess,
  entryLevelMax,
  moveAccess = null,
) {
  const tradeUnlockStage = Number(evolutionAccess?.tradeUnlockStage || 0);

  function walk(currentConst, transitions, seen) {
    if (seen.has(currentConst) || transitions.length >= 8) return [transitions];
    const all = evoByBase.get(currentConst) || [];
    const levelEvos = all.filter(evo =>
      evo.method === 'EVO_LEVEL' && Number.isFinite(Number(evo.param))
    );
    const edges = [];
    // Preserve prior conservative behavior: only an unambiguous plain level
    // evolution is auto-followed. Conditional level branches are explicit
    // alternatives and remain distinct search variants.
    if (levelEvos.length === 1) edges.push(levelEvos[0]);
    for (const evo of all) {
      if (
        CONDITIONAL_LEVEL_EVOLUTION_METHODS.has(evo.method) ||
        evo.method === 'EVO_TRADE' ||
        evo.method === 'EVO_TRADE_ITEM' ||
        evo.method === 'EVO_STONE' ||
        evo.method === 'EVO_STONE_MALE' ||
        evo.method === 'EVO_STONE_FEMALE' ||
        FRIENDSHIP_EVOLUTION_METHODS.has(evo.method) ||
        HELD_ITEM_LEVEL_EVOLUTION_METHODS.has(evo.method) ||
        evo.method === 'EVO_HAS_MOVE'
      ) {
        edges.push(evo);
      }
    }

    const usable = edges
      .map(evo => ({
        evo,
        transition: evolutionTransitionFor(
          evo,
          currentConst,
          availableFrom,
          bosses,
          tradeUnlockStage,
          itemAccess,
          transitions.length,
          {
            entryLevelMax,
            priorTransitions: transitions,
            moveReminderAccess: moveAccess?.moveReminder || null,
          },
        ),
      }))
      .filter(row => row.transition);

    if (!usable.length) return [transitions];

    // If this species also has an unsupported branch (stone/friendship/etc.),
    // retain the prior conservative form as a distinct search variant instead
    // of forcing the trade branch.
    const supportedTargets = new Set(usable.map(row => String(row.evo.target)));
    const hasUnsupportedAlternative = all.some(evo => !supportedTargets.has(String(evo.target)));
    const output = hasUnsupportedAlternative ? [transitions] : [];
    for (const row of usable) {
      output.push(...walk(
        row.evo.target,
        [...transitions, row.transition],
        new Set([...seen, currentConst]),
      ));
    }
    return output;
  }

  return walk(speciesConst, [], new Set());
}

function expandTradeAwareCandidate(
  candidate,
  speciesConst,
  bosses,
  evoByBase,
  evolutionAccess,
  itemAccess,
  moveAccess = null,
) {
  const paths = buildTradeAwareEvolutionPaths(
    speciesConst,
    candidate.availableFrom,
    bosses,
    evoByBase,
    evolutionAccess,
    itemAccess,
    candidate.entryLevelMax,
    moveAccess,
  );
  return paths.map((path, index) => {
    const terminalSpecies = path.length ? path[path.length - 1].species : candidate.species;
    return {
      ...candidate,
      speciesByStage: path,
      evolutionPolicy: 'trade-aware',
      evolutionVariantId: terminalSpecies,
      terminalSpecies,
      searchKey: `${candidate.familyId || candidate.species}::${candidate.species}->${terminalSpecies}#${index + 1}`,
    };
  });
}

export async function buildCanonicalCandidatePool({
  commit,
  bosses,
  access,
  version = 'HEARTGOLD',
  evolutionPolicy = 'level-only',
  evolutionAccess = null,
  moveAccess = null,
}) {
  if (!['HEARTGOLD', 'SOULSILVER'].includes(version)) {
    throw new Error('version must be HEARTGOLD or SOULSILVER');
  }
  const resolvedEvolutionPolicy = normalizeEvolutionPolicy(evolutionPolicy);
  const [encounterJson, headbuttJson, evoJson, personalJson] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/arc/headbutt.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/evo.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/personal.json`),
  ]);
  const encounterByMap = buildEncounterIndex(encounterJson.encounters || []);
  const headbuttByMap = new Map((headbuttJson.tables || []).map(x => [x.Map, x]));
  const growthBySpecies = new Map((personalJson.baseStats || []).map(row => [
    `SPECIES_${row.species}`,
    row.growthRate,
  ]));
  const catchRateBySpecies = new Map((personalJson.baseStats || []).map(row => [
    `SPECIES_${row.species}`,
    Number(row.catchRate),
  ]));
  const evoByBase = new Map((evoJson.evoTable || []).map(x => [x.baseSpecies, x.evos || []]));
  const parentByTarget = new Map();
  for (const row of evoJson.evoTable || []) {
    for (const evo of row.evos || []) {
      if (!parentByTarget.has(evo.target)) parentByTarget.set(evo.target, row.baseSpecies);
    }
  }

  const earliest = new Map();
  const cumulativeMaps = new Set();
  const methods = Object.keys(access.methodUnlockStage || {}).filter(method => method !== 'headbutt');

  for (const stageDef of access.stages) {
    for (const map of stageDef.addMaps || []) cumulativeMaps.add(map);
    function addEncounterEntry(entry, source) {
      const speciesConst = entry.speciesConst;
      const existing = earliest.get(speciesConst);
      if (!existing) {
        earliest.set(speciesConst, {
          speciesConst,
          availableFrom: stageDef.stage,
          entryLevelMin: entry.minLevel,
          entryLevelMax: entry.maxLevel,
          sources: [source],
        });
        return;
      }
      if (existing.availableFrom !== stageDef.stage) return;
      if (Number.isFinite(entry.minLevel)) {
        existing.entryLevelMin = Number.isFinite(existing.entryLevelMin)
          ? Math.min(existing.entryLevelMin, entry.minLevel)
          : entry.minLevel;
      }
      if (Number.isFinite(entry.maxLevel)) {
        existing.entryLevelMax = Number.isFinite(existing.entryLevelMax)
          ? Math.max(existing.entryLevelMax, entry.maxLevel)
          : entry.maxLevel;
      }
      const key = `${source.map}:${source.method}`;
      if (!existing.sources.some(x => `${x.map}:${x.method}` === key)) {
        existing.sources.push(source);
      }
    }

    for (const map of cumulativeMaps) {
      const encounter = encounterByMap.get(map);
      if (encounter) {
        for (const method of methods) {
          if (stageDef.stage < Number(access.methodUnlockStage[method])) continue;
          for (const entry of methodEntries(encounter, method, version)) {
            addEncounterEntry(entry, {
              type: 'wild',
              map,
              method,
              minLevel: entry.minLevel,
              maxLevel: entry.maxLevel,
              encounterProbability: entry.encounterProbability,
              expectedEncounters: entry.expectedEncounters,
              encounterRate: entry.encounterRate,
              bestTime: entry.bestTime,
              levelDistribution: entry.levelDistribution || [],
            });
          }
        }
      }

      const headbuttUnlock = Number(access.methodUnlockStage?.headbutt ?? 99);
      if (stageDef.stage >= headbuttUnlock) {
        const table = headbuttByMap.get(map);
        for (const entry of headbuttEntries(table, version)) {
          addEncounterEntry(entry, {
            type: 'headbutt',
            map,
            method: 'headbutt',
            minLevel: entry.minLevel,
            maxLevel: entry.maxLevel,
            encounterProbability: entry.encounterProbability,
            expectedEncounters: entry.expectedEncounters,
            headbuttTreeGroup: entry.headbuttTreeGroup,
            conditionalTreeGroup: true,
            levelDistribution: entry.levelDistribution || [],
          });
        }
      }
    }
  }

  const evolutionItemAccess = effectiveEvolutionItemAccess(
    evolutionAccess,
    earliest,
    personalJson.baseStats || [],
    bosses,
  );

  const candidates = [];
  for (const row of earliest.values()) {
    candidates.push({
      species: constantToName(row.speciesConst, 'SPECIES_'),
      availableFrom: row.availableFrom,
      familyId: familyRoot(row.speciesConst, parentByTarget),
      growthRate: growthBySpecies.get(row.speciesConst) || null,
      catchRate: catchRateBySpecies.get(row.speciesConst) ?? null,
      captureSearch: bestCaptureSource(row.sources),
      entryLevelMin: row.entryLevelMin,
      entryLevelMax: row.entryLevelMax,
      speciesByStage: buildLevelEvolutionStages(row.speciesConst, row.availableFrom, bosses, evoByBase),
      sources: row.sources,
      _originSpeciesConst: row.speciesConst,
    });
  }

  for (const manual of access.manualAcquisitions || []) {
    const speciesConst = `SPECIES_${manual.species.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const existing = candidates.find(x => x.species === manual.species);
    const manualLevel = Number(manual.level);
    const enriched = {
      ...manual,
      joinBeforeBoss: manual.beforeBoss || null,
      familyId: familyRoot(speciesConst, parentByTarget),
      growthRate: growthBySpecies.get(speciesConst) || null,
      catchRate: catchRateBySpecies.get(speciesConst) ?? null,
      captureSearch: {
        mode: 'fixed-or-gift',
        expectedEncounters: 0,
        source: { type: manual.source, note: manual.note || '' },
      },
      entryLevelMin: Number.isFinite(manualLevel) ? manualLevel : null,
      entryLevelMax: Number.isFinite(manualLevel) ? manualLevel : null,
      speciesByStage: buildLevelEvolutionStages(speciesConst, manual.availableFrom, bosses, evoByBase),
      _originSpeciesConst: speciesConst,
      sources: [{
        type: manual.source,
        map: manual.map || null,
        note: manual.note || '',
        minLevel: Number.isFinite(manualLevel) ? manualLevel : null,
        maxLevel: Number.isFinite(manualLevel) ? manualLevel : null,
      }],
    };
    if (!existing || manual.availableFrom < existing.availableFrom) {
      if (existing) candidates.splice(candidates.indexOf(existing), 1);
      candidates.push(enriched);
    } else if (existing && manual.availableFrom === existing.availableFrom) {
      existing.sources.push(...enriched.sources);
      if (Number.isFinite(enriched.entryLevelMin)) {
        existing.entryLevelMin = Number.isFinite(existing.entryLevelMin)
          ? Math.min(existing.entryLevelMin, enriched.entryLevelMin)
          : enriched.entryLevelMin;
      }
      if (Number.isFinite(enriched.entryLevelMax)) {
        existing.entryLevelMax = Number.isFinite(existing.entryLevelMax)
          ? Math.max(existing.entryLevelMax, enriched.entryLevelMax)
          : enriched.entryLevelMax;
      }
      if (manual.exclusiveGroup) existing.exclusiveGroup = manual.exclusiveGroup;
      if (manual.beforeBoss) existing.joinBeforeBoss = manual.beforeBoss;
      existing.captureSearch = bestCaptureSource(existing.sources);
    }
  }

  if (resolvedEvolutionPolicy === 'trade-aware') {
    const expanded = candidates.flatMap(candidate =>
      expandTradeAwareCandidate(
        candidate,
        candidate._originSpeciesConst || `SPECIES_${candidate.species.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        bosses,
        evoByBase,
        evolutionAccess || {},
        evolutionItemAccess,
        moveAccess,
      )
    );
    candidates.splice(0, candidates.length, ...expanded);
  }

  candidates.sort((a, b) =>
    a.availableFrom - b.availableFrom ||
    a.familyId.localeCompare(b.familyId) ||
    String(a.searchKey || a.species).localeCompare(String(b.searchKey || b.species))
  );

  return {
    version,
    sourceCommit: commit,
    accessMode: access.mode,
    evolutionPolicy: resolvedEvolutionPolicy,
    evolutionAccess: {
      tradeUnlockStage: Number(evolutionAccess?.tradeUnlockStage || 0),
      items: Object.fromEntries(
        [...evolutionItemAccess.entries()].map(([item, row]) => [item, row])
      ),
    },
    notes: [
      'Wild availability is derived from pinned pret/pokeheartgold encounter data.',
      'Headbutt availability and encounter levels are derived from files/arc/headbutt.json once Headbutt is unlocked.',
      'Story-stage map access is curated in story-access.canonical.json.',
      resolvedEvolutionPolicy === 'trade-aware'
        ? 'Unambiguous EVO_LEVEL plus source-backed EVO_TRADE/EVO_TRADE_ITEM evolutions are applied; item trades wait for their earliest modeled item source.'
        : 'Only unambiguous EVO_LEVEL evolutions are auto-applied; friendship, stone, trade, move, and location evolutions remain conservative.',
      'Headbutt/static/gift exceptions are represented as manual acquisitions with provenance notes.',
      'Wild candidate entry-level ranges are derived from the same encounter slots and retained for catch-up/grinding metrics.',
      'Species growth rates are read from files/poketool/personal/personal.json for EXP-aware burden metrics.',
      'Standard wild capture-search cost uses original encounter-slot probabilities; weekday restrictions are intentionally not penalized.',
      'Headbutt expected encounters are a lower bound conditional on using the correct tree group.',
    ],
    candidates,
  };
}

export function validateCandidateTeam(team) {
  const exclusive = new Set();
  const families = new Set();
  for (const mon of team) {
    if (mon.exclusiveGroup) {
      if (exclusive.has(mon.exclusiveGroup)) return false;
      exclusive.add(mon.exclusiveGroup);
    }
    if (mon.familyId) {
      if (families.has(mon.familyId)) return false;
      families.add(mon.familyId);
    }
  }
  return true;
}
