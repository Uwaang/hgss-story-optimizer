// Comparison axes for Research v3 (docs/research/CHARTER.md, "비교 축").
//
// Every v1 script and workflow must take these numbers from here instead of
// recomputing them. All four axes are "lower is better"; there are no
// thresholds or weights in this module.

export const COMPARISON_AXES_VERSION = 'charter-v1-axes-1';

export const E4_CHAIN_GROUPS = [
  { key: 'first', labels: ['Will', 'Koga', 'Bruno', 'Karen', 'Lance'] },
  { key: 'second', labels: ['Will 2', 'Koga 2', 'Bruno 2', 'Karen 2', 'Lance 2'] },
];

// Party level spread is measured at entry to these checkpoints.
export const LEVEL_SPREAD_CHECKPOINTS = ['Will', 'Will 2', 'Red'];

export const PARTY_SIZE = 6;

function activeRows(evaluation) {
  return (evaluation?.rows || []).filter(row => !row?.skipped);
}

// Posterior mean of the clear probability: (wins + 1) / (runs + 2).
// Ties count as runs that did not clear.
export function checkpointClearProbability(row) {
  const wins = Math.max(0, Number(row?.wins || 0));
  const runs = Number.isFinite(Number(row?.runs))
    ? Math.max(0, Number(row.runs))
    : wins + Math.max(0, Number(row?.losses || 0)) + Math.max(0, Number(row?.ties || 0));
  return (wins + 1) / (runs + 2);
}

// Expected number of lost attempts over the whole route. A complete Elite
// Four chain is one restart unit: its clear probability is the product of
// its members, or an explicit override (e.g. an inventory DP estimate).
export function expectedRetries(evaluation, { chainProbabilityOverrides = {} } = {}) {
  const rows = activeRows(evaluation);
  const byLabel = new Map(rows.map(row => [String(row.boss), row]));
  const chained = new Set();
  const chains = [];
  let total = 0;

  for (const group of E4_CHAIN_GROUPS) {
    const groupRows = group.labels.map(label => byLabel.get(label));
    if (groupRows.some(row => !row)) continue;
    for (const label of group.labels) chained.add(label);
    const override = Number(chainProbabilityOverrides?.[group.key]);
    const probability = Number.isFinite(override) && override > 0
      ? Math.min(1, override)
      : groupRows.reduce((product, row) => product * checkpointClearProbability(row), 1);
    const retries = (1 - probability) / probability;
    total += retries;
    chains.push({
      key: group.key,
      probability,
      source: Number.isFinite(override) && override > 0 ? 'override' : 'member-product',
      retries,
    });
  }

  const checkpoints = [];
  for (const row of rows) {
    if (chained.has(String(row.boss))) continue;
    const probability = checkpointClearProbability(row);
    const retries = (1 - probability) / probability;
    total += retries;
    checkpoints.push({ boss: String(row.boss), probability, retries });
  }

  return { total, chains, checkpoints };
}

// Total wild battles in a grind plan. Accepts every plan shape:
// { checkpoint: battles }, { checkpoint: { memberKey: battles } } and
// { checkpoint: [{ battles, participants, expShareHolder }] }.
export function grindPlanTotalBattles(plan) {
  const count = value => Math.max(0, Math.floor(Number(value || 0)));
  let total = 0;
  for (const value of Object.values(plan || {})) {
    if (Array.isArray(value)) {
      total += value.reduce((sum, block) => sum + count(block?.battles), 0);
    } else if (value && typeof value === 'object') {
      total += grindPlanTotalBattles(value);
    } else {
      total += count(value);
    }
  }
  return total;
}

export function grindBattles(evaluation) {
  const scheduled = evaluation?.expSchedule?.totalExpectedGrindBattles;
  if (Number.isFinite(Number(scheduled))) return Number(scheduled);
  return grindPlanTotalBattles(evaluation?.expSchedule?.grindPlanBattles);
}

// Coefficient of variation of a party's levels (population sd / mean).
// Members not yet in the party count as level 0, so entering a checkpoint
// with fewer members reads as a concentrated party.
export function levelCoefficientOfVariation(levels, partySize = PARTY_SIZE) {
  const values = levels.map(level => Math.max(0, Number(level) || 0));
  while (values.length < partySize) values.push(0);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function levelSpread(evaluation, { checkpoints = LEVEL_SPREAD_CHECKPOINTS, partySize = PARTY_SIZE } = {}) {
  const battles = evaluation?.expSchedule?.battles || [];
  const byLabel = new Map(battles.map(battle => [String(battle.label), battle]));
  const perCheckpoint = [];
  for (const label of checkpoints) {
    const battle = byLabel.get(label);
    if (!battle?.levelsBefore) continue;
    const levels = Object.values(battle.levelsBefore);
    perCheckpoint.push({
      checkpoint: label,
      members: levels.length,
      levels: battle.levelsBefore,
      cv: levelCoefficientOfVariation(levels, partySize),
    });
  }
  const values = perCheckpoint.map(row => row.cv).filter(cv => cv !== null);
  return {
    max: values.length ? Math.max(...values) : null,
    perCheckpoint,
  };
}

// Bag items are not modeled yet (CHARTER.md v1, item 3); until they are this
// axis is reported as unknown rather than zero.
// Shop-price sum of bag items used per run through the route: in-battle use
// (p1BagItemCostPerBattle on each checkpoint row) plus between-battle healing
// (evaluation.betweenBattleItemCost, Elite Four chains). Unknown when the
// evaluation did not model bag items.
export function bagItemsUsed(evaluation) {
  const rows = activeRows(evaluation);
  const modeled = rows.some(row => Number.isFinite(Number(row?.p1BagItemCostPerBattle)) && row?.bagItemsModeled);
  if (!modeled) return null;
  const inBattle = rows.reduce((sum, row) => sum + Number(row.p1BagItemCostPerBattle || 0), 0);
  return inBattle + Number(evaluation?.betweenBattleItemCost || 0);
}

export function comparisonAxes(evaluation, options = {}) {
  const retries = expectedRetries(evaluation, options);
  const spread = levelSpread(evaluation, options);
  // A plan that breaks a hard route rule (e.g. no one can learn a required
  // field HM) cannot be played and is never compared.
  const feasible = evaluation?.fieldHm ? evaluation.fieldHm.feasible !== false : true;
  return {
    version: COMPARISON_AXES_VERSION,
    feasible,
    grindBattles: grindBattles(evaluation),
    expectedRetries: retries.total,
    levelCv: spread.max,
    bagItemsUsed: bagItemsUsed(evaluation),
    detail: { retries, levelSpread: spread },
  };
}

const SEARCH_AXES = ['grindBattles', 'expectedRetries', 'levelCv'];
const FINAL_AXES = [...SEARCH_AXES, 'bagItemsUsed'];

// a dominates b when it is no worse on every axis and better on one.
// Unknown values (null) are never compared, so they cannot dominate.
export function axesDominate(a, b, axes = SEARCH_AXES) {
  let better = false;
  for (const axis of axes) {
    const x = a?.[axis];
    const y = b?.[axis];
    if (x === null || y === null || x === undefined || y === undefined) return false;
    if (x > y) return false;
    if (x < y) better = true;
  }
  return better;
}

// Keeps every entry that no other entry dominates.
export function nondominated(entries, { axes = SEARCH_AXES, axesOf = entry => entry.axes } = {}) {
  const playable = entries.filter(entry => axesOf(entry)?.feasible !== false);
  return playable.filter(entry =>
    !playable.some(other => other !== entry && axesDominate(axesOf(other), axesOf(entry), axes))
  );
}

// Team comparison rule: a team stays if any of its plans is nondominated
// among all plans of all teams.
export function teamsWithNondominatedPlan(plans, { axes = SEARCH_AXES, teamOf = plan => plan.teamKey, axesOf = plan => plan.axes } = {}) {
  const front = nondominated(plans, { axes, axesOf });
  return [...new Set(front.map(teamOf))];
}

export { SEARCH_AXES, FINAL_AXES };
