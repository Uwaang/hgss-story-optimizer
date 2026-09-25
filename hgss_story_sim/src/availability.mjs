import { constantToName, fetchText } from './hgss-data.mjs';

const RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';

function rawUrl(commit, path) {
  return `${RAW_ROOT}/${commit}/${path}`;
}

async function fetchJson(commit, path) {
  return JSON.parse(await fetchText(rawUrl(commit, path)));
}

function containsToken(value, token) {
  if (typeof value === 'string') return value === token;
  if (Array.isArray(value)) return value.some(item => containsToken(item, token));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsToken(item, token));
  return false;
}

export async function loadPretAvailabilityData(commit) {
  const [encounters, headbutt, evolutions] = await Promise.all([
    fetchJson(commit, 'files/fielddata/encountdata/gs_enc_data.json'),
    fetchJson(commit, 'files/arc/headbutt.json'),
    fetchJson(commit, 'files/poketool/personal/evo.json'),
  ]);
  return {
    commit,
    encounters: encounters.encounters || [],
    headbutt: headbutt.tables || [],
    evolutions: evolutions.evoTable || [],
  };
}

function encounterSection(entry, method) {
  if (method === 'land') return entry.land;
  if (method === 'surf') return entry.surf;
  if (method === 'rock_smash') return entry.rock_smash;
  if (method === 'old_rod') return entry.fishing?.old_rod;
  if (method === 'good_rod') return entry.fishing?.good_rod;
  if (method === 'super_rod') return entry.fishing?.super_rod;
  throw new Error(`Unsupported encounter method: ${method}`);
}

async function validateSourceDefinition(source, data, commit) {
  if (source.type === 'wild') {
    const entry = data.encounters.find(item => item.map === source.map);
    if (!entry) return { ok: false, reason: `encounter map not found: ${source.map}` };
    const section = encounterSection(entry, source.method);
    if (!section || !containsToken(section, source.species)) {
      return { ok: false, reason: `${source.species} not found in ${source.map}/${source.method}` };
    }
    return { ok: true };
  }

  if (source.type === 'headbutt') {
    const table = data.headbutt.find(item => item.Map === source.map);
    if (!table) return { ok: false, reason: `headbutt map not found: ${source.map}` };
    if (!containsToken(table, source.species)) {
      return { ok: false, reason: `${source.species} not found in headbutt table ${source.map}` };
    }
    return { ok: true };
  }

  if (source.type === 'script') {
    const text = await fetchText(rawUrl(commit, source.path));
    if (!text.includes(source.token)) {
      return { ok: false, reason: `${source.token} not found in ${source.path}` };
    }
    for (const requiredToken of source.requiredTokens || []) {
      if (!text.includes(requiredToken)) {
        return { ok: false, reason: `${requiredToken} not found in ${source.path}` };
      }
    }
    return { ok: true };
  }

  return { ok: false, reason: `unsupported source type: ${source.type}` };
}

export async function validateAndResolveCandidates(candidates, accessConfig, data, commit) {
  const rows = [];
  const resolved = [];
  const sourceDefs = accessConfig.sources || {};

  for (const candidate of candidates) {
    const source = sourceDefs[candidate.source];
    if (!source) {
      rows.push({ species: candidate.species, source: candidate.source, ok: false, reason: 'source id not found' });
      continue;
    }
    const check = await validateSourceDefinition(source, data, commit);
    rows.push({
      species: candidate.species,
      source: candidate.source,
      availableFrom: source.availableFrom,
      ...check,
    });
    if (check.ok) {
      resolved.push({
        ...candidate,
        availableFrom: Number(source.availableFrom),
        sourceEvidence: {
          id: candidate.source,
          type: source.type,
          map: source.map,
          method: source.method,
          path: source.path,
          requirements: source.requirements || [],
        },
      });
    }
  }

  return {
    ok: rows.every(row => row.ok),
    rows,
    candidates: resolved,
  };
}

function speciesConstantFromName(name) {
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
  return 'SPECIES_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function levelEvolutionFor(evoBySpecies, speciesConst, level) {
  const row = evoBySpecies.get(speciesConst);
  if (!row) return null;
  const candidates = (row.evos || []).filter(evo =>
    ['EVO_LEVEL', 'EVO_LEVEL_MALE', 'EVO_LEVEL_FEMALE'].includes(evo.method) &&
    Number(evo.param) <= level
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(a.param) - Number(b.param));
  return candidates[0];
}

export function deriveLevelEvolutionStages(candidates, bosses, evolutionRows) {
  const evoBySpecies = new Map(evolutionRows.map(row => [row.baseSpecies, row]));

  return candidates.map(candidate => {
    const manualTransitions = Array.isArray(candidate.speciesByStage) ? [...candidate.speciesByStage] : [];
    const transitions = [];
    let currentConst = speciesConstantFromName(candidate.species);

    for (const boss of bosses) {
      if (boss.stage < Number(candidate.availableFrom || 0)) continue;
      let changed = false;
      for (;;) {
        const evo = levelEvolutionFor(evoBySpecies, currentConst, boss.aceLevel);
        if (!evo) break;
        currentConst = evo.target;
        changed = true;
      }
      if (changed) {
        transitions.push({
          stage: boss.stage,
          level: Number(evo?.param || boss.aceLevel),
          species: constantToName(currentConst, 'SPECIES_'),
          derived: 'level-evolution',
        });
      }
    }

    const merged = new Map();
    for (const transition of transitions) merged.set(Number(transition.stage), transition);
    for (const transition of manualTransitions) merged.set(Number(transition.stage), transition);

    return {
      ...candidate,
      speciesByStage: [...merged.values()].sort((a, b) => Number(a.stage) - Number(b.stage)),
    };
  });
}

export function teamRespectsExclusiveGroups(team) {
  const seen = new Set();
  for (const candidate of team) {
    if (!candidate.exclusiveGroup) continue;
    if (seen.has(candidate.exclusiveGroup)) return false;
    seen.add(candidate.exclusiveGroup);
  }
  return true;
}
