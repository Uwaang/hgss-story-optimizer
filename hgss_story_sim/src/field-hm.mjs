// Field HM rules (docs/research/CHARTER.md v1, "필드 비전기술").
//
//   required  confirmed field-HM requirements must be met by a party member
//             present at that checkpoint, and an HM move cannot be forgotten
//             before the Move Deleter (Blackthorn)
//   ignore    previous behaviour: HMs are ordinary moves (for comparison)
//
// The state walks the route in boss order, so it must see the checkpoints in
// the same order the evaluator battles them.

import FIELD_HM from '../config/field-hm-requirements.hgss.json' with { type: 'json' };

export const HM_POLICIES = ['required', 'ignore'];
export const FIELD_HM_RULES_VERSION = 'charter-v1-field-hm-1';

const HM_MOVES = new Set(FIELD_HM.hmMoves);

export function normalizeHmPolicy(value) {
  const policy = String(value || 'ignore').toLowerCase();
  if (!HM_POLICIES.includes(policy)) {
    throw new Error(`Unknown HM policy: ${value} (expected ${HM_POLICIES.join(' | ')})`);
  }
  return policy;
}

export function isHmMove(move) {
  return HM_MOVES.has(String(move));
}

export function confirmedFieldHmRequirements() {
  return FIELD_HM.requirements.filter(row => row.status === 'confirmed');
}

// Replaces the slot whose loss costs the least, by the same route moveset
// score the move optimizer uses. HM slots that must be kept are never chosen.
function bestInsertion(moves, newMove, keep, score) {
  if (moves.includes(newMove)) return { moves, loss: 0 };
  if (moves.length < 4) {
    const next = [...moves, newMove];
    return { moves: next, loss: score(moves) - score(next) };
  }
  const base = score(moves);
  let best = null;
  for (let slot = 0; slot < moves.length; slot += 1) {
    if (keep.has(moves[slot])) continue;
    const next = moves.map((move, index) => (index === slot ? newMove : move));
    const loss = base - score(next);
    if (!best || loss < best.loss - 1e-12 || (Math.abs(loss - best.loss) <= 1e-12 && slot < best.slot)) {
      best = { moves: next, loss, slot };
    }
  }
  return best;
}

export function createFieldHmRouteState(policy = 'ignore') {
  const mode = normalizeHmPolicy(policy);
  const knownHms = new Map(); // candidate key -> Set of HM moves currently known
  const log = [];
  const violations = [];
  const requirements = confirmedFieldHmRequirements();
  const deleterStage = Number(FIELD_HM.moveDeleter.availableFromStage);

  // team: materialized mons carrying _candidateKey and their chosen moves.
  // legalMoves(mon) -> Set of moves that mon may know at this checkpoint.
  // score(mon, moves) -> route moveset score (higher is better).
  function applyAtCheckpoint({ boss, moveStage, team, legalMoves, score }) {
    if (mode === 'ignore') return team;
    const stage = Number(moveStage);
    const canForget = stage >= deleterStage;
    let next = team.map(mon => ({ ...mon, moves: [...(mon.moves || [])] }));
    const keyOf = mon => mon._candidateKey || mon.species;

    // 1. An HM learned earlier stays until the Move Deleter is reachable.
    if (!canForget) {
      next = next.map(mon => {
        const kept = knownHms.get(keyOf(mon));
        if (!kept?.size) return mon;
        let moves = mon.moves;
        for (const hm of kept) {
          if (moves.includes(hm)) continue;
          const inserted = bestInsertion(moves, hm, kept, candidate => score(mon, candidate));
          if (!inserted) {
            violations.push({ boss: String(boss.label), key: keyOf(mon), move: hm, reason: 'no free slot to keep HM' });
            continue;
          }
          moves = inserted.moves;
          log.push({ boss: String(boss.label), key: keyOf(mon), move: hm, action: 'kept-until-move-deleter' });
        }
        return { ...mon, moves };
      });
    }

    // 2. Confirmed field requirements for this checkpoint.
    for (const requirement of requirements) {
      if (String(requirement.beforeBoss) !== String(boss.label)) continue;
      if (next.some(mon => mon.moves.includes(requirement.move))) continue;
      let choice = null;
      for (const mon of next) {
        if (!legalMoves(mon).has(requirement.move)) continue;
        const kept = new Set([...(knownHms.get(keyOf(mon)) || [])].filter(() => !canForget));
        const inserted = bestInsertion(mon.moves, requirement.move, kept, candidate => score(mon, candidate));
        if (!inserted) continue;
        if (
          !choice ||
          inserted.loss < choice.loss - 1e-12 ||
          (Math.abs(inserted.loss - choice.loss) <= 1e-12 && keyOf(mon) < keyOf(choice.mon))
        ) {
          choice = { mon, moves: inserted.moves, loss: inserted.loss };
        }
      }
      if (!choice) {
        violations.push({ boss: String(boss.label), move: requirement.move, requirement: requirement.id, reason: 'no party member can learn it' });
        continue;
      }
      next = next.map(mon => (mon === choice.mon ? { ...mon, moves: choice.moves } : mon));
      log.push({ boss: String(boss.label), key: keyOf(choice.mon), move: requirement.move, action: 'taught-for-field', requirement: requirement.id });
    }

    // 3. Remember which HMs each member knows now.
    for (const mon of next) {
      const known = new Set(mon.moves.filter(isHmMove));
      if (canForget) {
        knownHms.set(keyOf(mon), known);
      } else {
        const previous = knownHms.get(keyOf(mon)) || new Set();
        knownHms.set(keyOf(mon), new Set([...previous, ...known]));
      }
    }
    return next;
  }

  function summary() {
    return {
      policy: mode,
      version: FIELD_HM_RULES_VERSION,
      feasible: violations.length === 0,
      requirements: mode === 'ignore' ? [] : requirements.map(row => row.id),
      actions: log,
      violations,
    };
  }

  return { applyAtCheckpoint, summary, mode };
}
