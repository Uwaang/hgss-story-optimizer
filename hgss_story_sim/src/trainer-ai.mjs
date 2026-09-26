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

function offensiveTypeMatchupScore(mon, target) {
  return monTypes(mon).reduce((sum, type) => sum + typeOffenseScore(type, target), 0);
}

// Mirrors the two-stage Gen 4 post-KO switch-in structure visible in pret/pokeplatinum:
// 1) prefer the best offensive type matchup that also owns a super-effective move;
// 2) otherwise prefer the bench member with the strongest immediate damage potential.
// HGSS keeps the corresponding routine in overlay_10_trainer_ai.s.
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
