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

function methodSpecies(encounter, method, version) {
  if (method === 'land') return speciesValues(encounter.land?.mons?.map(x => x.species) || [], version);
  if (method === 'surf') return speciesValues(encounter.surf?.mons?.map(x => x.species) || [], version);
  if (method === 'rock_smash') return speciesValues(encounter.rock_smash?.mons?.map(x => x.species) || [], version);
  const rod = encounter.fishing?.[method];
  if (rod) return speciesValues(rod.mons?.map(x => x.species) || [], version);
  return [];
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
  const [encounterJson, evoJson] = await Promise.all([
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/fielddata/encountdata/gs_enc_data.json`),
    fetchJson(`${PRET_RAW_ROOT}/${commit}/files/poketool/personal/evo.json`),
  ]);
  const encounterByMap = buildEncounterIndex(encounterJson.encounters || []);
  const evoByBase = new Map((evoJson.evoTable || []).map(x => [x.baseSpecies, x.evos || []]));
  const parentByTarget = new Map();
  for (const row of evoJson.evoTable || []) {
    for (const evo of row.evos || []) {
      if (!parentByTarget.has(evo.target)) parentByTarget.set(evo.target, row.baseSpecies);
    }
  }

  const earliest = new Map();
  const cumulativeMaps = new Set();
  const methods = Object.keys(access.methodUnlockStage || {});

  for (const stageDef of access.stages) {
    for (const map of stageDef.addMaps || []) cumulativeMaps.add(map);
    for (const map of cumulativeMaps) {
      const encounter = encounterByMap.get(map);
      if (!encounter) continue;
      for (const method of methods) {
        if (stageDef.stage < Number(access.methodUnlockStage[method])) continue;
        for (const speciesConst of methodSpecies(encounter, method, version)) {
          const existing = earliest.get(speciesConst);
          if (!existing) {
            earliest.set(speciesConst, {
              speciesConst,
              availableFrom: stageDef.stage,
              sources: [{ type: 'wild', map, method }],
            });
          } else if (existing.availableFrom === stageDef.stage) {
            const key = `${map}:${method}`;
            if (!existing.sources.some(x => `${x.map}:${x.method}` === key)) {
              existing.sources.push({ type: 'wild', map, method });
            }
          }
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
      speciesByStage: buildLevelEvolutionStages(row.speciesConst, row.availableFrom, bosses, evoByBase),
      sources: row.sources,
    });
  }

  for (const manual of access.manualAcquisitions || []) {
    const speciesConst = `SPECIES_${manual.species.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const existing = candidates.find(x => x.species === manual.species);
    const enriched = {
      ...manual,
      familyId: familyRoot(speciesConst, parentByTarget),
      speciesByStage: buildLevelEvolutionStages(speciesConst, manual.availableFrom, bosses, evoByBase),
      sources: [{ type: manual.source, note: manual.note || '' }],
    };
    if (!existing || manual.availableFrom < existing.availableFrom) {
      if (existing) candidates.splice(candidates.indexOf(existing), 1);
      candidates.push(enriched);
    } else if (existing && manual.availableFrom === existing.availableFrom) {
      existing.sources.push(...enriched.sources);
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
      'Story-stage map access is curated in story-access.canonical.json.',
      'Only unambiguous EVO_LEVEL evolutions are auto-applied; friendship, stone, trade, move, and location evolutions remain conservative.',
      'Headbutt/static/gift exceptions are represented as manual acquisitions with provenance notes.',
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
