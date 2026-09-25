import Showdown from 'pokemon-showdown';
const { BattleStream, Dex, Teams, getPlayerStreams } = Showdown;
import { constantToName, npcIvFromDifficulty } from './hgss-data.mjs';

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
  const fixedDamage = typeof move.damage === 'number' ? move.damage : 0;
  const power = Math.max(move.basePower || 0, fixedDamage || 1);
  return power * accuracy * stab * priority * (0.55 + offensiveStat / 120);
}

export function candidateMovePool(speciesName, level, stage, moveAccess = null) {
  const species = dex.species.get(speciesName);
  if (!species.exists) throw new Error(`Unknown Gen 4 species: ${speciesName}`);

  const moves = new Set(levelUpMovePool(species.name, level));
  for (const machine of moveAccess?.reusableMachines || []) {
    if (Number(machine.availableFrom) > stage) continue;
    if (canLearnGen4Machine(species, machine.move)) moves.add(machine.move);
  }
  return [...moves];
}

export function selectCandidateMoves(speciesName, level, stage, moveAccess = null) {
  const species = dex.species.get(speciesName);
  const pool = candidateMovePool(speciesName, level, stage, moveAccess);
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

function candidateSpeciesAtStage(mon, stage) {
  let speciesName = mon.species;
  const transitions = Array.isArray(mon.speciesByStage) ? [...mon.speciesByStage] : [];
  transitions.sort((a, b) => Number(a.stage) - Number(b.stage));
  for (const transition of transitions) {
    if (Number(transition.stage) <= stage) speciesName = transition.species;
  }
  return speciesName;
}

export function materializeCandidateTeam(candidates, stage, level, options = {}) {
  const moveAccess = options.moveAccess || null;
  return candidates
    .filter(mon => Number(mon.availableFrom || 0) <= stage)
    .slice(0, 6)
    .map(mon => {
      const speciesName = candidateSpeciesAtStage(mon, stage);
      const species = dex.species.get(speciesName);
      if (!species.exists) throw new Error(`Unknown candidate species: ${speciesName}`);
      const moves = Array.isArray(mon.moves) && mon.moves.length
        ? mon.moves
        : selectCandidateMoves(species.name, level, stage, moveAccess);
      return {
        name: species.name,
        species: species.name,
        level,
        item: mon.item || '',
        ability: mon.ability || species.abilities['0'],
        nature: mon.nature || NEUTRAL_NATURE,
        ivs: mon.ivs || uniformIvs(20),
        evs: mon.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        moves: moves.length ? moves : ['Tackle'],
      };
    });
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

function scoreMove(active, target, requestedMove) {
  const move = dex.moves.get(requestedMove.move);
  if (!move.exists || requestedMove.disabled) return -Infinity;
  if (move.category === 'Status') {
    const useful = new Set(['recover', 'roost', 'synthesis', 'hypnosis', 'thunderwave', 'toxic', 'willowisp', 'swordsdance', 'dragondance', 'calmmind']);
    return useful.has(move.id) ? 18 : 2;
  }
  const immunity = dex.getImmunity(move.type, target);
  if (!immunity) return 0;
  const typeMod = dex.getEffectiveness(move, target);
  const effectiveness = 2 ** typeMod;
  const stab = active.getTypes().includes(move.type) ? 1.5 : 1;
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  const priority = move.priority > 0 ? 1.05 : 1;
  return Math.max(move.basePower || 1, 1) * effectiveness * stab * accuracy * priority;
}

function selectChoice(request, battleStream, sideId) {
  if (request.wait) return null;
  if (request.teamPreview) return 'default';
  const battle = battleStream.battle;
  const sideIndex = sideId === 'p1' ? 0 : 1;
  const foeIndex = sideIndex === 0 ? 1 : 0;
  const side = battle?.sides?.[sideIndex];
  const foe = battle?.sides?.[foeIndex];

  if (request.forceSwitch) {
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
      const legal = activeRequest.moves
        .map((move, idx) => ({ idx, move, score: active && foeActive ? scoreMove(active, foeActive, move) : 1 }))
        .filter(entry => !entry.move.disabled);
      if (!legal.length) return 'move 1';
      legal.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return `move ${legal[0].idx + 1}`;
    });
    return choices.join(', ');
  }
  return 'default';
}

async function runGreedyAi(playerStream, battleStream, sideId) {
  for await (const chunk of playerStream) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|request|')) continue;
      const request = JSON.parse(line.slice('|request|'.length));
      const choice = selectChoice(request, battleStream, sideId);
      if (choice) await playerStream.write(choice);
    }
  }
}

export async function runBattle(p1Team, p2Team, seed = 1) {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);
  const p1Task = runGreedyAi(streams.p1, battleStream, 'p1').catch(() => undefined);
  const p2Task = runGreedyAi(streams.p2, battleStream, 'p2').catch(() => undefined);
  const resultPromise = (async () => {
    let winner = null;
    let turns = 0;
    for await (const chunk of streams.omniscient) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('|turn|')) turns = Number(line.split('|')[2] || turns);
        if (line.startsWith('|win|')) winner = line.split('|')[2] || null;
        if (line === '|tie|') winner = 'tie';
      }
      if (winner) break;
    }
    return { winner, turns };
  })();

  await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen4customgame', seed: seedArray(seed) })}\n` +
    `>player p1 ${JSON.stringify({ name: 'Player', team: Teams.pack(p1Team) })}\n` +
    `>player p2 ${JSON.stringify({ name: 'HGSS', team: Teams.pack(p2Team) })}`);

  const result = await resultPromise;
  await streams.omniscient.writeEnd();
  await Promise.allSettled([p1Task, p2Task]);
  return result;
}

export async function simulateMatchup(p1Team, p2Team, runs = 50, seedBase = 1) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let totalTurns = 0;
  for (let i = 0; i < runs; i += 1) {
    const result = await runBattle(p1Team, p2Team, seedBase + i);
    totalTurns += result.turns || 0;
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
  };
}
