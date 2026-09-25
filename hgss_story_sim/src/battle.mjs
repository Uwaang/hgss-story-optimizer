import Showdown from 'pokemon-showdown';
const { BattleStream, Dex, Teams, getPlayerStreams } = Showdown;
import { constantToName, npcIvFromDifficulty } from './hgss-data.mjs';

const dex = Dex.mod('gen4');
const NEUTRAL_NATURE = 'Serious';

function uniformIvs(iv) {
  return { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv };
}

function chooseAbility(species, override = 'TRPOKE_ABILITY_OVERRIDE_OFF') {
  if (override === 'TRPOKE_ABILITY_OVERRIDE_SECOND') {
    return species.abilities['1'] || species.abilities['0'];
  }
  return species.abilities['0'];
}

export function levelUpMoves(speciesName, level) {
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
  return unique.slice(-4).map(x => x.name);
}

export function hgssTrainerToShowdownTeam(trainer) {
  return trainer.party.map(mon => {
    const speciesName = constantToName(mon.species, 'SPECIES_');
    const species = dex.species.get(speciesName);
    if (!species.exists) throw new Error(`Could not map HGSS species constant ${mon.species}`);
    const moves = Array.isArray(mon.moves) && mon.moves.length
      ? mon.moves.filter(x => x && x !== 'MOVE_NONE').map(x => constantToName(x, 'MOVE_'))
      : levelUpMoves(species.name, mon.level);
    const item = constantToName(mon.item || 'ITEM_NONE', 'ITEM_');
    const iv = npcIvFromDifficulty(mon.difficulty);
    return {
      name: species.name,
      species: species.name,
      level: mon.level,
      item,
      ability: chooseAbility(species, mon.abilityOverride),
      nature: NEUTRAL_NATURE,
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

export function materializeCandidateTeam(candidates, stage, level) {
  return candidates
    .filter(mon => Number(mon.availableFrom || 0) <= stage)
    .slice(0, 6)
    .map(mon => {
      const speciesName = candidateSpeciesAtStage(mon, stage);
      const species = dex.species.get(speciesName);
      if (!species.exists) throw new Error(`Unknown candidate species: ${speciesName}`);
      const moves = Array.isArray(mon.moves) && mon.moves.length
        ? mon.moves
        : levelUpMoves(species.name, level);
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
