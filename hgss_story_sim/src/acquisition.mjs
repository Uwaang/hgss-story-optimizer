import { constantToName, fetchText } from './hgss-data.mjs';

const PRET_RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';

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

function levelRange(level) {
  if (Number.isFinite(Number(level))) {
    const value = Number(level);
    return { min: value, max: value };
  }
  if (level && typeof level === 'object') {
    const min = Number(level.min);
    const max = Number(level.max);
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

function methodEntries(encounter, method, version) {
  const out = [];
  for (const mon of methodMons(encounter, method)) {
    const range = levelRange(mon.level);
    const species = [...new Set(speciesValues(mon.species, version))];
    for (const speciesConst of species) {
      out.push({
        speciesConst,
        minLevel: range.min,
        maxLevel: range.max,
      });
    }
  }
  return out;
}

function headbuttEntries(table, version) {
  const out = [];
  const slots = [
    ...(table?.CommonMons || []),
    ...(table?.RareMons || []),
    ...(table?.SecretMons || []),
  ];
  for (const slot of slots) {
    const species = [...new Set(speciesValues(slot.species, version))];
    for (const speciesConst of species) {
      out.push({
        speciesConst,
        minLevel: Number.isFinite(Number(slot.minLevel)) ? Number(slot.minLevel) : null,
        maxLevel: Number.isFinite(Number(slot.maxLevel)) ? Number(slot.maxLevel) : null,
      });
    }
  }
  return out;
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
    const stage = bosses.findIndex((boss, idx) => idx >= availableFrom && boss.aceLevel >= Number(evo.param));
    if (stage < 0) break;
    transitions.push({
      stage,
      species: constantToName(evo.target, 'SPECIES_'),
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
  const [encounterJson, headbuttJson, evoJson] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/arc/headbutt.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/evo.json`),
  ]);
  const encounterByMap = buildEncounterIndex(encounterJson.encounters || []);
  const headbuttByMap = new Map((headbuttJson.tables || []).map(x => [x.Map, x]));
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
      familyId: familyRoot(speciesConst, parentByTarget),
      entryLevelMin: Number.isFinite(manualLevel) ? manualLevel : null,
      entryLevelMax: Number.isFinite(manualLevel) ? manualLevel : null,
      speciesByStage: buildLevelEvolutionStages(speciesConst, manual.availableFrom, bosses, evoByBase),
      sources: [{
        type: manual.source,
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
