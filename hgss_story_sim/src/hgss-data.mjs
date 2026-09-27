import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_PRET_COMMIT = '9d8b7591f09b65804da2fb2dfd56f320633e0d36';
const PRET_RAW_ROOT = 'https://raw.githubusercontent.com/pret/pokeheartgold';

export function pretUrls(commit = DEFAULT_PRET_COMMIT) {
  return {
    trainers: `${PRET_RAW_ROOT}/${commit}/files/poketool/trainer/trainers.json`,
    trainerConstants: `${PRET_RAW_ROOT}/${commit}/include/constants/trainers.h`,
    trainerClassConstants: `${PRET_RAW_ROOT}/${commit}/include/constants/trainer_class.h`,
    trainerDataSource: `${PRET_RAW_ROOT}/${commit}/src/trainer_data.c`,
  };
}

function sourceCachePath(url) {
  const root = String(process.env.HGSS_SOURCE_CACHE_DIR || '').trim();
  if (!root) return null;
  const text = String(url || '');
  if (!text.startsWith('https://raw.githubusercontent.com/pret/pokeheartgold/')) return null;
  const hash = createHash('sha256').update(text).digest('hex');
  return path.join(root, hash.slice(0, 2), hash + '.txt');
}

export async function fetchText(url) {
  const cachePath = sourceCachePath(url);
  if (cachePath) {
    try {
      return await fs.readFile(cachePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const headers = { 'user-agent': 'hgss-story-sim/0.1' };
  if (process.env.GITHUB_TOKEN && String(url).startsWith('https://api.github.com/')) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    headers.accept = 'application/vnd.github+json';
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  const text = await response.text();

  if (cachePath) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    try {
      await fs.writeFile(cachePath, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return text;
}

export function parseTrainerConstants(headerText) {
  const result = new Map();
  const define = /^#define\s+(TRAINER_[A-Z0-9_]+)\s+(\d+)\s*$/gm;
  for (const match of headerText.matchAll(define)) {
    result.set(match[1], Number(match[2]));
  }
  return result;
}

export function parseTrainerClassConstants(headerText) {
  const result = new Map();
  const define = /^#define\s+(TRAINERCLASS_[A-Z0-9_]+)\s+(\d+)\s*$/gm;
  for (const match of headerText.matchAll(define)) {
    result.set(match[1], Number(match[2]));
  }
  return result;
}

export function parseTrainerGenders(sourceText) {
  const result = new Map();
  const start = sourceText.indexOf('static const u8 sTrainerGenders[] = {');
  if (start < 0) return result;
  const end = sourceText.indexOf('};', start);
  const block = end >= 0 ? sourceText.slice(start, end) : sourceText.slice(start);
  const row = /\b(TRAINER_MALE|TRAINER_FEMALE|TRAINER_DOUBLE),\s*\/\/\s*(TRAINERCLASS_[A-Z0-9_]+)/g;
  for (const match of block.matchAll(row)) {
    result.set(match[2], match[1]);
  }
  return result;
}

export async function loadPretTrainerData(commit = DEFAULT_PRET_COMMIT) {
  const urls = pretUrls(commit);
  const [trainerJsonText, constantsText, classConstantsText, trainerDataText] = await Promise.all([
    fetchText(urls.trainers),
    fetchText(urls.trainerConstants),
    fetchText(urls.trainerClassConstants),
    fetchText(urls.trainerDataSource),
  ]);
  const trainerJson = JSON.parse(trainerJsonText);
  if (!Array.isArray(trainerJson.trainers)) {
    throw new Error('Unexpected pret/pokeheartgold trainers.json schema');
  }
  return {
    commit,
    trainers: trainerJson.trainers,
    constants: parseTrainerConstants(constantsText),
    trainerClasses: parseTrainerClassConstants(classConstantsText),
    trainerGenders: parseTrainerGenders(trainerDataText),
  };
}

export function extractBosses(source, bossConfig) {
  return bossConfig.bosses.map((boss, index) => {
    const stage = Number.isInteger(boss.stage) ? boss.stage : index;
    const trainerId = source.constants.get(boss.key);
    if (trainerId === undefined) {
      throw new Error(`Trainer constant not found: ${boss.key}`);
    }
    const trainer = source.trainers[trainerId];
    if (!trainer) {
      throw new Error(`Trainer id ${trainerId} (${boss.key}) is outside trainers.json`);
    }
    const aceLevel = Math.max(...trainer.party.map(mon => mon.level));
    const trainerClassId = source.trainerClasses.get(trainer.class);
    if (trainerClassId === undefined) {
      throw new Error(`Trainer class constant not found: ${trainer.class}`);
    }
    const trainerGender = source.trainerGenders.get(trainer.class) || 'TRAINER_MALE';
    return {
      stage,
      key: boss.key,
      label: boss.label,
      kind: boss.kind || 'boss',
      sourceRef: boss.sourceRef || null,
      appliesToStarter: boss.appliesToStarter || null,
      trainerId,
      trainerClassId,
      trainerGender,
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
