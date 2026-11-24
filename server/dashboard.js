import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { addDashboardAccessControls } from './dashboard-access.js';
import { fileURLToPath } from 'node:url';
import { applyMove } from '../bot/index.js';

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

const MAX_GAMES = 40;
const RETENTION_MS = 24 * 60 * 60 * 1000;
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

function opponentHostname(...candidates) {
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) continue;
    const address = value.trim();
    try {
      const url = new URL(address.includes('://') ? address : `https://${address}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      const authority = address.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
      if (!authority.includes('.') && !authority.startsWith('[') && !/^localhost(?::\d+)?$/i.test(authority)) continue;
      const hostname = url.hostname.replace(/\.$/, '');
      if (hostname === 'localhost' || hostname.startsWith('[') ||
          (hostname.includes('.') && hostname.split('.').every(label =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return hostname;
    } catch {
      // Необязательное поле. Неверный адрес не меняет название партии.
    }
  }
  return undefined;
}

function positionAfterResponse(snapshot) {
  if (snapshot.status !== 200 || !snapshot.move) return null;
  const { width, height } = snapshot.field;
  if (width * height > 1_000_000) return null;
  const board = new Uint8Array(width * height);
  const index = ([x, y]) => y * width + x;
  for (const [color, code] of [['red', 1], ['blue', 2]]) {
    const dead = new Set(snapshot.dead[color].map(index));
    for (const point of snapshot.points[color]) {
      const at = index(point);
      board[at] = code + (dead.has(at) ? 2 : 0);
    }
  }
  const { x, y } = snapshot.move;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || x >= width || y < 0 || y >= height) return null;
  const color = snapshot.you === 'red' ? 1 : 2;
  const result = applyMove(board, index([x, y]), width, height, color, 3 - color, undefined, 1);
  if (!result) return null;
  const points = { ...snapshot.points, [snapshot.you]: [...snapshot.points[snapshot.you], [x, y]] };
  const dead = {
    red: points.red.filter(point => result.board[index(point)] === 3),
    blue: points.blue.filter(point => result.board[index(point)] === 4),
  };
  return { ...snapshot, points, dead, score: { red: dead.blue.length, blue: dead.red.length }, afterResponse: true };
}

function compareActivity(a, b) {
  return a.session.lastActivityAt - b.session.lastActivityAt || a.session.activityOrder - b.session.activityOrder;
}

function describeGame(game) {
  const { id, gameId, field, startedAt, lastActivityAt } = game.session;
  return {
    id, gameId, title: game.opponentDomain ? `${game.opponentDomain} · ${id}` : id,
    opponentDomain: game.opponentDomain ?? null, field, startedAt, lastActivityAt, active: game.session.endedAt === undefined,
    mode: game.mode, you: game.snapshot.you,
    moveCount: game.moves.size, revision: game.sequence, lastMoveAt: game.lastMoveAt,
    score: game.snapshot.score,
  };
}

export function createDashboard({ historyFile } = {}) {
  const startedAt = performance.now();
  const games = new Map();
  let recent = [];
  const deleted = new Map();
  const responses = new WeakMap();
  let moves = 0;
  let totalMs = 0;
  let maxMs = 0;
  let fallbacks = 0;
  let errors = 0;
  let recordingErrors = 0;
  let lastRequestAt = null;

  let dirty = false;
  let saveTimer;

  function prune() {
    const oldest = Date.now() - RETENTION_MS;
    for (const [id, game] of games) {
      if (game.lastMoveAt <= oldest) {
        games.delete(id);
        dirty = true;
      }
    }
    for (const [id, entry] of deleted) {
      if (entry.deletedAt <= oldest) {
        deleted.delete(id);
        dirty = true;
      }
    }
    recent = recent.filter(entry => games.has(entry.sessionId));
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    prune();
    if (!historyFile || !dirty) return;
    const temporary = historyFile + '.tmp';
    mkdirSync(path.dirname(historyFile), { recursive: true });
    try {
      writeFileSync(temporary, JSON.stringify({
        games: Array.from(games.values(), game => ({ ...game, moves: [...game.moves] })),
        recent, deleted: [...deleted],
      }), { mode: 0o600 });
      renameSync(temporary, historyFile);
      dirty = false;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  function scheduleSave() {
    if (!historyFile || !dirty || saveTimer) return;
    saveTimer = setTimeout(() => {
      try { flush(); } catch (error) {
        recordingErrors++;
        console.error('Не удалось сохранить историю панели:', error.message);
      }
    }, 500);
    saveTimer.unref();
  }

  if (historyFile) {
    try {
      const saved = JSON.parse(readFileSync(historyFile, 'utf8'));
      const records = saved.games.slice(0, MAX_GAMES).map(game => ({
        ...game, moves: new Map(game.moves.slice(-MAX_MOVES)),
      }));
      const removals = new Map(saved.deleted ?? []);
      recent = (saved.recent ?? []).slice(0, MAX_RECENT_MOVES);
      for (const game of records) games.set(game.session.id, game);
      for (const [id, entry] of removals) deleted.set(id, entry);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        recordingErrors++;
        console.error('Не удалось загрузить историю панели:', error.message);
      }
    }
    prune();
    scheduleSave();
    setInterval(() => { prune(); scheduleSave(); }, 60_000).unref();
  }

  function clean() {
    prune();
    scheduleSave();
  }

  return {
    record({ request, session, mode, opponent, move, fallback, receivedAt, durationMs, status }) {
      lastRequestAt = Math.max(lastRequestAt ?? receivedAt, receivedAt);
      if (status === 200) {
        moves += 1;
        totalMs += durationMs;
        maxMs = Math.max(maxMs, durationMs);
        fallbacks += Number(fallback);
      } else {
        errors += 1;
      }
      if (!request || !session) return;
      clean();
      if (deleted.has(session.id) || session.historyDeleted) return;

      const { gameId, moveNo, you, last, points } = request;
      const { width, height } = request.field;
      const field = { width, height };
      const score = readScore(request.score);
      const arenaMode = MODES.has(mode) ? mode : 'unknown';
      const record = { moveNo, mode: arenaMode, you, field, last: last ?? null, move, durationMs, fallback, score, receivedAt, status };
      const game = games.get(session.id) ?? { session, moves: new Map(), sequence: 0, mode: 'unknown' };
      if (!game.snapshot || moveNo > game.snapshot.moveNo ||
          (moveNo === game.snapshot.moveNo && receivedAt >= game.snapshot.receivedAt)) {
        game.snapshot = { ...record, points: { red: points.red, blue: points.blue }, dead: readDead(request.dead, field) };
      }
      if (!game.opponentDomain) {
        game.opponentDomain = opponentHostname(
          request.opponentDomain, request.opponentUrl, request.opponentHost, request.opponent?.domain, request.opponent?.host,
          request.opponent?.url, request.opponent?.address, request.opponent, opponent,
        );
      }
      if (arenaMode !== 'unknown') game.mode = arenaMode;
      game.lastMoveAt = Math.max(game.lastMoveAt ?? receivedAt, receivedAt);
      game.sequence += 1;
      game.moves.set(game.sequence, record);
      if (game.moves.size > MAX_MOVES) game.moves.delete(game.moves.keys().next().value);
      games.set(session.id, game);
      if (games.size > MAX_GAMES) {
        const oldest = Array.from(games.values()).reduce((a, b) => compareActivity(a, b) <= 0 ? a : b);
        games.delete(oldest.session.id);
      }

      dirty = true;
      scheduleSave();
      if (status === 200) {
        const previous = recent.findIndex((entry) => entry.sessionId === session.id && entry.moveNo === moveNo);
        if (previous !== -1) recent.splice(previous, 1);
        recent.unshift({ gameId, sessionId: session.id, moveNo, you, last: record.last, move, fallback, receivedAt });
        if (recent.length > MAX_RECENT_MOVES) recent.pop();
      }
    },
    flush,
    sessionChanged() {
      dirty = true;
      scheduleSave();
    },
    restore() {
      clean();
      return [
        ...games.values(),
        ...deleted.values(),
      ].sort(compareActivity);
    },
    remove(id, metadata) {
      clean();
      const game = games.get(id);
      if (!game) return false;
      const oldRecent = recent;
      const removed = { ...metadata, session: { ...game.session, historyDeleted: true }, deletedAt: Date.now() };
      deleted.set(id, removed);
      games.delete(id);
      recent = recent.filter(entry => entry.sessionId !== id);
      dirty = true;
      try {
        flush();
      } catch (error) {
        deleted.delete(id);
        games.set(id, game);
        recent = oldRecent;
        scheduleSave();
        throw error;
      }
      game.session.historyDeleted = true;
      return true;
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
      clean();
      return Array.from(games.values()).sort((a, b) => compareActivity(b, a)).map(describeGame);
    },
    hasSession(id) {
      return games.has(id) || deleted.has(id);
    },
    recent() {
      clean();
      return recent.filter((entry) => games.has(entry.sessionId));
    },
    get(id) {
      clean();
      const game = games.get(id);
      if (!game) return null;
      if (!responses.has(game.snapshot)) responses.set(game.snapshot, positionAfterResponse(game.snapshot));
      return {
        ...describeGame(game),
        moves: Array.from(game.moves.values()),
        snapshot: game.snapshot,
        afterResponse: responses.get(game.snapshot),
      };
    },
  };
}
