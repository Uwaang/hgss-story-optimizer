import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function args() {
  const out = {};
  for (const raw of process.argv.slice(3)) {
    if (!raw.startsWith('--')) continue;
    const i = raw.indexOf('=');
    if (i < 0) out[raw.slice(2)] = 'true';
    else out[raw.slice(2, i)] = raw.slice(i + 1);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function candidateKey(candidate) {
  return String(candidate.searchKey || candidate.familyId || candidate.species);
}

function candidateFamily(candidate) {
  return String(candidate.familyId || candidate.species);
}

function completionKey(teamKeys) {
  return [...teamKeys].map(String).sort().join('|');
}

function validTeam(team) {
  if (team.length > 6) return false;
  const exclusive = new Set();
  const families = new Set();
  for (const mon of team) {
    if (mon.exclusiveGroup) {
      if (exclusive.has(mon.exclusiveGroup)) return false;
      exclusive.add(mon.exclusiveGroup);
    }
    if (mon.familyId) {
      if (families.has(mon.familyId)) return false;
      families.add(mon.familyId);
    }
  }
  return true;
}

function hashHex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hashOrder(values, salt) {
  return [...values].sort((a, b) => {
    const ah = hashHex(salt + '|' + candidateKey(a));
    const bh = hashHex(salt + '|' + candidateKey(b));
    return ah.localeCompare(bh) || candidateKey(a).localeCompare(candidateKey(b));
  });
}

function poolInfo(pool) {
  const candidates = pool.candidates || [];
  const starter = candidates.find(c =>
    String(c.species) === 'Cyndaquil' && String(c.exclusiveGroup || '') === 'starter'
  );
  if (!starter) throw new Error('Cyndaquil starter not found in canonical pool');
  const eligible = candidates.filter(c =>
    candidateKey(c) !== candidateKey(starter) && String(c.exclusiveGroup || '') !== 'starter'
  );
  const byKey = new Map(candidates.map(c => [candidateKey(c), c]));
  return { candidates, starter, eligible, byKey };
}

function makeStart(pool, startId) {
  const { starter, eligible } = poolInfo(pool);
  const team = [starter];
  for (const candidate of hashOrder(eligible, 'coordinate-start-' + startId)) {
    if (!validTeam([...team, candidate])) continue;
    team.push(candidate);
    if (team.length === 6) break;
  }
  if (team.length !== 6) throw new Error('could not build legal start ' + startId);
  return team.map(candidateKey);
}

function buildCheckpoint(pool, fingerprint, teams, stage, meta = {}) {
  const { candidates } = poolInfo(pool);
  const unique = new Map();
  for (const teamKeys of teams) unique.set(completionKey(teamKeys), teamKeys);
  return {
    schemaVersion: Number(fingerprint.schemaVersion || 2),
    type: 'route-search-checkpoint',
    stage,
    fingerprint: fingerprint.fingerprint,
    config: fingerprint.config,
    candidateCap: candidates.length,
    scannedCandidates: candidates.length,
    screenedCandidates: candidates.length,
    screenedCandidateFamilies: new Set(candidates.map(candidateFamily)).size,
    screenedKeys: candidates.map(candidateKey),
    selectedCandidateDetails: [],
    beam: [...unique.values()].map(teamKeys => ({ teamKeys, evaluation: null })),
    timings: [{ stage, ...meta }],
  };
}

function makeRound(pool, fingerprint, incumbents, round, proposalsPerStart) {
  const { eligible, byKey } = poolInfo(pool);
  const manifestRows = [];
  const allTeams = [];

  for (const incumbent of incumbents) {
    const startId = Number(incumbent.startId);
    const baseKeys = incumbent.teamKeys.map(String);
    const baseTeam = baseKeys.map(key => {
      const c = byKey.get(key);
      if (!c) throw new Error('incumbent candidate missing from pool: ' + key);
      return c;
    });
    if (baseTeam.length !== 6 || !validTeam(baseTeam)) {
      throw new Error('illegal incumbent for start ' + startId);
    }

    const seen = new Set();
    const add = (teamKeys, kind, extra = {}) => {
      const key = completionKey(teamKeys);
      if (seen.has(key)) return false;
      seen.add(key);
      allTeams.push(teamKeys);
      manifestRows.push({ startId, round, kind, teamKey: key, teamKeys, ...extra });
      return true;
    };

    add(baseKeys, 'incumbent');

    let made = 0;
    let attempt = 0;
    const attemptCap = Math.max(200, proposalsPerStart * 40);
    while (made < proposalsPerStart && attempt < attemptCap) {
      const slot = 1 + ((attempt + round + startId) % 5);
      const current = baseTeam[slot];
      const ordered = hashOrder(
        eligible,
        'coordinate-round-' + round + '-start-' + startId + '-attempt-' + attempt
      );
      let accepted = null;
      for (const replacement of ordered) {
        if (candidateKey(replacement) === candidateKey(current)) continue;
        const next = [...baseTeam];
        next[slot] = replacement;
        if (!validTeam(next)) continue;
        const keys = next.map(candidateKey);
        if (seen.has(completionKey(keys))) continue;
        accepted = keys;
        break;
      }
      if (accepted && add(accepted, 'proposal', {
        slot,
        removedKey: candidateKey(current),
        addedKey: accepted[slot],
      })) {
        made += 1;
      }
      attempt += 1;
    }
    if (made !== proposalsPerStart) {
      throw new Error(
        'start ' + startId + ' produced only ' + made + '/' + proposalsPerStart + ' proposals'
      );
    }
  }

  const checkpoint = buildCheckpoint(
    pool,
    fingerprint,
    allTeams,
    'coordinate-round-' + round,
    {
      round,
      starts: incumbents.length,
      proposalsPerStart,
      manifestRows: manifestRows.length,
      uniqueTeams: new Set(allTeams.map(completionKey)).size,
    }
  );
  return {
    checkpoint,
    manifest: {
      schemaVersion: 1,
      round,
      proposalsPerStart,
      starts: incumbents.length,
      rows: manifestRows,
    },
  };
}

function walkJson(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(p));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function routeMetrics(evaluation) {
  const rows = (evaluation?.rows || []).filter(row => !row?.skipped);
  const probs = rows.map(row => {
    const wins = Number(row?.wins);
    const losses = Number(row?.losses);
    if (Number.isFinite(wins) && Number.isFinite(losses) && wins + losses > 0) {
      return (wins + 1) / (wins + losses + 2);
    }
    return Math.max(1e-6, Math.min(1 - 1e-6, Number(row?.winRate || 0)));
  });
  const retry = probs.reduce((sum, p) => sum + (1 - p) / p, 0);
  const geometric = probs.length
    ? Math.exp(probs.reduce((sum, p) => sum + Math.log(p), 0) / probs.length)
    : 0;
  const totals = rows.reduce((acc, row) => {
    acc.wins += Math.max(0, Number(row?.wins || 0));
    acc.runs += Math.max(0, Number(row?.runs || 0));
    return acc;
  }, { wins: 0, runs: 0 });
  const mean = totals.runs > 0
    ? totals.wins / totals.runs
    : (rows.length
        ? rows.reduce((sum, row) => sum + Number(row?.winRate || 0), 0) / rows.length
        : 0);
  const grindEnabled = Boolean(evaluation?.routeGrindProxy?.enabled);
  const grindBattles = grindEnabled && Number.isFinite(Number(evaluation?.routeGrindProxy?.expectedBattles))
    ? Number(evaluation.routeGrindProxy.expectedBattles)
    : Number.POSITIVE_INFINITY;
  const grindUnknown = grindEnabled
    ? Number(evaluation?.routeGrindProxy?.unknownCheckpoints || 0)
    : Number.POSITIVE_INFINITY;
  return { retry, geometric, mean, grindBattles, grindUnknown };
}

function compareRows(a, b) {
  if (a.metrics.retry !== b.metrics.retry) return a.metrics.retry - b.metrics.retry;
  if (a.metrics.geometric !== b.metrics.geometric) return b.metrics.geometric - a.metrics.geometric;
  if (a.metrics.mean !== b.metrics.mean) return b.metrics.mean - a.metrics.mean;
  if (a.metrics.grindUnknown !== b.metrics.grindUnknown) {
    return a.metrics.grindUnknown - b.metrics.grindUnknown;
  }
  if (a.metrics.grindBattles !== b.metrics.grindBattles) {
    return a.metrics.grindBattles - b.metrics.grindBattles;
  }
  return a.teamKey.localeCompare(b.teamKey);
}

function loadRescored(dir) {
  const map = new Map();
  for (const file of walkJson(dir)) {
    let doc;
    try { doc = readJson(file); } catch { continue; }
    for (const row of doc?.rescored || []) {
      map.set(completionKey(row.teamKeys || []), row);
    }
  }
  return map;
}

function cmdPrepare(opts) {
  const pool = readJson(opts.pool);
  const fingerprint = readJson(opts.fingerprint);
  const startCount = Number(opts.starts || 16);
  const proposals = Number(opts.proposals || 16);
  const out = opts.out || 'results/coordinate/round1';
  const incumbents = Array.from({ length: startCount }, (_, startId) => ({
    startId,
    teamKeys: makeStart(pool, startId),
  }));
  const built = makeRound(pool, fingerprint, incumbents, 1, proposals);
  writeJson(path.join(out, 'incumbents.json'), { schemaVersion: 1, round: 0, incumbents });
  writeJson(path.join(out, 'manifest.json'), built.manifest);
  writeJson(path.join(out, 'checkpoint.json'), built.checkpoint);
  console.log(JSON.stringify({
    startCount,
    proposalsPerStart: proposals,
    checkpointTeams: built.checkpoint.beam.length,
    starts: incumbents,
  }, null, 2));
}

function cmdSelect(opts) {
  const round = Number(opts.round);
  if (!Number.isInteger(round) || round < 1) throw new Error('select requires --round=N');
  const pool = readJson(opts.pool);
  const fingerprint = readJson(opts.fingerprint);
  const manifest = readJson(opts.manifest);
  const rescored = loadRescored(opts.rescored);
  const out = opts.out || ('results/coordinate/round' + (round + 1));
  const maxRounds = Number(opts['max-rounds'] || 5);
  const proposals = Number(opts.proposals || 16);

  const byStart = new Map();
  for (const row of manifest.rows || []) {
    const arr = byStart.get(Number(row.startId)) || [];
    arr.push(row);
    byStart.set(Number(row.startId), arr);
  }

  const selected = [];
  const summaries = [];
  for (const [startId, rows] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) {
    const scored = rows.map(meta => {
      const row = rescored.get(meta.teamKey);
      if (!row) throw new Error('missing rescore for ' + meta.teamKey);
      return {
        ...meta,
        evaluation: row.evaluation,
        metrics: routeMetrics(row.evaluation),
      };
    }).sort(compareRows);
    const winner = scored[0];
    const incumbent = scored.find(row => row.kind === 'incumbent');
    selected.push({ startId, teamKeys: winner.teamKeys });
    summaries.push({
      startId,
      changed: winner.teamKey !== incumbent?.teamKey,
      previousTeamKeys: incumbent?.teamKeys || null,
      selectedTeamKeys: winner.teamKeys,
      previousMetrics: incumbent?.metrics || null,
      selectedMetrics: winner.metrics,
      selectedKind: winner.kind,
      selectedChange: winner.kind === 'proposal'
        ? { slot: winner.slot, removedKey: winner.removedKey, addedKey: winner.addedKey }
        : null,
      candidateCount: scored.length,
    });
  }

  writeJson(path.join(out, 'selection.json'), {
    schemaVersion: 1,
    round,
    starts: selected.length,
    changedStarts: summaries.filter(x => x.changed).length,
    rows: summaries,
  });
  writeJson(path.join(out, 'incumbents.json'), {
    schemaVersion: 1,
    round,
    incumbents: selected,
  });

  if (round < maxRounds) {
    const built = makeRound(pool, fingerprint, selected, round + 1, proposals);
    writeJson(path.join(out, 'manifest.json'), built.manifest);
    writeJson(path.join(out, 'checkpoint.json'), built.checkpoint);
    console.log(JSON.stringify({
      round,
      changedStarts: summaries.filter(x => x.changed).length,
      nextRound: round + 1,
      checkpointTeams: built.checkpoint.beam.length,
      winners: summaries,
    }, null, 2));
  } else {
    const checkpoint = buildCheckpoint(
      pool,
      fingerprint,
      selected.map(x => x.teamKeys),
      'coordinate-endpoints',
      {
        rounds: maxRounds,
        starts: selected.length,
        uniqueEndpoints: new Set(selected.map(x => completionKey(x.teamKeys))).size,
      }
    );
    writeJson(path.join(out, 'checkpoint.json'), checkpoint);
    writeJson(path.join(out, 'manifest.json'), {
      schemaVersion: 1,
      round,
      type: 'coordinate-endpoints',
      rows: selected.map(x => ({
        startId: x.startId,
        teamKeys: x.teamKeys,
        teamKey: completionKey(x.teamKeys),
      })),
    });
    console.log(JSON.stringify({
      round,
      changedStarts: summaries.filter(x => x.changed).length,
      endpoints: selected.length,
      uniqueEndpoints: checkpoint.beam.length,
      winners: summaries,
    }, null, 2));
  }
}


function cmdContinue(opts) {
  const pool = readJson(opts.pool);
  const fingerprint = readJson(opts.fingerprint);
  const incumbentsDoc = readJson(opts.incumbents);
  const nextRound = Number(opts['next-round']);
  if (!Number.isInteger(nextRound) || nextRound < 2) {
    throw new Error('continue requires --next-round=N >= 2');
  }
  const proposals = Number(opts.proposals || 16);
  const out = opts.out || ('results/coordinate/round' + nextRound);
  const incumbents = incumbentsDoc.incumbents || [];
  if (!incumbents.length) throw new Error('continue incumbents are empty');
  const built = makeRound(pool, fingerprint, incumbents, nextRound, proposals);
  writeJson(path.join(out, 'incumbents.json'), {
    schemaVersion: 1,
    round: nextRound - 1,
    incumbents,
  });
  writeJson(path.join(out, 'manifest.json'), built.manifest);
  writeJson(path.join(out, 'checkpoint.json'), built.checkpoint);
  console.log(JSON.stringify({
    nextRound,
    starts: incumbents.length,
    proposalsPerStart: proposals,
    checkpointTeams: built.checkpoint.beam.length,
  }, null, 2));
}

const command = process.argv[2];
const opts = args();
if (command === 'prepare') cmdPrepare(opts);
else if (command === 'select') cmdSelect(opts);
else if (command === 'continue') cmdContinue(opts);
else throw new Error('Use prepare, continue, or select');
