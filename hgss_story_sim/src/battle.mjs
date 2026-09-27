import Showdown from 'pokemon-showdown';
const { BattleStream, Dex, Teams, getPlayerStreams } = Showdown;
import { constantToName, npcIvFromDifficulty } from './hgss-data.mjs';
import { chooseHgssMoveIndex, chooseHgssPostKoSwitch, chooseHgssTrainerItem, chooseHgssVoluntarySwitch, trainerAiProfile } from './trainer-ai.mjs';

const dex = Dex.mod('gen4');
const NEUTRAL_NATURE = 'Serious';
const NATURES_BY_ID = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

function uniformIvs(iv) {
  return { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv };
}

function lcrandom(seed) {
  const next = (Math.imul(seed >>> 0, 1103515245) + 24691) >>> 0;
  return { state: next, value: next >>> 16 };
}

function genderRatioByte(species) {
  if (species.gender === 'M') return 0;
  if (species.gender === 'F') return 254;
  if (species.gender === 'N') return 255;
  const female = species.genderRatio?.F;
  if (typeof female === 'number') return Math.floor(female * 254.75);
  return 127;
}

function pidSelector(mon, species, trainerGender) {
  let selector = trainerGender === 'TRAINER_FEMALE' ? 0x78 : 0x88;
  if (mon.genderOverride === 'TRPOKE_GENDER_OVERRIDE_MALE') {
    selector = (genderRatioByte(species) + 2) & 0xff;
  } else if (mon.genderOverride === 'TRPOKE_GENDER_OVERRIDE_FEMALE') {
    selector = (genderRatioByte(species) - 2) & 0xff;
  }
  if (mon.abilityOverride === 'TRPOKE_ABILITY_OVERRIDE_FIRST') selector &= ~1;
  if (mon.abilityOverride === 'TRPOKE_ABILITY_OVERRIDE_SECOND') selector |= 1;
  return selector & 0xff;
}

export function npcPersonality(mon, species, trainerMeta) {
  const trainerId = Number(trainerMeta.trainerId);
  const trainerClassId = Number(trainerMeta.trainerClassId);
  if (!Number.isInteger(trainerId) || !Number.isInteger(trainerClassId)) {
    throw new Error('trainerId and trainerClassId are required for exact HGSS NPC personality generation');
  }
  let personality = (Number(mon.difficulty || 0) + Number(mon.level) + Number(species.num) + trainerId) >>> 0;
  let state = personality;
  for (let i = 0; i < trainerClassId; i += 1) {
    const step = lcrandom(state);
    state = step.state;
    personality = step.value;
  }
  return (((personality << 8) >>> 0) + pidSelector(mon, species, trainerMeta.trainerGender)) >>> 0;
}

function natureFromPersonality(personality) {
  return NATURES_BY_ID[personality % 25];
}

function chooseAbility(species, override = 'TRPOKE_ABILITY_OVERRIDE_OFF', personality = 0) {
  if (override === 'TRPOKE_ABILITY_OVERRIDE_SECOND') {
    return species.abilities['1'] || species.abilities['0'];
  }
  if (species.abilities['1'] && (personality & 1)) return species.abilities['1'];
  return species.abilities['0'];
}

function levelUpMoveEntries(speciesName, level) {
  const species = dex.species.get(speciesName);
  if (!species.exists) throw new Error(`Unknown Gen 4 species: ${speciesName}`);
  const data = dex.species.getLearnsetData(species.id);
  const learned = [];
  for (const [moveId, sources] of Object.entries(data.learnset || {})) {
    let bestLevel = null;
    for (const source of sources) {
      const match = /^4L(\d+)/.exec(source);
      if (!match) continue;
      const learnedAt = Number(match[1]);
      if (learnedAt <= level && (bestLevel === null || learnedAt > bestLevel)) {
        bestLevel = learnedAt;
      }
    }
    if (bestLevel !== null) learned.push({ moveId, learnedAt: bestLevel });
  }
  learned.sort((a, b) => a.learnedAt - b.learnedAt || a.moveId.localeCompare(b.moveId));
  const unique = [];
  for (const entry of learned) {
    const moveName = dex.moves.get(entry.moveId).name;
    const existing = unique.findIndex(x => x.name === moveName);
    if (existing >= 0) unique.splice(existing, 1);
    unique.push({ name: moveName, level: entry.learnedAt });
  }
  return unique;
}

export function levelUpMoves(speciesName, level) {
  return levelUpMoveEntries(speciesName, level).slice(-4).map(x => x.name);
}

export function levelUpMovePool(speciesName, level) {
  return levelUpMoveEntries(speciesName, level).map(x => x.name);
}

function canLearnGen4Machine(species, moveName) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return false;
  const learnset = dex.species.getLearnsetData(species.id).learnset || {};
  return (learnset[move.id] || []).some(source => /^4M/.test(source));
}

function canLearnGen4Tutor(species, moveName) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return false;
  const learnset = dex.species.getLearnsetData(species.id).learnset || {};
  return (learnset[move.id] || []).some(source => /^4T/.test(source));
}

function effectiveMovePower(move) {
  if (typeof move.damage === 'number') return move.damage;
  let power = Math.max(move.basePower || 0, 1);

  if (Array.isArray(move.multihit)) {
    const [minHits, maxHits] = move.multihit.map(Number);
    // In the classic 2-5 hit distribution, the expectation is ~3 hits.
    const expectedHits = minHits === 2 && maxHits === 5
      ? 3
      : (minHits + maxHits) / 2;
    power *= expectedHits;
  } else if (Number.isFinite(Number(move.multihit))) {
    power *= Number(move.multihit);
  }

  return power;
}

function moveStrategicMultiplier(move) {
  let multiplier = 1;

  if (move.self?.volatileStatus === 'mustrecharge') multiplier *= 0.45;
  if (move.flags?.charge) multiplier *= 0.45;
  if (move.selfdestruct) multiplier *= 0.42;
  if (move.id === 'focuspunch') multiplier *= 0.18;
  if (move.id === 'lastresort') multiplier *= 0.18;

  if (Array.isArray(move.recoil) && Number(move.recoil[1]) > 0) {
    const fraction = Number(move.recoil[0]) / Number(move.recoil[1]);
    multiplier *= Math.max(0.55, 1 - 0.5 * fraction);
  }
  if (move.hasCrashDamage) multiplier *= 0.9;
  if (Array.isArray(move.drain) && Number(move.drain[1]) > 0) {
    const fraction = Number(move.drain[0]) / Number(move.drain[1]);
    multiplier *= 1 + Math.min(0.15, 0.2 * fraction);
  }

  return multiplier;
}

function candidateMoveScore(species, moveName) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return -Infinity;
  if (move.category === 'Status') {
    const utility = {
      recover: 92,
      roost: 92,
      milkdrink: 92,
      synthesis: 85,
      slackoff: 92,
      thunderwave: 88,
      willowisp: 88,
      toxic: 84,
      hypnosis: 74,
      sleeppowder: 82,
      swordsdance: 86,
      dragondance: 94,
      calmmind: 90,
      nastyplot: 90,
      agility: 70,
      reflect: 60,
      lightscreen: 60,
      substitute: 58,
    };
    return utility[move.id] || 12;
  }

  const offensiveStat = move.category === 'Physical'
    ? species.baseStats.atk
    : species.baseStats.spa;
  const stab = species.types.includes(move.type) ? 1.5 : 1;
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  const priority = move.priority > 0 ? 1.08 : 1;
  const power = effectiveMovePower(move);
  const strategic = moveStrategicMultiplier(move);
  return power * accuracy * stab * priority * strategic * (0.55 + offensiveStat / 120);
}

export function candidateMoveUtility(speciesName, moveName) {
  const species = dex.species.get(speciesName);
  if (!species.exists) throw new Error(`Unknown Gen 4 species: ${speciesName}`);
  return candidateMoveScore(species, moveName);
}

export function candidateMovePool(speciesName, level, stage, moveAccess = null, extraMachines = []) {
  const species = dex.species.get(speciesName);
  if (!species.exists) throw new Error(`Unknown Gen 4 species: ${speciesName}`);

  const moves = new Set(levelUpMovePool(species.name, level));
  for (const machine of moveAccess?.reusableMachines || []) {
    if (Number(machine.availableFrom) > stage) continue;
    if (canLearnGen4Machine(species, machine.move)) moves.add(machine.move);
  }
  for (const tutor of moveAccess?.reusableTutors || []) {
    if (Number(tutor.availableFrom) > stage) continue;
    if (canLearnGen4Tutor(species, tutor.move)) moves.add(tutor.move);
  }
  for (const machine of extraMachines || []) {
    const descriptor = typeof machine === 'string' ? { move: machine, availableFrom: 0 } : machine;
    if (!descriptor?.move || Number(descriptor.availableFrom || 0) > stage) continue;
    if (canLearnGen4Machine(species, descriptor.move)) moves.add(descriptor.move);
  }
  return [...moves];
}

export function selectCandidateMoves(speciesName, level, stage, moveAccess = null, extraMachines = []) {
  const species = dex.species.get(speciesName);
  const pool = candidateMovePool(speciesName, level, stage, moveAccess, extraMachines);
  const scored = pool.map(name => ({
    name,
    move: dex.moves.get(name),
    score: candidateMoveScore(species, name),
  }));
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const selected = [];
  const damagingTypes = new Map();
  for (const entry of scored) {
    if (selected.length >= 4) break;
    if (entry.move.category !== 'Status') {
      const count = damagingTypes.get(entry.move.type) || 0;
      if (count >= 2 && scored.length > 4) continue;
      damagingTypes.set(entry.move.type, count + 1);
    }
    selected.push(entry.name);
  }
  if (selected.length < 4) {
    for (const entry of scored) {
      if (selected.length >= 4) break;
      if (!selected.includes(entry.name)) selected.push(entry.name);
    }
  }
  return selected;
}


const redMoveBuildOptimizationCache = new Map();

function redMoveStatusUtility(species, moveName) {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category !== 'Status') return 0;
  return Math.max(0, candidateMoveScore(species, moveName)) / 100;
}

function redMoveOffenseScore(mon, moveName, foeTeam) {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category === 'Status') return 0;
  const foes = Array.isArray(foeTeam) ? foeTeam.filter(Boolean) : [];
  if (!foes.length) return 0;
  const fractions = foes.map(foe => {
    const damage = previewMoveDamage(mon, foe, moveName);
    const hp = Math.max(1, previewStat(foe, 'hp'));
    return damage / hp;
  });
  const mean = fractions.reduce((sum, value) => sum + value, 0) / fractions.length;
  const best = Math.max(...fractions);
  const coverage = fractions.filter(value => value >= 0.45).length / fractions.length;
  return 0.55 * mean + 0.3 * best + 0.15 * coverage;
}

function redMovesetProxyScore(mon, moves, foeTeam) {
  const species = dex.species.get(mon.species);
  const foes = Array.isArray(foeTeam) ? foeTeam.filter(Boolean) : [];
  if (!species.exists || !foes.length) return -Infinity;

  const sleepSupport = moves.some(moveName =>
    ['hypnosis', 'sleeppowder', 'sing', 'lovelykiss', 'yawn', 'spore'].includes(
      dex.moves.get(moveName).id
    )
  );

  const perFoe = foes.map(foe => {
    const values = [];
    for (const moveName of moves) {
      const move = dex.moves.get(moveName);
      if (!move.exists || move.category === 'Status') continue;
      if (move.id === 'dreameater' && !sleepSupport) continue;
      const damage = previewMoveDamage({ ...mon, moves }, foe, moveName);
      const hp = Math.max(1, previewStat(foe, 'hp'));
      values.push(damage / hp);
    }
    values.sort((a, b) => b - a);
    return {
      best: values[0] || 0,
      second: values[1] || 0,
    };
  });
  const bestFractions = perFoe.map(row => row.best);
  const secondFractions = perFoe.map(row => row.second);
  const mean = bestFractions.reduce((sum, value) => sum + value, 0) / bestFractions.length;
  const worst = Math.min(...bestFractions);
  const best = Math.max(...bestFractions);
  const backupMean = secondFractions.reduce((sum, value) => sum + value, 0) / secondFractions.length;
  const strongCoverage = bestFractions.filter(value => value >= 0.45).length / bestFractions.length;

  const statusValues = moves
    .map(moveName => redMoveStatusUtility(species, moveName))
    .filter(value => value > 0)
    .sort((a, b) => b - a);
  const statusBonus = (statusValues[0] || 0) * 0.07 + (statusValues[1] || 0) * 0.015;

  const damaging = moves
    .map(moveName => dex.moves.get(moveName))
    .filter(move => move.exists && move.category !== 'Status');
  const distinctTypes = new Set(damaging.map(move => move.type)).size;
  const typeDiversity = Math.max(0, distinctTypes - 1) * 0.02;

  return (
    0.39 * mean +
    0.13 * worst +
    0.18 * best +
    0.16 * backupMean +
    0.1 * strongCoverage +
    statusBonus +
    typeDiversity
  );
}

function combinationsOfFour(values) {
  const out = [];
  for (let a = 0; a < values.length - 3; a += 1) {
    for (let b = a + 1; b < values.length - 2; b += 1) {
      for (let c = b + 1; c < values.length - 1; c += 1) {
        for (let d = c + 1; d < values.length; d += 1) {
          out.push([values[a], values[b], values[c], values[d]]);
        }
      }
    }
  }
  return out;
}

function redMoveShortlist(mon, pool, foeTeam, cap = 12) {
  const species = dex.species.get(mon.species);
  if (!species.exists) return pool.slice(0, cap);

  const offensive = pool
    .filter(name => dex.moves.get(name).category !== 'Status')
    .map(name => ({ name, score: redMoveOffenseScore(mon, name, foeTeam) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const status = pool
    .filter(name => dex.moves.get(name).category === 'Status')
    .map(name => ({ name, score: redMoveStatusUtility(species, name) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const selected = new Map();
  function add(name, score = 0) {
    if (!name) return;
    const prior = selected.get(name);
    if (prior === undefined || score > prior) selected.set(name, score);
  }

  // Preserve the best counters to each individual Red Pokemon so a move that
  // only matters for one wall is not lost to a global average.
  for (const foe of foeTeam || []) {
    const perFoe = offensive
      .map(entry => ({
        ...entry,
        foeScore: previewMoveDamage(mon, foe, entry.name) / Math.max(1, previewStat(foe, 'hp')),
      }))
      .sort((a, b) => b.foeScore - a.foeScore || b.score - a.score);
    for (const entry of perFoe.slice(0, 2)) add(entry.name, entry.score + entry.foeScore);
  }
  for (const entry of offensive.slice(0, 7)) add(entry.name, entry.score);
  for (const entry of status.slice(0, 4)) add(entry.name, 0.2 + entry.score);

  const ranked = [...selected.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(4, cap))
    .map(entry => entry.name);

  if (ranked.length < 4) {
    for (const name of pool) {
      if (!ranked.includes(name)) ranked.push(name);
      if (ranked.length >= 4) break;
    }
  }
  return ranked;
}

export function optimizePlayerMovesAndBuildForBoss(
  mon,
  foeTeam,
  {
    iv = 16,
    stage = 0,
    moveAccess = null,
    extraMachines = [],
    shortlistCap = 12,
    movesetFinalists = 8,
  } = {},
) {
  const pool = candidateMovePool(mon.species, mon.level, stage, moveAccess, extraMachines);
  if (!pool.length) {
    return optimizePlayerBuildForBoss({ ...mon, moves: ['Tackle'] }, foeTeam, { iv });
  }

  const foeSignature = (foeTeam || []).map(foe =>
    [foe.species, foe.level, foe.item || '', foe.nature || '', ...(foe.moves || [])].join(':')
  ).join('|');
  const cacheKey = [
    mon.species,
    mon.level,
    mon.ability || '',
    iv,
    stage,
    [...pool].sort().join(','),
    foeSignature,
    shortlistCap,
    movesetFinalists,
    'red-moves-build-v1',
  ].join('||');
  if (redMoveBuildOptimizationCache.has(cacheKey)) {
    const cached = redMoveBuildOptimizationCache.get(cacheKey);
    return {
      ...mon,
      ...cached,
      moves: [...cached.moves],
      ivs: { ...cached.ivs },
      evs: { ...cached.evs },
      _buildOptimization: { ...cached._buildOptimization },
      _movesetOptimization: { ...cached._movesetOptimization },
    };
  }

  // For moveset screening only, allow both attacking stats to express their
  // ceiling. The final legal EV spread/nature/item is selected afterwards.
  const proxyMon = {
    ...mon,
    nature: 'Serious',
    item: '',
    ivs: uniformIvs(iv),
    evs: { hp: 4, atk: 252, def: 0, spa: 252, spd: 0, spe: 0 },
  };
  const shortlist = redMoveShortlist(proxyMon, pool, foeTeam, shortlistCap);
  let moveSets = shortlist.length <= 4
    ? [[...shortlist]]
    : combinationsOfFour(shortlist);

  const scoredMoveSets = moveSets
    .map(moves => ({
      moves,
      proxyScore: redMovesetProxyScore(proxyMon, moves, foeTeam),
      statusCount: moves.filter(moveName => dex.moves.get(moveName).category === 'Status').length,
    }))
    .sort((a, b) =>
      b.proxyScore - a.proxyScore ||
      a.moves.join('/').localeCompare(b.moves.join('/'))
    );

  const finalistMap = new Map();
  function addMoveset(entry) {
    if (!entry || finalistMap.size >= Math.max(1, movesetFinalists)) return;
    finalistMap.set(entry.moves.join('|'), entry);
  }

  const broadQuota = Math.max(1, Math.ceil(movesetFinalists / 2));
  for (const entry of scoredMoveSets.slice(0, broadQuota)) addMoveset(entry);
  for (const entry of scoredMoveSets.filter(entry => entry.statusCount === 0)) {
    addMoveset(entry);
    if (finalistMap.size >= movesetFinalists) break;
  }
  for (const entry of scoredMoveSets.filter(entry => entry.statusCount <= 1)) {
    addMoveset(entry);
    if (finalistMap.size >= movesetFinalists) break;
  }
  for (const entry of scoredMoveSets) {
    addMoveset(entry);
    if (finalistMap.size >= movesetFinalists) break;
  }
  moveSets = [...finalistMap.values()];

  let best = null;
  for (const candidate of moveSets) {
    const built = optimizePlayerBuildForBoss(
      { ...mon, moves: candidate.moves },
      foeTeam,
      { iv },
    );
    const buildScore = playerBuildScore(built, foeTeam);
    const builtMovesetScore = redMovesetProxyScore(built, candidate.moves, foeTeam);
    const species = dex.species.get(mon.species);
    const statusBonus = candidate.moves
      .map(moveName => redMoveStatusUtility(species, moveName))
      .sort((a, b) => b - a)
      .slice(0, 2)
      .reduce((sum, value, index) => sum + value * (index === 0 ? 0.025 : 0.005), 0);
    const score = 0.62 * buildScore + 0.32 * builtMovesetScore + statusBonus + candidate.proxyScore * 0.04;
    if (
      !best ||
      score > best.score + 1e-12 ||
      (Math.abs(score - best.score) <= 1e-12 &&
        candidate.moves.join('/').localeCompare(best.mon.moves.join('/')) < 0)
    ) {
      best = {
        mon: built,
        score,
        proxyScore: candidate.proxyScore,
        shortlist,
      };
    }
  }

  const result = {
    ...(best?.mon || optimizePlayerBuildForBoss({ ...mon, moves: selectCandidateMoves(
      mon.species, mon.level, stage, moveAccess, extraMachines,
    ) }, foeTeam, { iv })),
    _movesetOptimization: {
      mode: 'red-specific-shortlist-enumeration',
      legalMoveCount: pool.length,
      shortlist: best?.shortlist || shortlist,
      evaluatedMovesets: moveSets.length,
      movesetProxyScore: Number(best?.proxyScore || 0),
      jointScore: Number(best?.score || 0),
    },
  };
  redMoveBuildOptimizationCache.set(cacheKey, {
    moves: [...result.moves],
    item: result.item || '',
    nature: result.nature,
    ivs: { ...(result.ivs || {}) },
    evs: { ...(result.evs || {}) },
    _buildOptimization: { ...(result._buildOptimization || {}) },
    _movesetOptimization: { ...(result._movesetOptimization || {}) },
  });
  return result;
}


function moveSetScore(speciesName, moves) {
  const species = dex.species.get(speciesName);
  return moves.reduce((sum, moveName) => sum + candidateMoveScore(species, moveName), 0);
}

function candidateKey(candidate) {
  return candidate.familyId || candidate.species;
}

export function planSingleUseMachines(candidates, bosses, moveAccess = null, options = {}) {
  const assignments = {};
  const levelsByBattle = Array.isArray(options.levelsByBattle) ? options.levelsByBattle : null;
  const machines = [...(moveAccess?.singleUseMachines || [])]
    .sort((a, b) => Number(a.availableFrom) - Number(b.availableFrom) || String(a.machine).localeCompare(String(b.machine)));

  for (const machine of machines) {
    let best = null;

    for (const candidate of candidates) {
      if (Array.isArray(candidate.moves) && candidate.moves.length) continue;
      const key = candidateKey(candidate);
      const existing = assignments[key] || [];
      let totalGain = 0;
      let legalSomewhere = false;

      for (const [bossIndex, boss] of bosses.entries()) {
        if (boss.stage < Number(candidate.availableFrom || 0)) continue;
        if (boss.stage < Number(machine.availableFrom || 0)) continue;

        const actualLevel = levelsByBattle && Number.isFinite(Number(levelsByBattle[bossIndex]?.[key]))
          ? Number(levelsByBattle[bossIndex][key])
          : Number(boss.aceLevel);
        const speciesName = candidateSpeciesAtStage(candidate, boss.stage, actualLevel);
        const species = dex.species.get(speciesName);
        if (!species.exists || !canLearnGen4Machine(species, machine.move)) continue;
        legalSomewhere = true;

        const before = selectCandidateMoves(speciesName, actualLevel, boss.stage, moveAccess, existing);
        const after = selectCandidateMoves(speciesName, actualLevel, boss.stage, moveAccess, [...existing, machine]);
        totalGain += Math.max(0, moveSetScore(speciesName, after) - moveSetScore(speciesName, before));
      }

      if (!legalSomewhere) continue;
      if (!best || totalGain > best.totalGain || (totalGain === best.totalGain && key.localeCompare(best.key) < 0)) {
        best = { key, totalGain };
      }
    }

    if (best && best.totalGain > 0) {
      assignments[best.key] = [...(assignments[best.key] || []), machine];
    }
  }

  return assignments;
}


function machineMoneyEquivalent(machine, moneyPerCoin = 20) {
  const unitCost = Number(machine?.unitCost || 0);
  return machine?.currency === 'coins' ? unitCost * moneyPerCoin : unitCost;
}

function planPurchasableMachinesBudgeted(
  candidates,
  bosses,
  moveAccess,
  singleUsePlan,
  { maxMoneyEquivalent, moneyPerCoin = 20, levelsByBattle = null },
) {
  const limit = Math.max(0, Number(maxMoneyEquivalent || 0));
  const machines = [...(moveAccess?.purchasableMachines || [])]
    .sort((a, b) =>
      Number(a.availableFrom) - Number(b.availableFrom) ||
      machineMoneyEquivalent(a, moneyPerCoin) - machineMoneyEquivalent(b, moneyPerCoin) ||
      String(a.machine).localeCompare(String(b.machine))
    );

  const states = candidates
    .filter(candidate => !(Array.isArray(candidate.moves) && candidate.moves.length))
    .map(candidate => ({
      candidate,
      key: candidateKey(candidate),
      owned: [...(singleUsePlan[candidateKey(candidate)] || [])],
      purchased: [],
    }));

  let spentEquivalent = 0;
  const assignments = {};
  const costs = {};

  for (;;) {
    let best = null;

    for (const state of states) {
      for (const machine of machines) {
        if (
          state.owned.some(existing => existing.machine === machine.machine || existing.move === machine.move) ||
          state.purchased.some(existing => existing.machine === machine.machine)
        ) {
          continue;
        }

        const costEquivalent = machineMoneyEquivalent(machine, moneyPerCoin);
        if (spentEquivalent + costEquivalent > limit) continue;

        let totalGain = 0;
        let legalSomewhere = false;
        for (const [bossIndex, boss] of bosses.entries()) {
          if (boss.stage < Number(state.candidate.availableFrom || 0)) continue;
          if (boss.stage < Number(machine.availableFrom || 0)) continue;

          const actualLevel = levelsByBattle && Number.isFinite(Number(levelsByBattle[bossIndex]?.[state.key]))
            ? Number(levelsByBattle[bossIndex][state.key])
            : Number(boss.aceLevel);
          const speciesName = candidateSpeciesAtStage(state.candidate, boss.stage, actualLevel);
          const species = dex.species.get(speciesName);
          if (!species.exists || !canLearnGen4Machine(species, machine.move)) continue;
          legalSomewhere = true;

          const current = [...state.owned, ...state.purchased];
          const before = selectCandidateMoves(speciesName, actualLevel, boss.stage, moveAccess, current);
          const after = selectCandidateMoves(
            speciesName,
            actualLevel,
            boss.stage,
            moveAccess,
            [...current, machine],
          );
          totalGain += Math.max(0, moveSetScore(speciesName, after) - moveSetScore(speciesName, before));
        }

        if (!legalSomewhere || totalGain <= 0) continue;
        const efficiency = totalGain / Math.max(1, costEquivalent);
        if (
          !best ||
          efficiency > best.efficiency ||
          (efficiency === best.efficiency && totalGain > best.totalGain) ||
          (efficiency === best.efficiency && totalGain === best.totalGain &&
            costEquivalent < best.costEquivalent) ||
          (efficiency === best.efficiency && totalGain === best.totalGain &&
            costEquivalent === best.costEquivalent &&
            `${state.key}:${machine.machine}`.localeCompare(
              `${best.state.key}:${best.machine.machine}`
            ) < 0)
        ) {
          best = { state, machine, totalGain, efficiency, costEquivalent };
        }
      }
    }

    if (!best) break;
    best.state.purchased.push(best.machine);
    spentEquivalent += best.costEquivalent;
    const currency = best.machine.currency || 'money';
    costs[currency] = (costs[currency] || 0) + Number(best.machine.unitCost || 0);
  }

  for (const state of states) {
    if (state.purchased.length) assignments[state.key] = state.purchased;
  }

  return {
    assignments,
    costs,
    budget: {
      maxMoneyEquivalent: limit,
      spentMoneyEquivalent: spentEquivalent,
      remainingMoneyEquivalent: Math.max(0, limit - spentEquivalent),
      moneyPerCoin,
    },
  };
}

export function planPurchasableMachines(
  candidates,
  bosses,
  moveAccess = null,
  singleUsePlan = {},
  options = {},
) {
  const maxMoneyEquivalent = Number(options.maxMoneyEquivalent);
  if (Number.isFinite(maxMoneyEquivalent)) {
    return planPurchasableMachinesBudgeted(
      candidates,
      bosses,
      moveAccess,
      singleUsePlan,
      {
        maxMoneyEquivalent,
        moneyPerCoin: Number(options.moneyPerCoin || 20),
        levelsByBattle: Array.isArray(options.levelsByBattle) ? options.levelsByBattle : null,
      },
    );
  }

  const assignments = {};
  const costs = {};
  const levelsByBattle = Array.isArray(options.levelsByBattle) ? options.levelsByBattle : null;
  const machines = [...(moveAccess?.purchasableMachines || [])]
    .sort((a, b) =>
      Number(a.availableFrom) - Number(b.availableFrom) ||
      Number(a.unitCost || 0) - Number(b.unitCost || 0) ||
      String(a.machine).localeCompare(String(b.machine))
    );

  for (const candidate of candidates) {
    if (Array.isArray(candidate.moves) && candidate.moves.length) continue;
    const key = candidateKey(candidate);
    const owned = [...(singleUsePlan[key] || [])];
    const purchased = [];
    const remaining = machines.filter(machine =>
      !owned.some(existing => existing.machine === machine.machine || existing.move === machine.move)
    );

    for (;;) {
      let best = null;

      for (const machine of remaining) {
        if (purchased.some(existing => existing.machine === machine.machine)) continue;
        let totalGain = 0;
        let legalSomewhere = false;

        for (const [bossIndex, boss] of bosses.entries()) {
          if (boss.stage < Number(candidate.availableFrom || 0)) continue;
          if (boss.stage < Number(machine.availableFrom || 0)) continue;

          const actualLevel = levelsByBattle && Number.isFinite(Number(levelsByBattle[bossIndex]?.[key]))
            ? Number(levelsByBattle[bossIndex][key])
            : Number(boss.aceLevel);
          const speciesName = candidateSpeciesAtStage(candidate, boss.stage, actualLevel);
          const species = dex.species.get(speciesName);
          if (!species.exists || !canLearnGen4Machine(species, machine.move)) continue;
          legalSomewhere = true;

          const current = [...owned, ...purchased];
          const before = selectCandidateMoves(speciesName, actualLevel, boss.stage, moveAccess, current);
          const after = selectCandidateMoves(speciesName, actualLevel, boss.stage, moveAccess, [...current, machine]);
          totalGain += Math.max(0, moveSetScore(speciesName, after) - moveSetScore(speciesName, before));
        }

        if (!legalSomewhere || totalGain <= 0) continue;
        const unitCost = Number(machine.unitCost || 0);
        const efficiency = totalGain / Math.max(1, unitCost);
        if (
          !best ||
          totalGain > best.totalGain ||
          (totalGain === best.totalGain && efficiency > best.efficiency) ||
          (totalGain === best.totalGain && efficiency === best.efficiency &&
            String(machine.machine).localeCompare(String(best.machine.machine)) < 0)
        ) {
          best = { machine, totalGain, efficiency };
        }
      }

      if (!best) break;
      purchased.push(best.machine);
    }

    if (purchased.length) {
      assignments[key] = purchased;
      for (const machine of purchased) {
        const currency = machine.currency || 'money';
        costs[currency] = (costs[currency] || 0) + Number(machine.unitCost || 0);
      }
    }
  }

  return { assignments, costs };
}

export function hgssTrainerToShowdownTeam(trainer, trainerMeta) {
  return trainer.party.map(mon => {
    const speciesName = constantToName(mon.species, 'SPECIES_');
    const species = dex.species.get(speciesName);
    if (!species.exists) throw new Error(`Could not map HGSS species constant ${mon.species}`);
    const moves = Array.isArray(mon.moves) && mon.moves.length
      ? mon.moves.filter(x => x && x !== 'MOVE_NONE').map(x => constantToName(x, 'MOVE_'))
      : levelUpMoves(species.name, mon.level);
    const item = constantToName(mon.item || 'ITEM_NONE', 'ITEM_');
    const iv = npcIvFromDifficulty(mon.difficulty);
    const personality = npcPersonality(mon, species, trainerMeta);
    return {
      name: species.name,
      species: species.name,
      level: mon.level,
      item,
      ability: chooseAbility(species, mon.abilityOverride, personality),
      nature: natureFromPersonality(personality),
      ivs: uniformIvs(iv),
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: moves.length ? moves : ['Tackle'],
    };
  });
}

function candidateSpeciesAtStage(mon, stage, actualLevel = null) {
  let speciesName = mon.species;
  const transitions = Array.isArray(mon.speciesByStage) ? [...mon.speciesByStage] : [];
  transitions.sort((a, b) =>
    Number(a.level || Infinity) - Number(b.level || Infinity) ||
    Number(a.stage || 0) - Number(b.stage || 0)
  );
  for (const transition of transitions) {
    const isLevelEvolution =
      transition.derived === 'level-evolution' ||
      /^level\s+\d+/i.test(String(transition.reason || ''));
    if (isLevelEvolution && Number.isFinite(Number(transition.level)) && actualLevel !== null) {
      if (Number(actualLevel) >= Number(transition.level)) speciesName = transition.species;
      continue;
    }
    if (Number(transition.stage) <= stage) speciesName = transition.species;
  }
  return speciesName;
}

function candidateBossUtilityFromMoveNames(candidate, boss, level, moveNames) {
  const actualLevel = Math.max(1, Math.min(100, Math.floor(Number(level || 1))));
  const stage = Number(boss?.stage || 0);
  const speciesName = candidateSpeciesAtStage(candidate, stage, actualLevel);
  const species = dex.species.get(speciesName);
  if (!species.exists) return 0;

  const usableCandidateMoves = (moveNames || []).length ? moveNames : ['Tackle'];
  const foes = boss?.trainer?.party || [];
  if (!foes.length) return actualLevel;

  let total = 0;
  for (const foe of foes) {
    const foeName = constantToName(foe.species, 'SPECIES_');
    const foeSpecies = dex.species.get(foeName);
    if (!foeSpecies.exists) continue;

    let bestOffense = 1;
    for (const moveName of usableCandidateMoves) {
      const move = dex.moves.get(moveName);
      if (!move.exists) continue;
      let score = candidateMoveScore(species, moveName);
      if (move.category !== 'Status') {
        if (!dex.getImmunity(move.type, foeSpecies)) score = 0;
        else score *= 2 ** dex.getEffectiveness(move, foeSpecies);
      } else {
        score *= 0.25;
      }
      bestOffense = Math.max(bestOffense, score);
    }

    const foeMoves = Array.isArray(foe.moves) && foe.moves.length
      ? foe.moves
          .filter(move => move && move !== 'MOVE_NONE')
          .map(move => constantToName(move, 'MOVE_'))
      : levelUpMoves(foeSpecies.name, Number(foe.level || boss.aceLevel || actualLevel));
    let incomingThreat = 1;
    for (const moveName of foeMoves.length ? foeMoves : ['Tackle']) {
      const move = dex.moves.get(moveName);
      if (!move.exists || move.category === 'Status') continue;
      let score = candidateMoveScore(foeSpecies, moveName);
      if (!dex.getImmunity(move.type, species)) score = 0;
      else score *= 2 ** dex.getEffectiveness(move, species);
      incomingThreat = Math.max(incomingThreat, score);
    }

    total += bestOffense / Math.max(30, incomingThreat);
  }

  const levelRatio = actualLevel / Math.max(1, Number(boss?.aceLevel || actualLevel));
  const levelFactor = Math.max(0.25, Math.min(2.0, levelRatio ** 1.4));
  return (total / foes.length) * levelFactor;
}

export function candidateBossUtility(candidate, boss, level) {
  const actualLevel = Math.max(1, Math.min(100, Math.floor(Number(level || 1))));
  const stage = Number(boss?.stage || 0);
  const speciesName = candidateSpeciesAtStage(candidate, stage, actualLevel);
  const species = dex.species.get(speciesName);
  if (!species.exists) return 0;
  return candidateBossUtilityFromMoveNames(
    candidate,
    boss,
    actualLevel,
    levelUpMovePool(species.name, actualLevel),
  );
}

export function candidateBossUtilityWithMoveAccess(
  candidate,
  boss,
  level,
  moveAccess = null,
  extraMachines = [],
) {
  const actualLevel = Math.max(1, Math.min(100, Math.floor(Number(level || 1))));
  const stage = Number(boss?.stage || 0);
  const speciesName = candidateSpeciesAtStage(candidate, stage, actualLevel);
  const species = dex.species.get(speciesName);
  if (!species.exists) return 0;
  const moveNames = candidateMovePool(
    species.name,
    actualLevel,
    stage,
    moveAccess,
    extraMachines,
  );
  return candidateBossUtilityFromMoveNames(candidate, boss, actualLevel, moveNames);
}

export function materializeCandidateTeam(candidates, stage, level, options = {}) {
  const moveAccess = options.moveAccess || null;
  const singleUsePlan = options.singleUsePlan || {};
  const purchasablePlan = options.purchasablePlan || {};
  const levelsByCandidate = options.levelsByCandidate || null;
  return candidates
    .filter(mon => Number(mon.availableFrom || 0) <= stage)
    .slice(0, 6)
    .map(mon => {
      const key = candidateKey(mon);
      const candidateLevel = levelsByCandidate && Number.isFinite(Number(levelsByCandidate[key]))
        ? Math.max(1, Math.min(100, Math.floor(Number(levelsByCandidate[key]))))
        : level;
      const speciesName = candidateSpeciesAtStage(mon, stage, candidateLevel);
      const species = dex.species.get(speciesName);
      if (!species.exists) throw new Error(`Unknown candidate species: ${speciesName}`);
      const assignedMachines = [
        ...(singleUsePlan[key] || []),
        ...(purchasablePlan[key] || []),
      ];
      const moves = Array.isArray(mon.moves) && mon.moves.length
        ? mon.moves
        : selectCandidateMoves(species.name, candidateLevel, stage, moveAccess, assignedMachines);
      return {
        _candidateKey: key,
        name: species.name,
        species: species.name,
        level: candidateLevel,
        item: mon.item || '',
        ability: mon.ability || species.abilities['0'],
        nature: mon.nature || NEUTRAL_NATURE,
        ivs: mon.ivs || uniformIvs(20),
        evs: mon.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        moves: moves.length ? moves : ['Tackle'],
      };
    });
}

function natureStatMultiplier(natureName, stat) {
  const nature = dex.natures.get(natureName || NEUTRAL_NATURE);
  if (!nature?.exists) return 1;
  if (nature.plus === stat) return 1.1;
  if (nature.minus === stat) return 0.9;
  return 1;
}

function previewStat(mon, stat) {
  const species = dex.species.get(mon.species);
  if (!species.exists) return 1;
  const level = Math.max(1, Number(mon.level || 1));
  const iv = Math.max(0, Math.min(31, Number(mon.ivs?.[stat] ?? 20)));
  const ev = Math.max(0, Number(mon.evs?.[stat] ?? 0));
  const base = Number(species.baseStats?.[stat] || 1);
  if (stat === 'hp') {
    return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
  }
  const raw = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5;
  return Math.floor(raw * natureStatMultiplier(mon.nature, stat));
}

function previewItemDamageMultiplier(mon, move, target) {
  const item = dex.items.get(mon?.item || '');
  if (!item?.exists || !move?.exists) return 1;
  if (item.id === 'choiceband' && move.category === 'Physical') return 1.5;
  if (item.id === 'choicespecs' && move.category === 'Special') return 1.5;
  if (item.id === 'lifeorb') return 1.3;
  if (item.id === 'expertbelt') {
    const defender = dex.species.get(target?.species || '');
    if (defender.exists && dex.getImmunity(move.type, defender) && dex.getEffectiveness(move, defender) > 0) {
      return 1.2;
    }
  }
  if (item.id === 'muscleband' && move.category === 'Physical') return 1.1;
  if (item.id === 'wiseglasses' && move.category === 'Special') return 1.1;
  return 1;
}

function previewSpeedMultiplier(mon) {
  const item = dex.items.get(mon?.item || '');
  return item?.id === 'choicescarf' ? 1.5 : 1;
}

function previewEffectiveHpMultiplier(mon, incomingDamage) {
  const item = dex.items.get(mon?.item || '');
  if (!item?.exists) return 1;
  if (item.id === 'leftovers') return 1.12;
  if (item.id === 'sitrusberry') return 1.25;
  if (item.id === 'focussash' && Number(incomingDamage || 0) >= previewStat(mon, 'hp')) return 1.9;
  if (item.id === 'lumberry') return 1.05;
  return 1;
}

function previewMoveDamage(mon, target, moveName) {
  const move = dex.moves.get(moveName);
  const attacker = dex.species.get(mon.species);
  const defender = dex.species.get(target.species);
  if (!move.exists || !attacker.exists || !defender.exists || move.category === 'Status') return 0;
  if (!dex.getImmunity(move.type, defender)) return 0;
  if (typeof move.damage === 'number') return Number(move.damage);

  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = previewStat(mon, attackStat);
  const defense = previewStat(target, defenseStat);
  const level = Math.max(1, Number(mon.level || 1));
  const power = Math.max(1, effectiveMovePower(move));
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const effectiveness = 2 ** dex.getEffectiveness(move, defender);
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  return ((((2 * level / 5 + 2) * power * attack / Math.max(1, defense)) / 50) + 2) *
    stab * effectiveness * accuracy * 0.925 * moveStrategicMultiplier(move) *
    previewItemDamageMultiplier(mon, move, target);
}

function previewMatchupUtility(mon, target) {
  if (!mon || !target) return -Infinity;
  const out = Math.max(0, ...(mon.moves || []).map(move => previewMoveDamage(mon, target, move)));
  const incoming = Math.max(0, ...(target.moves || []).map(move => previewMoveDamage(target, mon, move)));
  const targetHp = Math.max(1, previewStat(target, 'hp'));
  const baseOwnHp = Math.max(1, previewStat(mon, 'hp'));
  const ownHp = baseOwnHp * previewEffectiveHpMultiplier(mon, incoming);
  const ownSpeed = previewStat(mon, 'spe') * previewSpeedMultiplier(mon);
  const foeSpeed = previewStat(target, 'spe') * previewSpeedMultiplier(target);
  const speedFactor = ownSpeed >= foeSpeed ? 1.12 : 0.94;
  return (out / targetHp) * speedFactor / Math.max(0.25, incoming / ownHp);
}

const RED_BUILD_EV_SPREADS = [
  { label: 'atk-spe', evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 } },
  { label: 'spa-spe', evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 } },
  { label: 'hp-atk', evs: { hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0 } },
  { label: 'hp-spa', evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 } },
  { label: 'hp-def', evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 } },
  { label: 'hp-spd', evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 } },
  { label: 'hp-spe', evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252 } },
];
const RED_BUILD_NATURES = [
  'Adamant', 'Jolly', 'Modest', 'Timid',
  'Impish', 'Careful', 'Bold', 'Calm',
  'Serious',
];
const RED_BUILD_ITEMS = [
  '', 'Leftovers', 'Life Orb', 'Expert Belt',
  'Choice Band', 'Choice Specs', 'Choice Scarf',
  'Focus Sash', 'Sitrus Berry', 'Muscle Band',
  'Wise Glasses', 'Lum Berry',
];

const playerBuildOptimizationCache = new Map();

function playerBuildScore(mon, foeTeam) {
  const foes = Array.isArray(foeTeam) ? foeTeam.filter(Boolean) : [];
  if (!foes.length) return 0;
  const utilities = foes
    .map(foe => previewMatchupUtility(mon, foe))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!utilities.length) return 0;
  const mean = utilities.reduce((sum, value) => sum + value, 0) / utilities.length;
  const worst = utilities[0];
  const best = utilities[utilities.length - 1];
  return 0.6 * mean + 0.15 * worst + 0.25 * best;
}

export function optimizePlayerBuildForBoss(mon, foeTeam, options = {}) {
  const iv = Math.max(0, Math.min(31, Math.floor(Number(options.iv ?? 16))));
  const ivs = uniformIvs(iv);
  const spreads = options.evSpreads || RED_BUILD_EV_SPREADS;
  const natures = options.natures || RED_BUILD_NATURES;
  const items = options.items || RED_BUILD_ITEMS;
  const cacheable =
    spreads === RED_BUILD_EV_SPREADS &&
    natures === RED_BUILD_NATURES &&
    items === RED_BUILD_ITEMS;
  const foeSignature = (foeTeam || []).map(foe =>
    [foe.species, foe.level, foe.item || '', foe.nature || '', ...(foe.moves || [])].join(':')
  ).join('|');
  const cacheKey = cacheable
    ? [
        mon.species,
        mon.level,
        mon.ability || '',
        (mon.moves || []).join(','),
        iv,
        foeSignature,
      ].join('||')
    : null;
  if (cacheKey && playerBuildOptimizationCache.has(cacheKey)) {
    const cached = playerBuildOptimizationCache.get(cacheKey);
    return {
      ...mon,
      ...cached,
      ivs: { ...cached.ivs },
      evs: { ...cached.evs },
      _buildOptimization: { ...cached._buildOptimization },
    };
  }

  // Stage 1: choose promising EV/nature pairs without an item. This keeps the
  // build search cheap enough to sit inside the GA while still considering all
  // requested max-EV spreads and nature families.
  const baseBuilds = [];
  for (const spread of spreads) {
    for (const nature of natures) {
      const candidate = {
        ...mon,
        ivs,
        evs: { ...spread.evs },
        nature,
        item: '',
      };
      baseBuilds.push({
        mon: candidate,
        score: playerBuildScore(candidate, foeTeam),
        evSpread: spread.label,
      });
    }
  }
  baseBuilds.sort((a, b) =>
    Number(b.score) - Number(a.score) ||
    `${a.evSpread}:${a.mon.nature}`.localeCompare(`${b.evSpread}:${b.mon.nature}`)
  );

  // Stage 2: only the strongest few EV/nature bases receive the held-item
  // sweep. 4 * 12 = 48 item evaluations instead of a 7*9*12 full product.
  const finalistBases = baseBuilds.slice(0, Math.min(4, baseBuilds.length));
  let best = null;
  for (const base of finalistBases) {
    for (const item of items) {
      const candidate = { ...base.mon, item };
      let score = playerBuildScore(candidate, foeTeam);
      const itemId = dex.items.get(item || '').id;
      if (['choiceband', 'choicespecs', 'choicescarf'].includes(itemId)) {
        const statusCount = (candidate.moves || [])
          .filter(moveName => dex.moves.get(moveName).category === 'Status')
          .length;
        // Locking into setup/recovery/status is strategically toxic. Keep
        // Choice items available for pure attacking sets, but strongly prefer
        // non-Choice items when the moveset contains utility moves.
        score *= 0.42 ** statusCount;
      }
      if (
        !best ||
        score > best.score + 1e-12 ||
        (Math.abs(score - best.score) <= 1e-12 &&
          `${base.evSpread}:${candidate.nature}:${item}`.localeCompare(
            `${best.evSpread}:${best.mon.nature}:${best.mon.item}`
          ) < 0)
      ) {
        best = {
          mon: candidate,
          score,
          evSpread: base.evSpread,
        };
      }
    }
  }

  const result = {
    ...(best?.mon || { ...mon, ivs }),
    _buildOptimization: {
      iv,
      evSpread: best?.evSpread || null,
      nature: best?.mon?.nature || mon.nature || NEUTRAL_NATURE,
      item: best?.mon?.item || mon.item || '',
      proxyScore: Number(best?.score || 0),
      searchMode: 'staged-ev-nature-then-item',
    },
  };
  if (cacheKey) {
    playerBuildOptimizationCache.set(cacheKey, {
      ivs: { ...result.ivs },
      evs: { ...result.evs },
      nature: result.nature,
      item: result.item,
      _buildOptimization: { ...result._buildOptimization },
    });
  }
  return result;
}
export function orderPlayerTeamForLead(team, foeTeam) {
  const lead = Array.isArray(foeTeam) ? foeTeam[0] : null;
  if (!lead) return [...team];
  return [...team].sort((a, b) =>
    previewMatchupUtility(b, lead) - previewMatchupUtility(a, lead) ||
    String(a.species).localeCompare(String(b.species))
  );
}

function seedArray(seed) {
  let x = (Number(seed) >>> 0) || 1;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(x & 0xffff);
  }
  return out;
}

function aiRandomChance(stats, numerator, denominator) {
  const den = Math.max(1, Math.floor(Number(denominator || 1)));
  const num = Math.max(0, Math.min(den, Math.floor(Number(numerator || 0))));
  let state = Number(stats?.aiRngState || 1) >>> 0;
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  if (stats) stats.aiRngState = state;
  return (state % den) < num;
}


function trainerItemDisplayName(item) {
  return String(item || '')
    .replace(/^ITEM_/, '')
    .toLowerCase()
    .split('_')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function applyHgssTrainerItemTurn(battle, side, active, stats, plan) {
  if (!battle || !side || !active || !plan) return false;
  const displayName = trainerItemDisplayName(plan.item);

  if (plan.healAmount === Infinity) {
    const healed = active.heal(active.maxhp);
    if (healed) battle.add('-heal', active, active.getHealth, `[from] item: ${displayName}`);
  } else if (Number(plan.healAmount) > 0) {
    const healed = active.heal(Number(plan.healAmount));
    if (healed) battle.add('-heal', active, active.getHealth, `[from] item: ${displayName}`);
  }

  if (plan.cureStatus && active.status) active.cureStatus();
  if (plan.cureConfusion && active.volatiles?.confusion) active.removeVolatile('confusion');

  if (Array.isArray(stats?.trainerItems) && plan.index >= 0 && plan.index < stats.trainerItems.length) {
    stats.trainerItems[plan.index] = null;
  }
  if (stats) {
    stats.trainerItemsUsed = [...(stats.trainerItemsUsed || []), plan.item];
  }

  // Showdown has no trainer-bag command in standard customgame. The caller
  // submits a parser-safe no-action turn through the normal player stream after
  // this effect is applied; do not mutate Side.choice or commit the queue here,
  // because doing so re-enters request processing and can leave the stream
  // waiting forever.
  return true;
}

function scoreMove(active, target, requestedMove) {
  const move = dex.moves.get(requestedMove.move);
  if (!move.exists || requestedMove.disabled) return -Infinity;
  if (move.category === 'Status') {
    const useful = new Set([
      'recover', 'roost', 'synthesis', 'hypnosis', 'thunderwave',
      'toxic', 'willowisp', 'swordsdance', 'dragondance', 'calmmind',
    ]);
    return useful.has(move.id) ? 18 : 2;
  }

  const immunity = dex.getImmunity(move.type, target);
  if (!immunity) return 0;
  const typeMod = dex.getEffectiveness(move, target);
  const effectiveness = 2 ** typeMod;
  const stab = active.getTypes().includes(move.type) ? 1.5 : 1;
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  const priority = move.priority > 0 ? 1.05 : 1;

  const fixedDamage = typeof move.damage === 'number' ? move.damage : null;
  const strategic = moveStrategicMultiplier(move);
  if (fixedDamage !== null) {
    return fixedDamage * effectiveness * accuracy * priority * strategic;
  }

  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = Math.max(1, Number(active.getStat?.(attackStat) || active.storedStats?.[attackStat] || 1));
  const defense = Math.max(1, Number(target.getStat?.(defenseStat) || target.storedStats?.[defenseStat] || 1));
  const statRatio = attack / defense;
  const power = effectiveMovePower(move);

  // This is a ranking heuristic, not a replacement for Showdown's damage
  // calculation. The battle engine still resolves the real move and damage.
  return power * statRatio * effectiveness * stab * accuracy * priority * strategic;
}

function estimateBattleDamage(active, target, requestedMove) {
  const move = dex.moves.get(requestedMove?.move);
  if (!active || !target || !move.exists || requestedMove?.disabled || move.category === 'Status') return 0;
  if (!dex.getImmunity(move.type, target)) return 0;

  const effectiveness = 2 ** dex.getEffectiveness(move, target);
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  const priority = move.priority > 0 ? 1.03 : 1;
  const strategic = moveStrategicMultiplier(move);
  if (typeof move.damage === 'number') {
    return Math.max(0, Number(move.damage) * effectiveness * accuracy * priority * strategic);
  }

  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = Math.max(1, Number(active.getStat?.(attackStat) || active.storedStats?.[attackStat] || 1));
  const defense = Math.max(1, Number(target.getStat?.(defenseStat) || target.storedStats?.[defenseStat] || 1));
  const level = Math.max(1, Number(active.level || 1));
  let power = Math.max(1, effectiveMovePower(move));
  if (move.id === 'eruption' || move.id === 'waterspout') {
    const hpRatio = active.maxhp > 0 ? active.hp / active.maxhp : 0;
    power = Math.max(1, 150 * hpRatio);
  }
  const stab = active.getTypes().includes(move.type) ? 1.5 : 1;
  let damage = (((2 * level / 5 + 2) * power * attack / defense) / 50) + 2;
  damage *= stab * effectiveness * 0.925 * accuracy * priority * strategic;

  if (
    move.category === 'Physical' &&
    active.status === 'brn' &&
    active.ability !== 'Guts'
  ) {
    damage *= 0.5;
  }
  return Math.max(0, damage);
}

function bestExpectedDamage(mon, target) {
  if (!mon || !target) return 0;
  let best = 0;
  for (const slot of mon.moveSlots || []) {
    const requested = { move: slot.id || slot.move, disabled: slot.disabled || false };
    best = Math.max(best, estimateBattleDamage(mon, target, requested));
  }
  return best;
}

function smartStatusMoveScore(active, target, requestedMove, battle) {
  const move = dex.moves.get(requestedMove?.move);
  if (!move.exists || move.category !== 'Status') return -Infinity;
  const hpRatio = active?.maxhp > 0 ? active.hp / active.maxhp : 0;
  const incoming = bestExpectedDamage(target, active);
  const likelyIncomingKo = incoming >= Number(active?.hp || 0);
  const heldItemId = dex.items.get(active?.item || '').id;
  if (['choiceband', 'choicespecs', 'choicescarf'].includes(heldItemId)) return 0.25;

  const recovery = new Set(['recover', 'roost', 'milkdrink', 'synthesis', 'slackoff', 'softboiled']);
  if (recovery.has(move.id)) {
    if (hpRatio >= 0.72 || likelyIncomingKo) return 1;
    return 85 + (1 - hpRatio) * 90;
  }

  if (move.status) {
    if (target?.status) return 0;
    if (move.status === 'par' && target?.hasType?.('Ground')) return 4;
    return 58;
  }

  const setupIds = new Set([
    'swordsdance', 'dragondance', 'calmmind', 'nastyplot', 'agility',
    'curse', 'bulkup',
  ]);
  if (setupIds.has(move.id)) {
    if (hpRatio < 0.45 || likelyIncomingKo) return 4;
    const relevantBoosts = Object.values(move.boosts || {});
    const alreadyBoosted = relevantBoosts.length
      ? Object.keys(move.boosts || {}).every(stat => Number(active?.boosts?.[stat] || 0) >= 2)
      : false;
    if (alreadyBoosted) return 3;
    return 68 + hpRatio * 22;
  }

  if (move.id === 'reflect' || move.id === 'lightscreen') {
    if (active?.side?.sideConditions?.[move.id]) return 1;
    return 52;
  }
  if (move.id === 'substitute') {
    if (hpRatio < 0.55 || active?.volatiles?.substitute) return 1;
    return 42;
  }

  // Keep niche support moves available, but below a credible damaging turn.
  return 8;
}

function smartMoveScore(active, target, requestedMove, battle) {
  const move = dex.moves.get(requestedMove?.move);
  if (!move.exists || requestedMove?.disabled) return -Infinity;
  if (move.id === 'dreameater' && target?.status !== 'slp') return -1000;
  if (move.category === 'Status') {
    return smartStatusMoveScore(active, target, requestedMove, battle);
  }

  let damage = estimateBattleDamage(active, target, requestedMove);
  if (move.id === 'focuspunch') {
    const incomingContact = bestExpectedDamage(target, active);
    if (incomingContact > 0) damage *= 0.08;
  }
  const targetHp = Math.max(1, Number(target?.hp || target?.maxhp || 1));
  const targetMaxHp = Math.max(1, Number(target?.maxhp || targetHp));
  const activeSpeed = Math.max(1, Number(active?.getStat?.('spe') || active?.storedStats?.spe || 1));
  const targetSpeed = Math.max(1, Number(target?.getStat?.('spe') || target?.storedStats?.spe || 1));
  const priority = Number(move.priority || 0);
  const actsFirst = priority > 0 || activeSpeed >= targetSpeed;
  const ko = damage >= targetHp;

  let score = 100 * damage / targetMaxHp;
  if (ko) score += actsFirst ? 420 : 220;
  if (priority > 0 && targetHp <= damage * 1.2) score += 45;

  const incoming = bestExpectedDamage(target, active);
  if (!actsFirst && incoming >= Number(active?.hp || 0) && !ko) score *= 0.3;
  return score;
}

function battleMonMoveScore(mon, target) {
  if (!mon || !target) return 0;
  const slots = mon.moveSlots || [];
  let best = 0;
  for (const slot of slots) {
    const requested = { move: slot.id || slot.move, disabled: slot.disabled || false };
    best = Math.max(best, scoreMove(mon, target, requested));
  }
  return Number.isFinite(best) ? best : 0;
}

function matchupUtility(mon, foeMon) {
  if (!mon || !foeMon || mon.fainted) return -Infinity;
  const offense = battleMonMoveScore(mon, foeMon);
  const incoming = battleMonMoveScore(foeMon, mon);
  const hpRatio = mon.maxhp > 0 ? mon.hp / mon.maxhp : 0;
  return (offense * (0.5 + hpRatio)) / Math.max(35, incoming);
}

function smartMatchupUtility(mon, foeMon) {
  if (!mon || !foeMon || mon.fainted) return -Infinity;
  const outgoing = bestExpectedDamage(mon, foeMon);
  const incoming = bestExpectedDamage(foeMon, mon);
  const foeHp = Math.max(1, Number(foeMon.hp || foeMon.maxhp || 1));
  const ownHp = Math.max(1, Number(mon.hp || mon.maxhp || 1));
  const ownMaxHp = Math.max(1, Number(mon.maxhp || ownHp));
  const hpRatio = ownHp / ownMaxHp;
  const offenseFraction = outgoing / foeHp;
  const dangerFraction = incoming / ownHp;
  const ownSpeed = Math.max(1, Number(mon.getStat?.('spe') || mon.storedStats?.spe || 1));
  const foeSpeed = Math.max(1, Number(foeMon.getStat?.('spe') || foeMon.storedStats?.spe || 1));
  const speedFactor = ownSpeed >= foeSpeed ? 1.12 : 0.94;
  const survivalFactor = dangerFraction >= 1 ? 0.35 : 1 / Math.max(0.35, dangerFraction);
  return offenseFraction * (0.6 + hpRatio) * speedFactor * survivalFactor;
}

function bestSmartForcedSwitch(request, side, foeActive) {
  if (!request?.side?.pokemon || !side || !foeActive) return null;
  let best = null;
  for (let idx = 0; idx < side.pokemon.length; idx += 1) {
    const mon = side.pokemon[idx];
    const reqMon = request.side.pokemon[idx];
    if (!mon || !reqMon || reqMon.active || mon.fainted || reqMon.condition?.endsWith(' fnt')) continue;
    const utility = smartMatchupUtility(mon, foeActive);
    if (!best || utility > best.utility) best = { idx, utility };
  }
  return best?.idx ?? null;
}

function bestSmartVoluntarySwitch(request, side, foeActive, active, activeRequest) {
  if (!side || !foeActive || !active || activeRequest?.trapped || activeRequest?.maybeTrapped) return null;
  if (!request.side?.pokemon || side.pokemon.length <= 1) return null;

  const currentDamage = bestExpectedDamage(active, foeActive);
  const currentIncoming = bestExpectedDamage(foeActive, active);
  const currentSpeed = Math.max(1, Number(active.getStat?.('spe') || active.storedStats?.spe || 1));
  const foeSpeed = Math.max(1, Number(foeActive.getStat?.('spe') || foeActive.storedStats?.spe || 1));
  const currentCanKo = currentDamage >= Number(foeActive.hp || 1);
  if (currentCanKo && currentSpeed >= foeSpeed) return null;

  const currentUtility = smartMatchupUtility(active, foeActive);
  let best = null;
  for (let idx = 0; idx < side.pokemon.length; idx += 1) {
    const mon = side.pokemon[idx];
    const reqMon = request.side.pokemon[idx];
    if (!mon || !reqMon || reqMon.active || mon.fainted || reqMon.condition?.endsWith(' fnt')) continue;
    const incoming = bestExpectedDamage(foeActive, mon);
    const utility = smartMatchupUtility(mon, foeActive);
    const survivesEntry = incoming < Number(mon.hp || 0);
    if (!best || utility > best.utility) best = { idx, utility, survivesEntry };
  }
  if (!best) return null;

  const likelyCurrentKo = currentIncoming >= Number(active.hp || 0) && currentSpeed <= foeSpeed;
  if (likelyCurrentKo && best.survivesEntry && best.utility > currentUtility * 0.9) {
    return `switch ${best.idx + 1}`;
  }
  if (best.survivesEntry && best.utility > currentUtility * 1.28) {
    return `switch ${best.idx + 1}`;
  }
  return null;
}

function bestVoluntarySwitch(request, side, foeActive, active, activeRequest, policy = {}) {
  if (!side || !foeActive || !active || activeRequest?.trapped || activeRequest?.maybeTrapped) return null;
  if (!request.side?.pokemon || side.pokemon.length <= 1) return null;

  const currentUtility = matchupUtility(active, foeActive);
  const currentOffense = battleMonMoveScore(active, foeActive);
  let best = null;

  for (let idx = 0; idx < side.pokemon.length; idx += 1) {
    const mon = side.pokemon[idx];
    const reqMon = request.side.pokemon[idx];
    if (!mon || !reqMon || reqMon.active || mon.fainted || reqMon.condition?.endsWith(' fnt')) continue;
    const utility = matchupUtility(mon, foeActive);
    if (!best || utility > best.utility) best = { idx, utility };
  }

  if (!best) return null;
  // Avoid constant switching for marginal gains by default. Diagnostic
  // policies may relax these thresholds without changing damage resolution.
  const ratioThreshold = Math.max(1, Number(policy.ratioThreshold || 1.55));
  const offenseCeiling = Math.max(0, Number(policy.offenseCeiling || 140));
  const utilityCeiling = Math.max(0, Number(policy.utilityCeiling || 1.0));
  if (
    best.utility > currentUtility * ratioThreshold &&
    (currentOffense < offenseCeiling || currentUtility < utilityCeiling)
  ) {
    return `switch ${best.idx + 1}`;
  }
  return null;
}

function selectChoice(request, battleStream, sideId, stats = null, aiOptions = null) {
  if (request.wait) return null;
  if (request.teamPreview) return 'default';
  const battle = battleStream.battle;
  const sideIndex = sideId === 'p1' ? 0 : 1;
  const foeIndex = sideIndex === 0 ? 1 : 0;
  const side = battle?.sides?.[sideIndex];
  const foe = battle?.sides?.[foeIndex];
  const useHgssNpcAi = sideId === 'p2' && aiOptions?.mode === 'hgss';

  if (request.forceSwitch) {
    if (sideId === 'p1' && aiOptions?.mode === 'smart' && request.forceSwitch.length === 1 && request.forceSwitch[0]) {
      const foeActive = foe?.active?.find(Boolean);
      const slot = bestSmartForcedSwitch(request, side, foeActive);
      if (slot !== null && slot !== undefined) {
        if (stats) stats.forcedSwitches = Number(stats.forcedSwitches || 0) + 1;
        return `switch ${slot + 1}`;
      }
    }
    if (useHgssNpcAi && request.forceSwitch.length === 1 && request.forceSwitch[0]) {
      const foeActive = foe?.active?.find(Boolean);
      const slot = chooseHgssPostKoSwitch(request, side, foeActive);
      if (slot !== null && slot !== undefined) {
        if (stats) stats.forcedSwitches = Number(stats.forcedSwitches || 0) + 1;
        return `switch ${slot + 1}`;
      }
    }
    const pokemon = request.side.pokemon;
    const choices = [];
    const chosen = new Set();
    for (let i = 0; i < request.forceSwitch.length; i += 1) {
      if (!request.forceSwitch[i]) {
        choices.push('pass');
        continue;
      }
      const slot = pokemon.findIndex((p, idx) => !chosen.has(idx) && !p.active && !p.condition.endsWith(' fnt'));
      if (slot < 0) choices.push('pass');
      else {
        chosen.add(slot);
        choices.push(`switch ${slot + 1}`);
      }
    }
    return choices.join(', ');
  }

  if (request.active) {
    const activeBattleMons = side?.active || [];
    const foeActive = foe?.active?.find(Boolean);
    const choices = request.active.map((activeRequest, i) => {
      if (!activeRequest) return 'pass';
      const active = activeBattleMons[i];
      if (sideId === 'p1' && request.active.length === 1) {
        const p1Mode = aiOptions?.mode || 'greedy';
        if (p1Mode === 'smart') {
          const turn = Number(battle?.turn || 0);
          const lastSwitchTurn = Number(stats?.lastVoluntarySwitchTurn ?? -999);
          const underSwitchCap = Number(stats?.voluntarySwitches || 0) < 10;
          const cooldownReady = turn - lastSwitchTurn >= 1;
          if (underSwitchCap && cooldownReady) {
            const switchChoice = bestSmartVoluntarySwitch(
              request,
              side,
              foeActive,
              active,
              activeRequest,
            );
            if (switchChoice) return switchChoice;
          }
        } else if (p1Mode !== 'no-switch') {
          const aggressive = p1Mode === 'aggressive';
          const turn = Number(battle?.turn || 0);
          const lastSwitchTurn = Number(stats?.lastVoluntarySwitchTurn ?? -999);
          const switchCap = aggressive ? 12 : 6;
          const cooldown = aggressive ? 1 : 3;
          const underSwitchCap = Number(stats?.voluntarySwitches || 0) < switchCap;
          const cooldownReady = turn - lastSwitchTurn >= cooldown;
          if (underSwitchCap && cooldownReady) {
            const switchChoice = bestVoluntarySwitch(
              request,
              side,
              foeActive,
              active,
              activeRequest,
              aggressive
                ? { ratioThreshold: 1.15, offenseCeiling: 220, utilityCeiling: 1.5 }
                : {},
            );
            if (switchChoice) return switchChoice;
          }
        }
      } else if (useHgssNpcAi && request.active.length === 1) {
        const slot = chooseHgssVoluntarySwitch(
          request,
          side,
          foeActive,
          active,
          activeRequest,
          (num, den) => aiRandomChance(stats, num, den),
        );
        if (slot !== null && slot !== undefined) return `switch ${slot + 1}`;
      }
      if (useHgssNpcAi && active && foeActive) {
        const itemPlan = chooseHgssTrainerItem(
          active,
          side,
          stats?.trainerItems || [],
          stats?.trainerItemCount || 0,
        );
        if (itemPlan && applyHgssTrainerItemTurn(battle, side, active, stats, itemPlan)) {
          return '__trainer_item__';
        }

        const moveIdx = chooseHgssMoveIndex(
          activeRequest,
          active,
          foeActive,
          aiOptions?.profile?.aiFlags || 0,
          battle,
          (num, den) => aiRandomChance(stats, num, den),
        );
        if (stats) stats.moveDecisions = Number(stats.moveDecisions || 0) + 1;
        return `move ${moveIdx + 1}`;
      }

      const playerMode = sideId === 'p1' ? (aiOptions?.mode || 'greedy') : 'greedy';
      const legal = activeRequest.moves
        .map((move, idx) => ({
          idx,
          move,
          score: active && foeActive
            ? (playerMode === 'smart'
              ? smartMoveScore(active, foeActive, move, battle)
              : scoreMove(active, foeActive, move))
            : 1,
        }))
        .filter(entry => !entry.move.disabled);
      if (!legal.length) return 'move 1';
      legal.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return `move ${legal[0].idx + 1}`;
    });
    if (choices.includes('__trainer_item__')) return '__trainer_item__';
    return choices.join(', ');
  }
  return 'default';
}

async function runGreedyAi(playerStream, battleStream, sideId, stats, aiOptions = null) {
  for await (const chunk of playerStream) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|request|')) continue;
      const request = JSON.parse(line.slice('|request|'.length));
      const choice = selectChoice(request, battleStream, sideId, stats, aiOptions);
      if (choice) {
        if (choice === '__trainer_item__') {
          // Side#choosePass normally rejects a pass from a healthy active mon.
          // A temporary "commanding" marker is the narrowest parser bridge:
          // choosePass explicitly accepts it, while Gen 4 has no Commanding
          // battle effect. The marker exists only during the synchronous write
          // and is removed immediately afterward.
          const battle = battleStream.battle;
          const sideIndex = sideId === 'p1' ? 0 : 1;
          const active = battle?.sides?.[sideIndex]?.active?.[0];
          if (!active) throw new Error('Trainer item turn requires an active Pokemon');
          const priorCommanding = active.volatiles?.commanding;
          active.volatiles.commanding = priorCommanding || { id: 'commanding' };
          try {
            await playerStream.write('pass');
          } finally {
            if (priorCommanding) active.volatiles.commanding = priorCommanding;
            else delete active.volatiles.commanding;
          }
          continue;
        }
        if (choice.startsWith('switch ') && !request.forceSwitch) {
          stats.voluntarySwitches += 1;
          stats.lastVoluntarySwitchTurn = Number(battleStream.battle?.turn || 0);
        }
        await playerStream.write(choice);
      }
    }
  }
}

function p1UsageKey(actor, keyByDisplayName) {
  const text = String(actor || '');
  const marker = text.indexOf(': ');
  const displayName = marker >= 0 ? text.slice(marker + 2) : text;
  return keyByDisplayName.get(displayName) || null;
}

function emptyBattleUsage() {
  return {
    appearances: 0,
    leadStarts: 0,
    moveUses: 0,
    activeTurns: 0,
    faints: 0,
  };
}

export async function runBattle(p1Team, p2Team, seed = 1, options = {}) {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);
  const p2Profile = options.p2Trainer ? trainerAiProfile(options.p2Trainer) : null;
  const p2Mode = options.p2AiMode || (p2Profile ? 'hgss' : 'greedy');
  const p1Mode = options.p1AiMode || 'greedy';
  if (!['greedy', 'aggressive', 'no-switch', 'smart'].includes(p1Mode)) {
    throw new Error(`Unknown p1AiMode: ${p1Mode}`);
  }
  const preparedP1Team =
    p1Mode === 'smart' && options.p1SmartLead !== false
      ? orderPlayerTeamForLead(p1Team, p2Team)
      : p1Team;
  const p1KeyByDisplayName = new Map(
    preparedP1Team.map(mon => [String(mon.name || mon.species), String(mon._candidateKey || mon.species)])
  );
  const p1Usage = Object.fromEntries(
    preparedP1Team.map(mon => [String(mon._candidateKey || mon.species), emptyBattleUsage()])
  );
  let p1ActiveKey = null;
  let p1LeadSeen = false;
  const p1Stats = {
    voluntarySwitches: 0,
    forcedSwitches: 0,
    moveDecisions: 0,
    lastVoluntarySwitchTurn: -999,
    aiRngState: (Number(seed) ^ 0x13579bdf) >>> 0,
  };
  const p2Stats = {
    voluntarySwitches: 0,
    forcedSwitches: 0,
    moveDecisions: 0,
    lastVoluntarySwitchTurn: -999,
    aiRngState: (Number(seed) ^ 0x2468ace0) >>> 0,
    trainerItems: options.p2TrainerItems === false ? [] : [...(p2Profile?.items || [])],
    trainerItemCount: options.p2TrainerItems === false ? 0 : Number(p2Profile?.items?.length || 0),
    trainerItemsUsed: [],
  };
  const p1Task = runGreedyAi(streams.p1, battleStream, 'p1', p1Stats, { mode: p1Mode }).catch(() => undefined);
  const p2Task = runGreedyAi(
    streams.p2,
    battleStream,
    'p2',
    p2Stats,
    { mode: p2Mode, profile: p2Profile },
  ).catch(() => undefined);
  const resultPromise = (async () => {
    let winner = null;
    let turns = 0;
    let p1Faints = 0;
    let p2Faints = 0;
    for await (const chunk of streams.omniscient) {
      for (const line of chunk.split('\n')) {
        const parts = line.split('|');
        const event = parts[1] || '';
        const actor = parts[2] || '';
        if ((event === 'switch' || event === 'drag') && actor.startsWith('p1')) {
          const key = p1UsageKey(actor, p1KeyByDisplayName);
          if (key && p1Usage[key]) {
            p1Usage[key].appearances += 1;
            p1ActiveKey = key;
            if (!p1LeadSeen) {
              p1Usage[key].leadStarts += 1;
              p1LeadSeen = true;
            }
          }
        }
        if (event === 'move' && actor.startsWith('p1')) {
          const key = p1UsageKey(actor, p1KeyByDisplayName);
          if (key && p1Usage[key]) {
            p1Usage[key].moveUses += 1;
            p1ActiveKey = key;
          }
        }
        if (event === 'faint' && actor.startsWith('p1')) {
          p1Faints += 1;
          const key = p1UsageKey(actor, p1KeyByDisplayName);
          if (key && p1Usage[key]) p1Usage[key].faints += 1;
        } else if (event === 'faint' && actor.startsWith('p2')) {
          p2Faints += 1;
        }
        if (line.startsWith('|turn|')) {
          turns = Number(parts[2] || turns);
          if (p1ActiveKey && p1Usage[p1ActiveKey]) p1Usage[p1ActiveKey].activeTurns += 1;
        }
        if (line.startsWith('|win|')) winner = parts[2] || null;
        if (line === '|tie|') winner = 'tie';
      }
      if (winner) break;
    }
    return { winner, turns, p1Faints, p2Faints };
  })();

  await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen4customgame', seed: seedArray(seed) })}\n` +
    `>player p1 ${JSON.stringify({ name: 'Player', team: Teams.pack(preparedP1Team) })}\n` +
    `>player p2 ${JSON.stringify({ name: 'HGSS', team: Teams.pack(p2Team) })}`);

  const result = await resultPromise;
  await streams.omniscient.writeEnd();
  await Promise.allSettled([p1Task, p2Task]);
  return {
    ...result,
    p1Usage,
    p1AiMode: p1Mode,
    p1VoluntarySwitches: p1Stats.voluntarySwitches,
    p1ForcedSwitches: p1Stats.forcedSwitches,
    p2VoluntarySwitches: p2Stats.voluntarySwitches,
    p2ForcedSwitches: p2Stats.forcedSwitches,
    p2MoveDecisions: p2Stats.moveDecisions,
    p2TrainerItemsUsed: p2Stats.trainerItemsUsed,
    p2AiMode: p2Mode,
    p2AiFlags: p2Profile?.aiFlags || 0,
    p2AiFlagNames: p2Profile?.flags || [],
    p2TrainerItems: p2Profile?.items || [],
  };
}

export async function simulateMatchup(p1Team, p2Team, runs = 50, seedBase = 1, options = {}) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let totalTurns = 0;
  let totalP1VoluntarySwitches = 0;
  let totalP2VoluntarySwitches = 0;
  let totalP2ForcedSwitches = 0;
  let totalP2MoveDecisions = 0;
  let totalP2TrainerItemUses = 0;
  let totalP1Faints = 0;
  let totalP2Faints = 0;
  let maxP2Faints = 0;
  const p1Usage = {};
  let p1AiMode = options.p1AiMode || 'greedy';
  let p2AiMode = options.p2Trainer ? (options.p2AiMode || 'hgss') : (options.p2AiMode || 'greedy');
  let p2AiFlags = 0;
  let p2AiFlagNames = [];
  let p2TrainerItems = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await runBattle(p1Team, p2Team, seedBase + i, options);
    totalTurns += result.turns || 0;
    totalP1VoluntarySwitches += result.p1VoluntarySwitches || 0;
    totalP2VoluntarySwitches += result.p2VoluntarySwitches || 0;
    totalP2ForcedSwitches += result.p2ForcedSwitches || 0;
    totalP2MoveDecisions += result.p2MoveDecisions || 0;
    totalP2TrainerItemUses += result.p2TrainerItemsUsed?.length || 0;
    totalP1Faints += Number(result.p1Faints || 0);
    totalP2Faints += Number(result.p2Faints || 0);
    maxP2Faints = Math.max(maxP2Faints, Number(result.p2Faints || 0));
    for (const [key, usage] of Object.entries(result.p1Usage || {})) {
      const aggregate = p1Usage[key] || {
        runsAvailable: 0,
        runsUsed: 0,
        winningRunsUsed: 0,
        appearances: 0,
        leadStarts: 0,
        moveUses: 0,
        activeTurns: 0,
        faints: 0,
        winningMoveUses: 0,
        winningActiveTurns: 0,
      };
      const used = Number(usage.appearances || 0) > 0 ||
        Number(usage.moveUses || 0) > 0 ||
        Number(usage.activeTurns || 0) > 0;
      aggregate.runsAvailable += 1;
      if (used) aggregate.runsUsed += 1;
      if (used && result.winner === 'Player') aggregate.winningRunsUsed += 1;
      aggregate.appearances += Number(usage.appearances || 0);
      aggregate.leadStarts += Number(usage.leadStarts || 0);
      aggregate.moveUses += Number(usage.moveUses || 0);
      aggregate.activeTurns += Number(usage.activeTurns || 0);
      aggregate.faints += Number(usage.faints || 0);
      if (result.winner === 'Player') {
        aggregate.winningMoveUses += Number(usage.moveUses || 0);
        aggregate.winningActiveTurns += Number(usage.activeTurns || 0);
      }
      p1Usage[key] = aggregate;
    }
    p1AiMode = result.p1AiMode;
    p2AiMode = result.p2AiMode;
    p2AiFlags = result.p2AiFlags;
    p2AiFlagNames = result.p2AiFlagNames;
    p2TrainerItems = result.p2TrainerItems;
    if (result.winner === 'Player') wins += 1;
    else if (result.winner === 'HGSS') losses += 1;
    else ties += 1;
  }
  return {
    runs,
    wins,
    losses,
    ties,
    winRate: wins / runs,
    averageTurns: totalTurns / runs,
    averageP1VoluntarySwitches: totalP1VoluntarySwitches / runs,
    averageP2VoluntarySwitches: totalP2VoluntarySwitches / runs,
    averageP2ForcedSwitches: totalP2ForcedSwitches / runs,
    averageP2MoveDecisions: totalP2MoveDecisions / runs,
    averageP2TrainerItemUses: totalP2TrainerItemUses / runs,
    averageP1Faints: totalP1Faints / runs,
    averageP2Faints: totalP2Faints / runs,
    maxP2Faints,
    p1Usage,
    p1AiMode,
    p2AiMode,
    p2AiFlags,
    p2AiFlagNames,
    p2TrainerItems,
  };
}
