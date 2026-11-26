const COLORS = ['red', 'blue'];
export const DASHBOARD_SCHEMA_VERSION = 1;
export const REPLAY_BYTES_PER_GAME = 128 * 1024;
const MAX_DELTA_BYTES = 4096;
const DELTA_METADATA_BYTES = 160;
const NO_EVENTS = Object.freeze([]);

const opposite = (color) => color === 'red' ? 'blue' : 'red';
const knownScore = (score) => Number.isFinite(score?.red) && Number.isFinite(score?.blue);
const positionIndex = (point, width) => point[1] * width + point[0];

function difference(current, previous, width) {
  const seen = new Set(previous.map(point => positionIndex(point, width)));
  return current.map(point => positionIndex(point, width)).filter(index => !seen.has(index));
}

function pack(indices) {
  const bytes = Buffer.allocUnsafe(indices.length * 4);
  indices.forEach((index, offset) => bytes.writeUInt32LE(index, offset * 4));
  return bytes.toString('base64');
}

export function replayDelta(previous, snapshot, budget) {
  if (!previous || budget < DELTA_METADATA_BYTES || snapshot.field.width * snapshot.field.height > 10_000) return null;
  const width = snapshot.field.width;
  const changes = COLORS.map(color => ({
    placed: difference(snapshot.points[color], previous.points[color], width),
    removed: difference(previous.points[color], snapshot.points[color], width),
    addedDead: difference(snapshot.dead[color], previous.dead[color], width),
    removedDead: difference(previous.dead[color], snapshot.dead[color], width),
  }));
  const length = changes.flatMap(Object.values).reduce((total, ids) => total + Math.ceil(ids.length * 4 / 3) * 4, 0);
  if (length > MAX_DELTA_BYTES || length + DELTA_METADATA_BYTES > budget) return null;
  return { fromMoveNo: previous.moveNo, ...Object.fromEntries(changes.map((change, index) =>
    [COLORS[index], Object.fromEntries(Object.entries(change).map(([name, ids]) => [name, pack(ids)]))])) };
}

export function replayBytes(record) {
  const bytes = record.captured?.length ?? 0;
  if (!record.deadDelta) return bytes;
  return bytes + DELTA_METADATA_BYTES + COLORS.reduce((total, color) =>
    total + Object.values(record.deadDelta[color]).reduce((sum, value) => sum + value.length, 0), 0);
}

export function moveAnalysis(request, snapshot, after, budget) {
  const timer = name => Number.isFinite(request[name]) && request[name] >= 0 ? request[name] : null;
  const scoreAfter = after?.score ?? null;
  const scoreDelta = scoreAfter && knownScore(snapshot.score) ? Object.fromEntries(COLORS.map(color =>
    [color, scoreAfter[color] - snapshot.score[color]])) : null;
  const enemy = opposite(snapshot.you);
  const events = [];
  if (scoreDelta?.[snapshot.you] > 0) events.push('capture');
  if (scoreDelta && (scoreDelta[snapshot.you] < 0 || scoreDelta[enemy] > 0)) events.push('loss');
  if (snapshot.fallback && snapshot.status === 200) events.push('fallback');
  const captured = events.includes('capture') && budget >= 8
    ? difference(after.dead[enemy], snapshot.dead[enemy], snapshot.field.width) : [];
  return {
    timeLeftMs: timer('timeLeftMs'), moveTimeoutMs: timer('moveTimeoutMs'),
    scoreAfter, scoreDelta, events: events.length ? events : NO_EVENTS,
    ...(captured.length && Math.ceil(captured.length * 4 / 3) * 4 <= Math.min(budget, MAX_DELTA_BYTES)
      ? { captured: pack(captured) } : {}),
  };
}

export function describeAnalysis(game, after, botVersion) {
  const { snapshot, session } = game;
  const startedAt = game.historyStartedAt ?? session.startedAt;
  const endedAt = session.endedAt ?? null;
  const enemy = opposite(snapshot.you);
  const placed = snapshot.points.red.length + snapshot.points.blue.length + Number(snapshot.status === 200 && Boolean(snapshot.move));
  const full = placed === snapshot.field.width * snapshot.field.height;
  const finalScore = endedAt === null ? null : after?.score ?? (snapshot.status === 200 ? null : snapshot.score);
  let outcome = endedAt === null ? 'unfinished' : 'unknown';
  if (knownScore(finalScore)) {
    outcome = finalScore[snapshot.you] === finalScore[enemy] ? 'draw' :
      finalScore[snapshot.you] > finalScore[enemy] ? 'win' : 'loss';
  }
  const turns = new Map();
  let errorCount = 0;
  for (const record of game.moves.values()) {
    if (record.status === 200) {
      if (!turns.has(record.moveNo)) turns.set(record.moveNo, record);
    } else errorCount++;
  }
  const turnNumbers = Array.from(turns.keys()).sort((a, b) => a - b);
  const gaps = [];
  const first = snapshot.you === 'red' ? 1 : 2;
  let expected = first;
  for (const number of turnNumbers) {
    if (number > expected) gaps.push({ from: expected, to: number - 2 });
    expected = number + 2;
  }
  const times = Array.from(turns.values(), move => move.durationMs).sort((a, b) => a - b);
  const midpoint = Math.floor(times.length / 2);
  const length = times.length;
  const lastObserved = Math.max(startedAt, game.lastMoveAt);
  return {
    botVersion, endedAt, durationMs: Math.max(0, (endedAt ?? lastObserved) - startedAt),
    outcome, endReason: endedAt === null ? null : full ? 'board_full' :
      snapshot.timeLeftMs === 0 ? 'inactivity' : 'unknown',
    finalScore, scoreAfter: after?.score ?? snapshot.score,
    botMoveCount: snapshot.points[snapshot.you].length + Number(snapshot.status === 200 && Boolean(snapshot.move)),
    opponentMoveCount: snapshot.points[enemy].length, observedBotMoveCount: turns.size,
    latency: {
      averageMs: length ? times.reduce((total, value) => total + value, 0) / length : null,
      medianMs: length ? (times[midpoint] + times[Math.floor((length - 1) / 2)]) / 2 : null,
      p95Ms: length ? times[Math.ceil(length * 0.95) - 1] : null,
      maxMs: times.at(-1) ?? null,
    },
    fallbackCount: Array.from(turns.values()).filter(record => record.fallback).length,
    errorCount, gaps: gaps.filter(gap => gap.from <= gap.to),
  };
}
