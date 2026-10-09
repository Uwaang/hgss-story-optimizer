import Showdown from 'pokemon-showdown';
const { Dex } = Showdown;

const dex = Dex.mod('gen4');

export const HGSS_AI_FLAGS = Object.freeze({
  BASIC: 1 << 0,
  EVAL_ATTACK: 1 << 1,
  EXPERT: 1 << 2,
  SETUP_FIRST_TURN: 1 << 3,
  RISKY: 1 << 4,
  PRIORITIZE_EXTREMES: 1 << 5,
  BATON_PASS: 1 << 6,
  TAG_STRATEGY: 1 << 7,
  CHECK_HP: 1 << 8,
  WEATHER: 1 << 9,
  HARRASSMENT: 1 << 10,
});

export function decodeHgssAiFlags(mask) {
  const value = Number(mask || 0) >>> 0;
  return Object.entries(HGSS_AI_FLAGS)
    .filter(([, bit]) => (value & bit) !== 0)
    .map(([name]) => name);
}

export function trainerAiProfile(trainerMeta) {
  const trainer = trainerMeta?.trainer || trainerMeta || {};
  const aiFlags = Number(trainer.ai_flags ?? trainer.aiFlags ?? 0) >>> 0;
  const items = Array.isArray(trainer.items)
    ? trainer.items.filter(item => item && item !== 'ITEM_NONE')
    : [];
  return {
    trainerId: Number.isInteger(Number(trainerMeta?.trainerId))
      ? Number(trainerMeta.trainerId)
      : null,
    aiFlags,
    flags: decodeHgssAiFlags(aiFlags),
    items,
  };
}


const TRAINER_HP_ITEMS = Object.freeze({
  ITEM_POTION: 20,
  ITEM_SUPER_POTION: 50,
  ITEM_HYPER_POTION: 200,
  ITEM_MAX_POTION: Infinity,
});

export function chooseHgssTrainerItem(active, side, itemSlots, initialItemCount = null) {
  if (!active || active.fainted || !active.hp || !active.maxhp) return null;
  const slots = Array.isArray(itemSlots) ? itemSlots : [];
  if (!slots.length) return null;

  const aliveMons = (side?.pokemon || []).filter(mon => mon && !mon.fainted && Number(mon.hp || 0) > 0).length;
  const trainerItemCount = Number.isFinite(Number(initialItemCount))
    ? Number(initialItemCount)
    : slots.filter(Boolean).length;
  const hp = Number(active.hp);
  const maxhp = Number(active.maxhp);
  const missing = Math.max(0, maxhp - hp);

  for (let i = 0; i < slots.length; i += 1) {
    const item = slots[i];
    if (!item) continue;

    // Mirrors the Gen 4 TrainerAI_ShouldUseItem gate: the first item is always
    // eligible for evaluation; later item slots become eligible as the party
    // gets smaller.
    if (i !== 0 && aliveMons > trainerItemCount - i + 1) continue;

    if (item === 'ITEM_FULL_RESTORE') {
      if (hp > 0 && hp < maxhp / 4) {
        return {
          index: i,
          item,
          healAmount: Infinity,
          cureStatus: true,
          cureConfusion: true,
        };
      }
      continue;
    }

    const healAmount = TRAINER_HP_ITEMS[item];
    if (healAmount !== undefined) {
      if (
        hp > 0 &&
        (
          hp < maxhp / 4 ||
          healAmount === Infinity ||
          missing > healAmount
        )
      ) {
        return {
          index: i,
          item,
          healAmount,
          cureStatus: false,
          cureConfusion: false,
        };
      }
    }
  }

  return null;
}

function requestAliveBench(request, side) {
  const out = [];
  const requested = request?.side?.pokemon || [];
  const sideMons = side?.pokemon || [];
  for (let idx = 0; idx < Math.min(requested.length, sideMons.length); idx += 1) {
    const reqMon = requested[idx];
    const mon = sideMons[idx];
    if (!reqMon || !mon || reqMon.active || mon.fainted || String(reqMon.condition || '').endsWith(' fnt')) continue;
    out.push({ idx, mon, reqMon });
  }
  return out;
}

function monTypes(mon) {
  if (typeof mon?.getTypes === 'function') return mon.getTypes();
  const species = dex.species.get(mon?.species?.name || mon?.species || mon?.name || '');
  return species.exists ? species.types : [];
}

function targetSpecies(target) {
  return target?.species?.name || target?.species || target?.name || '';
}

function typeOffenseScore(attackingType, target) {
  const species = dex.species.get(targetSpecies(target));
  if (!species.exists) return 0;
  if (!dex.getImmunity(attackingType, species)) return 0;
  return 2 ** dex.getEffectiveness(attackingType, species);
}

function moveEffectiveness(move, target) {
  const species = dex.species.get(targetSpecies(target));
  if (!move?.exists || !species.exists) return 0;
  if (!dex.getImmunity(move.type, species)) return 0;
  return 2 ** dex.getEffectiveness(move, species);
}

function movePotential(mon, target, slot) {
  const move = dex.moves.get(slot?.id || slot?.move || slot || '');
  if (!move.exists || move.category === 'Status' || slot?.disabled) return 0;
  const effectiveness = moveEffectiveness(move, target);
  if (effectiveness <= 0) return 0;
  const stab = monTypes(mon).includes(move.type) ? 1.5 : 1;
  const accuracy = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  const priority = move.priority > 0 ? 1.05 : 1;
  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = Math.max(1, Number(mon?.getStat?.(attackStat) || mon?.storedStats?.[attackStat] || 1));
  const defense = Math.max(1, Number(target?.getStat?.(defenseStat) || target?.storedStats?.[defenseStat] || 1));
  const power = typeof move.damage === 'number' ? move.damage : Math.max(1, Number(move.basePower || 0));
  return power * (attack / defense) * effectiveness * stab * accuracy * priority;
}

function hasSuperEffectiveMove(mon, target) {
  return (mon?.moveSlots || []).some(slot => {
    const move = dex.moves.get(slot?.id || slot?.move || '');
    return move.exists && move.category !== 'Status' && !slot.disabled && moveEffectiveness(move, target) > 1;
  });
}

function hasAnyEffectiveDamage(mon, target) {
  return (mon?.moveSlots || []).some(slot => {
    const move = dex.moves.get(slot?.id || slot?.move || '');
    return move.exists && move.category !== 'Status' && !slot.disabled && moveEffectiveness(move, target) > 0;
  });
}

function maxMovePotential(mon, target) {
  let best = 0;
  for (const slot of mon?.moveSlots || []) best = Math.max(best, movePotential(mon, target, slot));
  return best;
}


function estimatedDamage(mon, target, slot) {
  const move = dex.moves.get(slot?.id || slot?.move || slot || '');
  if (!move.exists || move.category === 'Status' || slot?.disabled) return 0;
  const effectiveness = moveEffectiveness(move, target);
  if (effectiveness <= 0) return 0;
  if (typeof move.damage === 'number') return move.damage * effectiveness;

  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = Math.max(1, Number(mon?.getStat?.(attackStat) || mon?.storedStats?.[attackStat] || 1));
  const defense = Math.max(1, Number(target?.getStat?.(defenseStat) || target?.storedStats?.[defenseStat] || 1));
  const level = Math.max(1, Number(mon?.level || 50));
  const power = Math.max(1, Number(move.basePower || 0));
  const stab = monTypes(mon).includes(move.type) ? 1.5 : 1;
  const base = (((2 * level / 5 + 2) * power * attack / defense) / 50) + 2;
  return base * stab * effectiveness;
}

function targetHasType(target, type) {
  return monTypes(target).includes(type);
}

function moveIsRecovery(move) {
  return Boolean(move?.heal) || ['recover', 'roost', 'synthesis', 'moonlight', 'morningsun', 'milkdrink', 'slackoff', 'softboiled'].includes(move?.id);
}

function moveIsSetup(move) {
  if (!move?.exists || move.category !== 'Status') return false;
  if (move.target === 'self' && (move.boosts || move.self?.boosts)) return true;
  if (move.self?.boosts) return true;
  return new Set([
    'swordsdance', 'dragondance', 'calmmind', 'nastyplot', 'agility',
    'rockpolish', 'irondefense', 'amnesia', 'bulkup', 'cosmicpower',
    'doubleteam', 'minimize', 'focusenergy', 'substitute',
    'reflect', 'lightscreen', 'safeguard', 'tailwind',
  ]).has(move.id);
}

function statusMoveAdjustment(move, active, target, battle) {
  let score = 0;
  const targetStatus = String(target?.status || '');
  const activeHp = active?.maxhp > 0 ? active.hp / active.maxhp : 1;

  if (move.status) {
    if (targetStatus) return -10;
    if ((move.status === 'psn' || move.status === 'tox') && (targetHasType(target, 'Poison') || targetHasType(target, 'Steel'))) {
      return -10;
    }
    if (move.status === 'par' && move.type === 'Electric' && targetHasType(target, 'Ground')) return -10;
    score += 1;
  }

  if (move.volatileStatus === 'confusion' && target?.volatiles?.confusion) return -10;
  if (moveIsRecovery(move)) {
    if (activeHp >= 0.99) return -10;
    if (activeHp <= 0.35) score += 4;
    else if (activeHp <= 0.6) score += 2;
    else if (activeHp > 0.8) score -= 2;
  }

  if (moveIsSetup(move)) {
    const selfBoosts = move.self?.boosts || (move.target === 'self' ? move.boosts : null) || {};
    const capped = Object.entries(selfBoosts).every(([stat, delta]) => Number(delta) <= 0 || Number(active?.boosts?.[stat] || 0) >= 6);
    if (Object.keys(selfBoosts).length && capped) return -10;
    if (activeHp >= 0.65) score += 2;
    if (activeHp <= 0.3) score -= 2;
  }

  if (move.id === 'protect' || move.id === 'detect') {
    if (active?.volatiles?.protect) score -= 2;
    else score += 1;
  }
  if (move.id === 'substitute') {
    if (activeHp <= 0.25 || active?.volatiles?.substitute) score -= 4;
    else if (activeHp > 0.55) score += 2;
  }
  if (move.id === 'leechseed') {
    if (target?.volatiles?.leechseed || targetHasType(target, 'Grass')) score -= 8;
    else score += 2;
  }

  if (move.weather) {
    const currentWeather = String(battle?.field?.weather || '');
    if (currentWeather && currentWeather === String(move.weather)) score -= 4;
  }

  return score;
}

function expertMoveAdjustment(move, active, target, battle, randomChance) {
  let score = statusMoveAdjustment(move, active, target, battle);
  if (score <= -8) return score;

  const hpRatio = active?.maxhp > 0 ? active.hp / active.maxhp : 1;
  const foeHpRatio = target?.maxhp > 0 ? target.hp / target.maxhp : 1;

  if (['hypnosis', 'sleeppowder', 'sing', 'spore'].includes(move.id) && !target?.status) score += 2;
  if (['toxic', 'willowisp', 'thunderwave', 'stunspore'].includes(move.id) && !target?.status) score += 2;
  if (moveIsRecovery(move) && hpRatio < 0.5) score += 2;
  if (moveIsSetup(move) && hpRatio > 0.6) score += 1;
  if (move.id === 'uturn') score += 1;
  if (move.id === 'pursuit' && target?.activeTurns === 1) score += 1;
  if (move.id === 'brine' && foeHpRatio <= 0.5) score += 2;
  if (move.id === 'payback') score += 1;
  if (move.id === 'suckerpunch' && randomChance(1, 2)) score += 1;
  if (move.id === 'destinybond' && hpRatio <= 0.35) score += 2;

  return score;
}

function weatherFlagAdjustment(move, active, battle) {
  if (!move.weather) return 0;
  const battleTurn = Number(battle?.turn || 0);
  const activeTurns = Number(active?.activeTurns || 0);
  if (battleTurn > 1 || activeTurns > 1) return 0;
  if (String(battle?.field?.weather || '') === String(move.weather)) return 0;
  return 5;
}

function setupFirstTurnAdjustment(move, active, battle, randomChance) {
  if (!moveIsSetup(move)) return 0;
  const battleTurn = Number(battle?.turn || 0);
  if (battleTurn > 1) return 0;
  return randomChance(176, 256) ? 2 : 0;
}

function riskyAdjustment(move, randomChance) {
  const risky = new Set([
    'hypnosis', 'sing', 'sleeppowder', 'spore', 'explosion', 'selfdestruct',
    'metronome', 'counter', 'mirrorcoat', 'destinybond', 'swagger',
    'focuspunch', 'suckerpunch', 'guillotine', 'fissure', 'horndrill',
  ]);
  return risky.has(move.id) && randomChance(1, 2) ? 2 : 0;
}

function prioritizeExtremesAdjustment(move, randomChance) {
  const extreme = move.category === 'Status' || typeof move.damage === 'number' || !move.basePower;
  return extreme && randomChance(156, 256) ? 2 : 0;
}

function harassmentAdjustment(move, randomChance) {
  const harassment = new Set([
    'hypnosis', 'sleeppowder', 'sing', 'spore', 'growl', 'charm', 'screech',
    'sandattack', 'smokescreen', 'confuseray', 'supersonic', 'toxic',
    'poisonpowder', 'thunderwave', 'stunspore', 'leechseed', 'encore',
    'spikes', 'swagger', 'attract', 'torment', 'willowisp', 'knockoff',
    'embargo', 'toxicspikes',
  ]);
  return harassment.has(move.id) && randomChance(1, 2) ? 2 : 0;
}

export function chooseHgssMoveIndex(activeRequest, active, target, aiFlags, battle, randomChance = () => false) {
  const legal = (activeRequest?.moves || [])
    .map((slot, idx) => ({ slot, idx, move: dex.moves.get(slot?.id || slot?.move || '') }))
    .filter(entry => !entry.slot?.disabled && entry.move.exists);
  if (!legal.length) return 0;

  const flags = Number(aiFlags || 0) >>> 0;
  const damages = legal.map(entry => estimatedDamage(active, target, entry.slot));
  const maxDamage = Math.max(...damages, 0);

  const scored = legal.map((entry, pos) => {
    const { move } = entry;
    const damage = damages[pos];
    let score = 100;

    if (flags & HGSS_AI_FLAGS.BASIC) {
      if (move.category !== 'Status') {
        if (moveEffectiveness(move, target) <= 0) score -= 12;
      } else {
        score += statusMoveAdjustment(move, active, target, battle);
      }
    }

    if (flags & HGSS_AI_FLAGS.EXPERT) {
      score += expertMoveAdjustment(move, active, target, battle, randomChance);
    }

    if (flags & HGSS_AI_FLAGS.EVAL_ATTACK) {
      if (move.category !== 'Status' && maxDamage > 0 && damage + 1e-9 < maxDamage) score -= 1;
      const canKo = move.category !== 'Status' && Number(target?.hp || 0) > 0 && damage >= Number(target.hp);
      if (canKo && !['explosion', 'selfdestruct'].includes(move.id)) {
        score += 4;
        if (Number(move.priority || 0) > 0) score += 2;
      } else if (moveEffectiveness(move, target) >= 4 && randomChance(176, 256)) {
        score += 2;
      }
      if (['explosion', 'selfdestruct', 'focuspunch', 'suckerpunch'].includes(move.id) && randomChance(205, 256)) {
        score -= 2;
      }
    }

    if (flags & HGSS_AI_FLAGS.SETUP_FIRST_TURN) {
      score += setupFirstTurnAdjustment(move, active, battle, randomChance);
    }
    if (flags & HGSS_AI_FLAGS.RISKY) score += riskyAdjustment(move, randomChance);
    if (flags & HGSS_AI_FLAGS.PRIORITIZE_EXTREMES) score += prioritizeExtremesAdjustment(move, randomChance);
    if (flags & HGSS_AI_FLAGS.WEATHER) score += weatherFlagAdjustment(move, active, battle);
    if (flags & HGSS_AI_FLAGS.HARRASSMENT) score += harassmentAdjustment(move, randomChance);

    // Keep the Gen 4 score system discrete while using estimated damage only as a
    // tie-breaker. This prevents the old raw-damage heuristic from overpowering
    // status/setup decisions once trainer AI flags are enabled.
    return { ...entry, score, damage };
  });

  scored.sort((a, b) => b.score - a.score || b.damage - a.damage || a.idx - b.idx);
  const bestScore = scored[0].score;
  const bestDamage = scored[0].damage;
  const tied = scored.filter(entry => entry.score === bestScore && Math.abs(entry.damage - bestDamage) < 1e-9);
  let chosen = tied[0];
  for (let i = 1; i < tied.length; i += 1) {
    if (randomChance(1, i + 1)) chosen = tied[i];
  }
  return chosen.idx;
}

function offensiveTypeMatchupScore(mon, target) {
  return monTypes(mon).reduce((sum, type) => sum + typeOffenseScore(type, target), 0);
}

// Mirrors the two-stage Gen 4 post-KO switch-in structure visible in pret/pokeplatinum:
// 1) prefer the best offensive type matchup that also owns a super-effective move;
// 2) otherwise prefer the bench member with the strongest immediate damage potential.
// HGSS keeps the corresponding routine in overlay_10_trainer_ai.s.
export function hgssMoveChoiceDistribution(activeRequest, active, target, aiFlags, battle) {
  const probabilities = new Map();
  let leaves = 0;

  const walk = (path, weight) => {
    if (!(weight > 0)) return;
    let cursor = 0;
    try {
      const chosen = chooseHgssMoveIndex(
        activeRequest,
        active,
        target,
        aiFlags,
        battle,
        (numerator, denominator) => {
          const den = Math.max(1, Math.floor(Number(denominator || 1)));
          const num = Math.max(0, Math.min(den, Math.floor(Number(numerator || 0))));
          if (cursor < path.length) return Boolean(path[cursor++]);
          const branch = new Error('HGSS_AI_DISTRIBUTION_BRANCH');
          branch.hgssAiDistributionBranch = true;
          branch.numerator = num;
          branch.denominator = den;
          throw branch;
        },
      );
      probabilities.set(chosen, Number(probabilities.get(chosen) || 0) + weight);
      leaves += 1;
    } catch (error) {
      if (!error?.hgssAiDistributionBranch) throw error;
      const den = Math.max(1, Number(error.denominator || 1));
      const yes = Math.max(0, Math.min(1, Number(error.numerator || 0) / den));
      if (yes < 1) walk([...path, false], weight * (1 - yes));
      if (yes > 0) walk([...path, true], weight * yes);
    }
  };

  walk([], 1);
  const total = [...probabilities.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    probabilities: [...probabilities.entries()]
      .map(([moveIndex, probability]) => ({
        moveIndex: Number(moveIndex),
        probability: total > 0 ? Number(probability) / total : 0,
      }))
      .sort((a, b) => a.moveIndex - b.moveIndex),
    leaves,
  };
}

export function chooseHgssPostKoSwitch(request, side, foeActive) {
  if (!foeActive) return null;
  const bench = requestAliveBench(request, side);
  if (!bench.length) return null;

  const stage1 = bench
    .map(entry => ({ ...entry, typeScore: offensiveTypeMatchupScore(entry.mon, foeActive) }))
    .sort((a, b) => b.typeScore - a.typeScore || a.idx - b.idx);

  for (const entry of stage1) {
    if (hasSuperEffectiveMove(entry.mon, foeActive)) return entry.idx;
  }

  let best = null;
  for (const entry of bench) {
    const damage = maxMovePotential(entry.mon, foeActive);
    if (!best || damage > best.damage || (damage === best.damage && entry.idx < best.idx)) {
      best = { ...entry, damage };
    }
  }
  return best?.idx ?? bench[0].idx;
}

function positiveBoostTotal(mon) {
  return Object.values(mon?.boosts || {}).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
}

function perishCount(mon) {
  const volatiles = mon?.volatiles || {};
  for (const key of Object.keys(volatiles)) {
    const match = /^perish(\d+)$/.exec(key);
    if (match) return Number(match[1]);
  }
  return null;
}

function abilityId(mon) {
  return String(mon?.ability || mon?.getAbility?.()?.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Conservative port of the Gen 4 trainer switch decision tree. The exact HGSS routine
// remains assembly, so only branches that map cleanly onto Showdown state are enabled.
// This deliberately avoids the old generic 1.55x "smart switch" heuristic for NPCs.
export function chooseHgssVoluntarySwitch(request, side, foeActive, active, activeRequest, randomChance = () => false) {
  if (!active || !foeActive || active.fainted || activeRequest?.trapped || activeRequest?.maybeTrapped) return null;
  const bench = requestAliveBench(request, side);
  if (!bench.length) return null;

  const postKo = () => chooseHgssPostKoSwitch(request, side, foeActive);

  const perish = perishCount(active);
  if (perish !== null && perish <= 1) return postKo();

  const foeAbility = abilityId(foeActive);
  if (foeAbility === 'wonderguard' && !hasAnyEffectiveDamage(active, foeActive)) return postKo();

  if (!hasAnyEffectiveDamage(active, foeActive)) return postKo();

  if (active.status === 'slp' && abilityId(active) === 'naturalcure' && active.maxhp > 0 && active.hp * 2 >= active.maxhp) {
    if (randomChance(1, 2)) return postKo();
  }

  // Platinum/HGSS stop considering ordinary tactical switches if the active mon
  // already has a super-effective attack or is heavily boosted.
  if (hasSuperEffectiveMove(active, foeActive)) return null;
  if (positiveBoostTotal(active) >= 4) return null;

  const candidates = bench
    .filter(entry => hasSuperEffectiveMove(entry.mon, foeActive))
    .map(entry => ({ ...entry, damage: maxMovePotential(entry.mon, foeActive) }))
    .sort((a, b) => b.damage - a.damage || a.idx - b.idx);

  if (!candidates.length) return null;

  // The original logic contains probabilistic tactical-switch branches. We keep
  // that stochastic behavior seed-driven rather than switching on every small edge.
  if (randomChance(1, 3) || randomChance(1, 4)) return candidates[0].idx;
  return null;
}
