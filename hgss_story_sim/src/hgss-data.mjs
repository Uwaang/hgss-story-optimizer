const DEFAULT_PRET_COMMIT = '9d8b7591f09b65804da2fb2dfd56f320633e0d36';
const PRET_RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';

export function pretUrls(commit = DEFAULT_PRET_COMMIT) {
  return {
    trainers: `${PRET_RAW_ROOT}/${commit}/files/poketool/trainer/trainers.json`,
    trainerConstants: `${PRET_RAW_ROOT}/${commit}/include/constants/trainers.h`,
  };
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'hgss-story-sim/0.1' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

export function parseTrainerConstants(headerText) {
  const result = new Map();
  const define = /^#define\s+(TRAINER_[A-Z0-9_]+)\s+(\d+)\s*$/gm;
  for (const match of headerText.matchAll(define)) {
    result.set(match[1], Number(match[2]));
  }
  return result;
}

export async function loadPretTrainerData(commit = DEFAULT_PRET_COMMIT) {
  const urls = pretUrls(commit);
  const [trainerJsonText, constantsText] = await Promise.all([
    fetchText(urls.trainers),
    fetchText(urls.trainerConstants),
  ]);
  const trainerJson = JSON.parse(trainerJsonText);
  if (!Array.isArray(trainerJson.trainers)) {
    throw new Error('Unexpected pret/pokeheartgold trainers.json schema');
  }
  return {
    commit,
    trainers: trainerJson.trainers,
    constants: parseTrainerConstants(constantsText),
  };
}

export function extractBosses(source, bossConfig) {
  return bossConfig.bosses.map((boss, stage) => {
    const trainerId = source.constants.get(boss.key);
    if (trainerId === undefined) {
      throw new Error(`Trainer constant not found: ${boss.key}`);
    }
    const trainer = source.trainers[trainerId];
    if (!trainer) {
      throw new Error(`Trainer id ${trainerId} (${boss.key}) is outside trainers.json`);
    }
    const aceLevel = Math.max(...trainer.party.map(mon => mon.level));
    return {
      stage,
      key: boss.key,
      label: boss.label,
      trainerId,
      aceLevel,
      trainer,
    };
  });
}

export function constantToName(value, prefix) {
  if (!value) return '';
  if (value === `${prefix}NONE`) return '';
  const token = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const special = {
    FARFETCHD: "Farfetch'd",
    MR_MIME: 'Mr. Mime',
    MIME_JR: 'Mime Jr.',
    NIDORAN_F: 'Nidoran-F',
    NIDORAN_M: 'Nidoran-M',
    HO_OH: 'Ho-Oh',
    PORYGON_Z: 'Porygon-Z',
    U_TURN: 'U-turn',
    X_SCISSOR: 'X-Scissor',
    WILL_O_WISP: 'Will-O-Wisp',
  };
  if (special[token]) return special[token];
  return token
    .toLowerCase()
    .split('_')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

export function npcIvFromDifficulty(difficulty) {
  return Math.floor((Number(difficulty || 0) * 31) / 255);
}
