import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { addDashboardAccessControls } from './dashboard-access.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dashboard', import.meta.url));
const ROOT_PREFIX = ROOT + path.sep;
const TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

export async function serveDashboardFile(req, res, rawPath, passwordAccess = false) {
  if (!['GET', 'HEAD'].includes(req.method) || !rawPath.startsWith('/')) return false;

  let relative;
  try {
    // Проверяем исходный путь до нормализации сегментов классом URL.
    relative = decodeURIComponent(rawPath.slice(1));
  } catch {
    return false;
  }
  if (relative.includes('\0') || relative.includes('\\') || relative.includes('..') ||
      path.isAbsolute(relative) || path.win32.isAbsolute(relative)) return false;

  if (relative === 'favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }

  const isIndex = relative === '' || relative === 'index.html';
  const type = isIndex ? 'text/html; charset=utf-8' : TYPES.get(path.extname(relative));
  if (!type) return false;
  const file = path.resolve(ROOT, isIndex ? 'index.html' : relative);
  if (!file.startsWith(ROOT_PREFIX)) return false;

  let size;
  let body;
  try {
    const target = await realpath(file);
    if (!target.startsWith(ROOT_PREFIX)) return false;
    const info = await stat(target);
    if (!info.isFile()) return false;
    size = info.size;
    if (isIndex && passwordAccess) {
      const html = addDashboardAccessControls(await readFile(target, 'utf8'));
      size = Buffer.byteLength(html);
      if (req.method === 'GET') body = Buffer.from(html);
    } else if (req.method === 'GET') {
      body = await readFile(target);
    }
  } catch {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body?.length ?? size,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
  return true;
}

const MAX_GAMES = 20;
const MAX_MOVES = 3000;
const MAX_RECENT_MOVES = 10;
const MODES = new Set(['check', 'practice', 'round']);
const COLORS = ['red', 'blue'];

function readScore(score) {
  return Object.fromEntries(COLORS.map((color) => [color,
    Number.isSafeInteger(score?.[color]) && score[color] >= 0 ? score[color] : null,
  ]));
}

function readDead(dead, { width, height }) {
  return Object.fromEntries(COLORS.map((color) => [color,
    Array.isArray(dead?.[color]) ? dead[color].filter((point) =>
      Array.isArray(point) && point.length === 2 && point.every(Number.isSafeInteger) &&
      point[0] >= 0 && point[0] < width && point[1] >= 0 && point[1] < height) : [],
  ]));
}

function describeGame(game) {
  return {
    id: game.id, mode: game.mode, you: game.snapshot.you,
    moveCount: game.moves.size, revision: game.sequence, lastMoveAt: game.lastMoveAt,
    score: game.snapshot.score,
  };
}

export function createDashboard() {
  const startedAt = performance.now();
  const games = new Map();
  const recent = [];
  let moves = 0;
  let totalMs = 0;
  let maxMs = 0;
  let fallbacks = 0;
  let errors = 0;
  let recordingErrors = 0;
  let lastRequestAt = null;

  return {
    record({ request, mode, move, fallback, receivedAt, durationMs, status }) {
      lastRequestAt = Math.max(lastRequestAt ?? receivedAt, receivedAt);
      if (status === 200) {
        moves += 1;
        totalMs += durationMs;
        maxMs = Math.max(maxMs, durationMs);
        fallbacks += Number(fallback);
      } else {
        errors += 1;
      }
      if (!request) return;

      const { gameId, moveNo, you, last, points } = request;
      const { width, height } = request.field;
      const field = { width, height };
      const score = readScore(request.score);
      const arenaMode = MODES.has(mode) ? mode : 'unknown';
      const record = { moveNo, mode: arenaMode, you, field, last: last ?? null, move, durationMs, fallback, score, receivedAt, status };
      const game = games.get(gameId) ?? { id: gameId, moves: new Map(), sequence: 0, mode: 'unknown' };
      if (!game.snapshot || moveNo > game.snapshot.moveNo ||
          (moveNo === game.snapshot.moveNo && receivedAt >= game.snapshot.receivedAt)) {
        game.snapshot = { ...record, points: { red: points.red, blue: points.blue }, dead: readDead(request.dead, field) };
      }
      if (arenaMode !== 'unknown') game.mode = arenaMode;
      game.lastMoveAt = Math.max(game.lastMoveAt ?? receivedAt, receivedAt);
      game.sequence += 1;
      game.moves.set(game.sequence, record);
      if (game.moves.size > MAX_MOVES) game.moves.delete(game.moves.keys().next().value);
      games.delete(gameId);
      games.set(gameId, game);
      if (games.size > MAX_GAMES) games.delete(games.keys().next().value);

      if (status === 200) {
        const previous = recent.findIndex((entry) => entry.gameId === gameId && entry.moveNo === moveNo);
        if (previous !== -1) recent.splice(previous, 1);
        recent.unshift({ gameId: game.id, moveNo, you, last: record.last, move, fallback, receivedAt });
        if (recent.length > MAX_RECENT_MOVES) recent.pop();
      }
    },
    recordError() {
      recordingErrors += 1;
    },
    status(version) {
      return {
        version, uptimeSeconds: (performance.now() - startedAt) / 1000,
        moves, averageMoveMs: moves ? totalMs / moves : 0, maxMoveMs: maxMs,
        fallbackMoves: fallbacks, errors, recordingErrors, lastRequestAt,
      };
    },
    list() {
      return Array.from(games.values(), describeGame).reverse();
    },
    recent() {
      return recent.filter((entry) => games.has(entry.gameId));
    },
    get(id) {
      const game = games.get(id);
      if (!game) return null;
      return {
        ...describeGame(game),
        moves: Array.from(game.moves.values()),
        snapshot: game.snapshot,
      };
    },
  };
}
