function activeRows(evaluation) {
  return (evaluation?.rows || []).filter(row => !row?.skipped);
}

export function betaPosteriorMean(row) {
  const wins = Math.max(0, Number(row?.wins || 0));
  const losses = Math.max(0, Number(row?.losses || 0));
  const ties = Math.max(0, Number(row?.ties || 0));
  return (wins + 1) / (wins + losses + ties + 2);
}

export function completionEvaluationMetrics(evaluation) {
  const rows = activeRows(evaluation);
  const probabilities = rows.map(betaPosteriorMean);
  const retry = probabilities.reduce(
    (sum, probability) => sum + (1 - probability) / Math.max(1e-12, probability),
    0,
  );
  const geometric = probabilities.length
    ? Math.exp(
        probabilities.reduce(
          (sum, probability) => sum + Math.log(Math.max(1e-12, probability)),
          0,
        ) / probabilities.length,
      )
    : 0;
  const totals = rows.reduce(
    (acc, row) => {
      acc.runs += Math.max(0, Number(row?.runs || 0));
      acc.wins += Math.max(0, Number(row?.wins || 0));
      acc.progress += Number(row?.battleProgressScore ?? row?.winRate ?? 0);
      return acc;
    },
    { runs: 0, wins: 0, progress: 0 },
  );
  return {
    retry,
    geometric,
    mean: totals.runs ? totals.wins / totals.runs : 0,
    progress: rows.length ? totals.progress / rows.length : 0,
  };
}

export function completionTeamKey(teamKeys = []) {
  return [...teamKeys].map(String).sort().join('|');
}

export function compareCompletionMetrics(a, b) {
  return (
    Number(a?.retry ?? Number.POSITIVE_INFINITY) -
      Number(b?.retry ?? Number.POSITIVE_INFINITY) ||
    Number(b?.geometric ?? 0) - Number(a?.geometric ?? 0) ||
    Number(b?.mean ?? 0) - Number(a?.mean ?? 0) ||
    Number(b?.progress ?? 0) - Number(a?.progress ?? 0)
  );
}

function childContainsParent(childKeys, parentKeys) {
  const child = new Set(childKeys || []);
  return (parentKeys || []).every(key => child.has(key));
}

export function rankParentCompletions(parents = [], children = []) {
  const childMap = new Map();
  for (const child of children) {
    const key = completionTeamKey(child?.teamKeys || []);
    if (!key) continue;
    childMap.set(key, {
      ...child,
      key,
      metrics: completionEvaluationMetrics(child.evaluation),
    });
  }
  const uniqueChildren = [...childMap.values()];

  const rows = parents.map(parent => {
    const parentKey = completionTeamKey(parent?.teamKeys || []);
    const parentSet = new Set(parent?.teamKeys || []);
    const compatible = uniqueChildren
      .filter(child => childContainsParent(child.teamKeys, parent.teamKeys))
      .sort((a, b) =>
        compareCompletionMetrics(a.metrics, b.metrics) ||
        a.key.localeCompare(b.key)
      );
    const best = compatible[0] || null;
    const currentMetrics = parent.currentMetrics ||
      (parent.evaluation ? completionEvaluationMetrics(parent.evaluation) : null);
    return {
      ...parent,
      key: parentKey,
      currentMetrics,
      childCount: compatible.length,
      bestChild: best
        ? {
            key: best.key,
            teamKeys: best.teamKeys,
            addedKeys: best.teamKeys.filter(key => !parentSet.has(key)),
            addedKey: best.teamKeys.find(key => !parentSet.has(key)) || null,
            metrics: best.metrics,
          }
        : null,
    };
  });

  const currentOrder = [...rows].sort((a, b) => {
    if (!a.currentMetrics && !b.currentMetrics) return a.key.localeCompare(b.key);
    if (!a.currentMetrics) return 1;
    if (!b.currentMetrics) return -1;
    return compareCompletionMetrics(a.currentMetrics, b.currentMetrics) ||
      a.key.localeCompare(b.key);
  });
  currentOrder.forEach((row, index) => {
    row.currentRank = index + 1;
  });

  rows.sort((a, b) => {
    if (!a.bestChild && !b.bestChild) return a.key.localeCompare(b.key);
    if (!a.bestChild) return 1;
    if (!b.bestChild) return -1;
    return (
      compareCompletionMetrics(a.bestChild.metrics, b.bestChild.metrics) ||
      a.key.localeCompare(b.key)
    );
  });
  rows.forEach((row, index) => {
    row.completionRank = index + 1;
  });

  return {
    uniqueChildren: uniqueChildren.length,
    rows,
  };
}

export function completionRecallSummary(
  parents = [],
  children = [],
  {
    controlPredicate = row => String(row?.kind || '').startsWith('control'),
    topK = 6,
  } = {},
) {
  const ranked = rankParentCompletions(parents, children);
  const controls = ranked.rows.filter(controlPredicate);
  const bestControl = controls[0] || null;
  return {
    parentCount: ranked.rows.length,
    uniqueChildren: ranked.uniqueChildren,
    topK,
    bestControl,
    controlRanks: controls.map(row => ({
      rank: row.completionRank,
      key: row.key,
      teamKeys: row.teamKeys,
      currentMetrics: row.currentMetrics,
      bestChild: row.bestChild,
    })),
    controlRecoveredIntoTopK: controls.some(row => row.completionRank <= topK),
    rows: ranked.rows,
  };
}


function completionRankLayers(items) {
  const remaining = [...items];
  const layers = [];
  const dominates = (a, b) => {
    const atLeastAsGood =
      Number(a.currentRank) <= Number(b.currentRank) &&
      Number(a.completionRank) <= Number(b.completionRank);
    const strictlyBetter =
      Number(a.currentRank) < Number(b.currentRank) ||
      Number(a.completionRank) < Number(b.completionRank);
    return atLeastAsGood && strictlyBetter;
  };
  while (remaining.length) {
    const front = remaining.filter((item, index) =>
      !remaining.some((other, otherIndex) =>
        index !== otherIndex && dominates(other, item)
      )
    );
    if (!front.length) {
      layers.push([...remaining]);
      break;
    }
    layers.push(front);
    const set = new Set(front);
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (set.has(remaining[i])) remaining.splice(i, 1);
    }
  }
  return layers;
}

function completionRankCrowdingOrder(items) {
  const distance = new Map(items.map(item => [item, 0]));
  for (const field of ['currentRank', 'completionRank']) {
    const ordered = [...items].sort((a, b) =>
      Number(a[field]) - Number(b[field]) ||
      a.key.localeCompare(b.key)
    );
    if (ordered.length < 2) continue;
    const lo = Number(ordered[0][field]);
    const hi = Number(ordered[ordered.length - 1][field]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;
    distance.set(ordered[0], Number.POSITIVE_INFINITY);
    distance.set(ordered[ordered.length - 1], Number.POSITIVE_INFINITY);
    for (let i = 1; i < ordered.length - 1; i += 1) {
      if (!Number.isFinite(distance.get(ordered[i]))) continue;
      distance.set(
        ordered[i],
        Number(distance.get(ordered[i]) || 0) +
          (Number(ordered[i + 1][field]) - Number(ordered[i - 1][field])) / (hi - lo),
      );
    }
  }
  return [...items].sort((a, b) =>
    Number(distance.get(b) || 0) - Number(distance.get(a) || 0) ||
    Math.min(a.currentRank, a.completionRank) - Math.min(b.currentRank, b.completionRank) ||
    a.key.localeCompare(b.key)
  );
}

export function selectCompletionAwareParents(rows = [], width = 6) {
  const normalizedWidth = Math.max(1, Math.floor(Number(width || 1)));
  const normalized = rows.map(row => ({
    ...row,
    key: row.key || completionTeamKey(row.teamKeys || []),
    currentMetrics: row.currentMetrics || null,
    completionMetrics: row.completionMetrics || row.childMetrics || null,
  }));

  const currentOrder = [...normalized].sort((a, b) =>
    compareCompletionMetrics(a.currentMetrics, b.currentMetrics) ||
    a.key.localeCompare(b.key)
  );
  currentOrder.forEach((row, index) => {
    row.currentRank = index + 1;
  });

  const completionOrder = [...normalized].sort((a, b) =>
    compareCompletionMetrics(a.completionMetrics, b.completionMetrics) ||
    a.key.localeCompare(b.key)
  );
  completionOrder.forEach((row, index) => {
    row.completionRank = index + 1;
  });

  const layers = completionRankLayers(normalized);
  const selected = [];
  const selectedKeys = new Set();
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    for (const row of layer) row.selectionLayer = layerIndex + 1;
    const remaining = normalizedWidth - selected.length;
    if (remaining <= 0) break;
    const ordered = layer.length <= remaining
      ? [...layer].sort((a, b) =>
          Math.min(a.currentRank, a.completionRank) - Math.min(b.currentRank, b.completionRank) ||
          a.currentRank - b.currentRank ||
          a.completionRank - b.completionRank ||
          a.key.localeCompare(b.key)
        )
      : completionRankCrowdingOrder(layer);
    for (const row of ordered) {
      if (selected.length >= normalizedWidth) break;
      if (selectedKeys.has(row.key)) continue;
      selectedKeys.add(row.key);
      selected.push(row);
    }
  }

  if (selected.length < normalizedWidth) {
    const fallback = [...normalized].sort((a, b) =>
      Math.min(a.currentRank, a.completionRank) - Math.min(b.currentRank, b.completionRank) ||
      a.currentRank + a.completionRank - b.currentRank - b.completionRank ||
      a.key.localeCompare(b.key)
    );
    for (const row of fallback) {
      if (selected.length >= normalizedWidth) break;
      if (selectedKeys.has(row.key)) continue;
      selectedKeys.add(row.key);
      selected.push(row);
    }
  }

  const selectedSet = new Set(selected.map(row => row.key));
  const rankedRows = [...normalized]
    .map(row => ({ ...row, selected: selectedSet.has(row.key) }))
    .sort((a, b) =>
      Number(a.selectionLayer || Number.POSITIVE_INFINITY) -
        Number(b.selectionLayer || Number.POSITIVE_INFINITY) ||
      a.currentRank - b.currentRank ||
      a.completionRank - b.completionRank ||
      a.key.localeCompare(b.key)
    );

  return {
    width: normalizedWidth,
    parentCount: normalized.length,
    selectedCount: selected.length,
    selectedKeys: selected.map(row => row.key),
    selected,
    rows: rankedRows,
  };
}
