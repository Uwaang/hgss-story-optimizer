import { constantToName, fetchText } from './hgss-data.mjs';

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
    } else {
      row.encounterProbability += probability;
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
    return {
      speciesConst: row.speciesConst,
      minLevel: row.minLevel,
      maxLevel: row.maxLevel,
      encounterProbability: row.encounterProbability,
      expectedEncounters: row.encounterProbability > 0 ? 100 / row.encounterProbability : null,
      encounterRate,
      bestTime: row.bestTime,
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

export async function buildCanonicalCandidatePool({
  commit,
  bosses,
  access,
  version = 'HEARTGOLD',
}) {
  if (!['HEARTGOLD', 'SOULSILVER'].includes(version)) {
    throw new Error('version must be HEARTGOLD or SOULSILVER');
  }
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
          });
        }
      }
    }
  }

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

  candidates.sort((a, b) =>
    a.availableFrom - b.availableFrom ||
    a.familyId.localeCompare(b.familyId) ||
    a.species.localeCompare(b.species)
  );

  return {
    version,
    sourceCommit: commit,
    accessMode: access.mode,
    notes: [
      'Wild availability is derived from pinned pret/pokeheartgold encounter data.',
      'Headbutt availability and encounter levels are derived from files/arc/headbutt.json once Headbutt is unlocked.',
      'Story-stage map access is curated in story-access.canonical.json.',
      'Only unambiguous EVO_LEVEL evolutions are auto-applied; friendship, stone, trade, move, and location evolutions remain conservative.',
      'Headbutt/static/gift exceptions are represented as manual acquisitions with provenance notes.',
      'Wild candidate entry-level ranges are derived from the same encounter slots and retained for catch-up/grinding metrics.',
      'Species growth rates are read from files/poketool/personal/personal.json for EXP-aware burden metrics.',
      'Standard wild capture-search cost uses original encounter-slot probabilities; weekday restrictions are intentionally not penalized.',
      'Headbutt expected encounters are a lower bound conditional on using the correct tree group.',
    ],
    candidates,
  };
}


const LEGENDARY_OR_MYTHICAL_SPECIES = new Set([
  'Articuno', 'Zapdos', 'Moltres', 'Mewtwo', 'Mew',
  'Raikou', 'Entei', 'Suicune', 'Lugia', 'Ho-Oh', 'Celebi',
  'Regirock', 'Regice', 'Registeel', 'Latias', 'Latios',
  'Kyogre', 'Groudon', 'Rayquaza', 'Jirachi', 'Deoxys',
  'Uxie', 'Mesprit', 'Azelf', 'Dialga', 'Palkia', 'Heatran',
  'Regigigas', 'Giratina', 'Cresselia', 'Phione', 'Manaphy',
  'Darkrai', 'Shaymin', 'Arceus',
]);

function levelRequirementForEvolution(evo) {
  const method = String(evo?.method || '');
  const raw = Number(evo?.param);
  if (method.startsWith('EVO_LEVEL') && Number.isFinite(raw) && raw > 0) return raw;
  return 1;
}

function evolutionAllowedInHgssRedExperiment(evo) {
  const method = String(evo?.method || '');
  // These methods name Diamond/Pearl/Platinum-only field mechanics in the
  // pinned HGSS evolution table. They cannot be triggered inside HGSS itself.
  // Trade, trade-item, stone, friendship, move, party-member, gender and
  // time-of-day evolutions remain allowed because this experiment ignores
  // route effort but still requires an HGSS-feasible species.
  return !new Set([
    'EVO_CORONET',
    'EVO_ETERNA',
    'EVO_ROUTE217',
    'EVO_BEAUTY',
  ]).has(method);
}

function manualSpeciesConstant(name) {
  const special = {
    "Farfetch'd": 'SPECIES_FARFETCHD',
    'Mr. Mime': 'SPECIES_MR_MIME',
    'Mime Jr.': 'SPECIES_MIME_JR',
    'Nidoran-F': 'SPECIES_NIDORAN_F',
    'Nidoran-M': 'SPECIES_NIDORAN_M',
    'Ho-Oh': 'SPECIES_HO_OH',
    'Porygon-Z': 'SPECIES_PORYGON_Z',
  };
  if (special[name]) return special[name];
  return 'SPECIES_' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export async function buildRedOnlyCandidateForms({
  commit,
  bosses,
  access,
  version = 'HEARTGOLD',
  targetBossLabel = 'Red',
  excludeLegendary = true,
}) {
  if (!['HEARTGOLD', 'SOULSILVER'].includes(version)) {
    throw new Error('version must be HEARTGOLD or SOULSILVER');
  }
  const targetBoss = (bosses || []).find(boss => boss.label === targetBossLabel);
  if (!targetBoss) throw new Error('Target boss not found: ' + targetBossLabel);
  const maxStage = Number(targetBoss.stage);

  const [encounterJson, headbuttJson, evoJson, personalJson] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/arc/headbutt.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/evo.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/personal.json`),
  ]);
  const encounterByMap = buildEncounterIndex(encounterJson.encounters || []);
  const headbuttByMap = new Map((headbuttJson.tables || []).map(row => [row.Map, row]));
  const growthBySpecies = new Map((personalJson.baseStats || []).map(row => [
    `SPECIES_${row.species}`,
    row.growthRate,
  ]));
  const evoByBase = new Map((evoJson.evoTable || []).map(row => [row.baseSpecies, row.evos || []]));
  const parentByTarget = new Map();
  for (const row of evoJson.evoTable || []) {
    for (const evo of row.evos || []) {
      if (evo.target && evo.target !== 'SPECIES_NONE' && !parentByTarget.has(evo.target)) {
        parentByTarget.set(evo.target, row.baseSpecies);
      }
    }
  }

  const directCaptureBySpecies = new Map();
  function addDirectCapture(speciesConst, option) {
    if (!speciesConst || speciesConst === 'SPECIES_NONE') return;
    const bucket = directCaptureBySpecies.get(speciesConst) || [];
    const key = [
      option.type || '',
      option.map || '',
      option.method || '',
      option.stage ?? '',
      option.minLevel ?? '',
      option.maxLevel ?? '',
      option.exclusiveGroup || '',
    ].join('|');
    if (!bucket.some(row => row._key === key)) bucket.push({ ...option, _key: key });
    directCaptureBySpecies.set(speciesConst, bucket);
  }

  const cumulativeMaps = new Set();
  const methods = Object.keys(access.methodUnlockStage || {}).filter(method => method !== 'headbutt');
  for (const stageDef of access.stages || []) {
    const stage = Number(stageDef.stage);
    if (stage > maxStage) break;
    for (const map of stageDef.addMaps || []) cumulativeMaps.add(map);

    for (const map of cumulativeMaps) {
      const encounter = encounterByMap.get(map);
      if (encounter) {
        for (const method of methods) {
          if (stage < Number(access.methodUnlockStage?.[method] ?? 99)) continue;
          for (const entry of methodEntries(encounter, method, version)) {
            addDirectCapture(entry.speciesConst, {
              type: 'wild',
              map,
              method,
              stage,
              minLevel: entry.minLevel,
              maxLevel: entry.maxLevel,
              encounterProbability: entry.encounterProbability,
              expectedEncounters: entry.expectedEncounters,
            });
          }
        }
      }

      const headbuttUnlock = Number(access.methodUnlockStage?.headbutt ?? 99);
      if (stage >= headbuttUnlock) {
        const table = headbuttByMap.get(map);
        for (const entry of headbuttEntries(table, version)) {
          addDirectCapture(entry.speciesConst, {
            type: 'headbutt',
            map,
            method: 'headbutt',
            stage,
            minLevel: entry.minLevel,
            maxLevel: entry.maxLevel,
            encounterProbability: entry.encounterProbability,
            expectedEncounters: entry.expectedEncounters,
          });
        }
      }
    }
  }

  for (const manual of access.manualAcquisitions || []) {
    if (Number(manual.availableFrom || 0) > maxStage) continue;
    const level = Number(manual.level);
    if (!Number.isFinite(level)) continue;
    addDirectCapture(manualSpeciesConstant(manual.species), {
      type: manual.source || 'manual',
      map: manual.map || null,
      method: manual.source || 'manual',
      stage: Number(manual.availableFrom || 0),
      minLevel: level,
      maxLevel: level,
      exclusiveGroup: manual.exclusiveGroup || null,
      note: manual.note || null,
    });
  }

  const formMap = new Map();
  function recordReachableForm(captureSpeciesConst, captureOption, targetSpeciesConst, evolutionMinLevel, path) {
    const targetName = constantToName(targetSpeciesConst, 'SPECIES_');
    const rootName = familyRoot(targetSpeciesConst, parentByTarget);
    if (
      excludeLegendary &&
      (LEGENDARY_OR_MYTHICAL_SPECIES.has(targetName) || LEGENDARY_OR_MYTHICAL_SPECIES.has(rootName))
    ) {
      return;
    }
    const key = `${rootName}|${targetName}`;
    const row = formMap.get(key) || {
      species: targetName,
      familyId: rootName,
      growthRate: growthBySpecies.get(targetSpeciesConst) || growthBySpecies.get(captureSpeciesConst) || null,
      availableFrom: 0,
      exclusiveGroup: null,
      redCaptureOptions: [],
      evolutionPaths: [],
    };
    if (captureOption.exclusiveGroup === 'starter') row.exclusiveGroup = 'starter';
    row.redCaptureOptions.push({
      captureSpecies: constantToName(captureSpeciesConst, 'SPECIES_'),
      targetSpecies: targetName,
      evolutionMinLevel,
      path: path.map(speciesConst => constantToName(speciesConst, 'SPECIES_')),
      type: captureOption.type,
      map: captureOption.map,
      method: captureOption.method,
      stage: captureOption.stage,
      minLevel: captureOption.minLevel,
      maxLevel: captureOption.maxLevel,
      encounterProbability: captureOption.encounterProbability ?? null,
      expectedEncounters: captureOption.expectedEncounters ?? null,
    });
    row.evolutionPaths.push({
      captureSpecies: constantToName(captureSpeciesConst, 'SPECIES_'),
      targetSpecies: targetName,
      minLevel: evolutionMinLevel,
      path: path.map(speciesConst => constantToName(speciesConst, 'SPECIES_')),
    });
    formMap.set(key, row);
  }

  for (const [captureSpeciesConst, captureOptions] of directCaptureBySpecies.entries()) {
    for (const captureOption of captureOptions) {
      const queue = [{
        speciesConst: captureSpeciesConst,
        evolutionMinLevel: 1,
        path: [captureSpeciesConst],
      }];
      const bestThreshold = new Map();

      while (queue.length) {
        const current = queue.shift();
        const prior = bestThreshold.get(current.speciesConst);
        if (prior !== undefined && prior <= current.evolutionMinLevel) continue;
        bestThreshold.set(current.speciesConst, current.evolutionMinLevel);
        recordReachableForm(
          captureSpeciesConst,
          captureOption,
          current.speciesConst,
          current.evolutionMinLevel,
          current.path,
        );

        for (const evo of evoByBase.get(current.speciesConst) || []) {
          if (!evo.target || evo.target === 'SPECIES_NONE') continue;
          if (!evolutionAllowedInHgssRedExperiment(evo)) continue;
          if (current.path.includes(evo.target)) continue;
          const requiredLevel = levelRequirementForEvolution(evo);
          queue.push({
            speciesConst: evo.target,
            evolutionMinLevel: Math.max(current.evolutionMinLevel, requiredLevel),
            path: [...current.path, evo.target],
          });
        }
      }
    }
  }

  const forms = [...formMap.values()].map(row => {
    const options = row.redCaptureOptions
      .filter(option =>
        Number.isFinite(Number(option.minLevel)) &&
        Number.isFinite(Number(option.maxLevel))
      )
      .sort((a, b) =>
        Number(b.maxLevel) - Number(a.maxLevel) ||
        Number(a.evolutionMinLevel) - Number(b.evolutionMinLevel) ||
        String(a.captureSpecies).localeCompare(String(b.captureSpecies))
      );
    const entryLevelMin = options.length
      ? Math.min(...options.map(option => Number(option.minLevel)))
      : null;
    const entryLevelMax = options.length
      ? Math.max(...options.map(option => Number(option.maxLevel)))
      : null;
    return {
      ...row,
      entryLevelMin,
      entryLevelMax,
      redCaptureOptions: options,
      evolutionPaths: row.evolutionPaths
        .sort((a, b) =>
          Number(a.minLevel) - Number(b.minLevel) ||
          a.captureSpecies.localeCompare(b.captureSpecies)
        ),
    };
  }).filter(row => row.redCaptureOptions.length && row.growthRate);

  forms.sort((a, b) =>
    a.familyId.localeCompare(b.familyId) ||
    a.species.localeCompare(b.species)
  );

  return {
    version,
    targetBoss: targetBoss.label,
    targetStage: maxStage,
    excludeLegendary,
    forms,
    familyCount: new Set(forms.map(row => row.familyId)).size,
    notes: [
      'Capture options include every source-backed wild/headbutt/manual level available by Red, not only the earliest story source.',
      'For a requested common level, the search may use the highest legal capture level at or below that common level.',
      'Trade/stone/friendship and other HGSS-feasible non-level evolutions are treated as feasible without extra EXP cost; level evolutions still require their level threshold. DPPt-only field evolutions (magnetic field, Moss/Ice Rock, Beauty) are excluded.',
      'Legendary and mythical species are excluded by a curated Gen 1-4 set when excludeLegendary=true.',
    ],
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
