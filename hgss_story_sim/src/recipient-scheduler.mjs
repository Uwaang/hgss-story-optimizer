export function recipientScheduleStateKey(schedule = {}) {
  const entries = Object.entries(schedule || {})
    .map(([member, checkpoint]) => [
      String(member).trim(),
      String(checkpoint || 'always-active').trim() || 'always-active',
    ])
    .filter(([member]) => member)
    .filter(([, checkpoint]) => checkpoint.toLowerCase() !== 'always-active')
    .sort(([a], [b]) => a.localeCompare(b));

  return JSON.stringify(Object.fromEntries(entries));
}

export function expandRecipientScheduleCoordinates({
  schedule = {},
  members = [],
  checkpoints = [],
} = {}) {
  const base = Object.fromEntries(
    Object.entries(schedule || {}).map(([member, checkpoint]) => [
      String(member).trim(),
      String(checkpoint || 'always-active').trim() || 'always-active',
    ])
  );
  const uniqueMembers = [...new Set(members.map(value => String(value).trim()).filter(Boolean))];
  const uniqueCheckpoints = [
    ...new Set(
      ['always-active', ...checkpoints]
        .map(value => String(value).trim())
        .filter(Boolean)
    ),
  ];

  const rows = [];
  const seen = new Set();

  for (const member of uniqueMembers) {
    const current = base[member] || 'always-active';
    for (const checkpoint of uniqueCheckpoints) {
      if (checkpoint === current) continue;

      const next = { ...base };
      if (checkpoint.toLowerCase() === 'always-active') {
        delete next[member];
      } else {
        next[member] = checkpoint;
      }
      const stateKey = recipientScheduleStateKey(next);
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);
      rows.push({
        member,
        from: current,
        to: checkpoint,
        schedule: JSON.parse(stateKey),
        stateKey,
      });
    }
  }

  return rows;
}

function objectiveValue(row, objective) {
  const value = typeof objective.value === 'function'
    ? objective.value(row)
    : row?.[objective.key];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function dominatesScheduleRow(a, b, objectives = []) {
  if (!objectives.length) {
    throw new Error('dominatesScheduleRow requires at least one objective');
  }

  let strict = false;
  for (const objective of objectives) {
    const direction = String(objective.direction || 'min').toLowerCase();
    if (!['min', 'max'].includes(direction)) {
      throw new Error('Unknown Pareto objective direction: ' + objective.direction);
    }

    const av = objectiveValue(a, objective);
    const bv = objectiveValue(b, objective);
    if (av === null || bv === null) return false;

    if (direction === 'min') {
      if (av > bv) return false;
      if (av < bv) strict = true;
    } else {
      if (av < bv) return false;
      if (av > bv) strict = true;
    }
  }
  return strict;
}

export function nondominatedScheduleRows(
  rows = [],
  objectives = [],
  {
    feasible = row => row?.feasible !== false,
  } = {},
) {
  const eligible = rows.filter(row => feasible(row));
  return eligible.filter((row, index) =>
    !eligible.some((other, otherIndex) =>
      index !== otherIndex && dominatesScheduleRow(other, row, objectives)
    )
  );
}
