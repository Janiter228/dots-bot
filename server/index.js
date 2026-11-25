import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_VERSION } from '../bot/index.js';
import { infiniteFallback } from '../bot/field-profile.js';
import { responseLimit } from '../bot/time-budget.js';
import { computeMove } from './compute-move.js';
import { createDashboard, serveDashboardFile } from './dashboard.js';
import { DASHBOARD_SCHEMA_VERSION } from './dashboard-analysis.js';
import { createZip, gameFilename, ZipLimitError } from './dashboard-zip.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDashboardAccess } from './dashboard-access.js';
import { createGameLogs } from './game-logs.js';

const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_GAMES = 128;
const MAX_CACHED_MOVES = 3000;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function addCorsHeaders(req, res) {
  // Для браузерной песочницы арены. Cookie/credentials сервер не использует.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Arena-Run, X-Arena-Spec, X-Arena-Mode, X-Arena-Seq, X-Arena-Opponent-Domain, X-Arena-Opponent-Url, X-Arena-Opponent'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
}

async function readJson(req, limit = BODY_LIMIT_BYTES) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limit) {
      const error = new Error(`Размер запроса превышает ${limit === BODY_LIMIT_BYTES ? '8 МБ' : `${limit} байт`}`);
      error.statusCode = 413;
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body.trim()) {
    const error = new Error('Тело запроса пустое');
    error.statusCode = 400;
    error.code = 'empty_body';
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Тело запроса должно содержать корректный JSON');
    error.statusCode = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

function isInteger(value) {
  return Number.isSafeInteger(value);
}

function isCoordinate(value, { width, height, infinite }) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isInteger(value[0]) &&
    isInteger(value[1]) &&
    (infinite === true || (value[0] >= 0 && value[0] < width && value[1] >= 0 && value[1] < height))
  );
}

function validateMoveRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return 'Ожидался JSON-объект с состоянием игры';
  }

  if (typeof request.gameId !== 'string' || request.gameId.length === 0) {
    return 'Поле gameId должно быть непустой строкой';
  }
  if (!isInteger(request.moveNo) || request.moveNo < 1) {
    return 'Поле moveNo должно быть целым числом от 1';
  }
  if (request.you !== 'red' && request.you !== 'blue') {
    return 'Поле you должно быть red или blue';
  }

  const field = request.field;
  if (!field || (field.infinite !== true && (!isInteger(field.width) || !isInteger(field.height) ||
      field.width < 1 || field.height < 1))) {
    return 'field.width и field.height должны быть положительными целыми числами';
  }

  const points = request.points;
  if (!points || !Array.isArray(points.red) || !Array.isArray(points.blue)) {
    return 'points должен содержать массивы points.red и points.blue';
  }

  for (const color of ['red', 'blue']) {
    const dead = request.dead?.[color];
    if (field.infinite === true && dead != null &&
        (!Array.isArray(dead) || dead.some(point => !isCoordinate(point, field)))) {
      return `В dead.${color} найдена координата неверного формата`;
    }
    for (const point of points[color]) {
      if (!isCoordinate(point, field)) {
        return `В points.${color} найдена координата за пределами поля или неверного формата`;
      }
    }
  }

  if (request.last !== null && request.last !== undefined &&
      !isCoordinate(request.last, field)) {
    return 'last должен быть null или парой координат внутри поля';
  }

  return null;
}

function findAnyFreeMove(request) {
  if (request.field.infinite === true) return infiniteFallback(request.points);
  const { width, height } = request.field;
  const busy = new Set();

  for (const color of ['red', 'blue']) {
    for (const [x, y] of request.points[color]) {
      busy.add(`${x},${y}`);
    }
  }

  // Сначала проверяем центр, затем остальные клетки по строкам.
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  if (!busy.has(`${centerX},${centerY}`)) {
    return { x: centerX, y: centerY };
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!busy.has(`${x},${y}`)) return { x, y };
    }
  }

  return null;
}

function isLegalMove(move, request) {
  if (!move || !isCoordinate([move.x, move.y], request.field)) return false;

  const key = `${move.x},${move.y}`;
  return !request.points.red.some(([x, y]) => `${x},${y}` === key) &&
    !request.points.blue.some(([x, y]) => `${x},${y}` === key);
}

function positionFingerprint({ you, field, points, dead }) {
  const dimensions = field.infinite === true ? [true] : [field.width, field.height];
  const position = [you, dimensions, points.red, points.blue, dead?.red ?? [], dead?.blue ?? []];
  return createHash('sha256').update(JSON.stringify(position)).digest('base64');
}

export function createBotServer({
  botToken = process.env.BOT_TOKEN,
  dashboardToken = process.env.DASHBOARD_TOKEN,
  dashboardAccessTokenHash = process.env.DASHBOARD_ACCESS_TOKEN_HASH,
  dashboardAccessPasswordHash = process.env.DASHBOARD_ACCESS_PASSWORD_HASH,
  serveDashboard = process.env.SERVE_DASHBOARD !== '0',
  dashboard = createDashboard(),
  restart,
  gameLogs = createGameLogs({ directory: process.env.GAME_LOG_DIR, botVersion: BOT_VERSION }),
} = {}) {
  const games = new Map();
  const endedBeforeMove = new Set();
  let activityOrder = 0;
  const fallbackResponses = new WeakSet();
  const expectedAuthorization = dashboardToken && Buffer.from(`Bearer ${dashboardToken}`);
  const dashboardAccess = createDashboardAccess({
    tokenHash: dashboardAccessTokenHash,
    passwordHash: dashboardAccessPasswordHash,
  });
  const passwordAccess = serveDashboard && dashboardAccess.enabled;
  const instanceId = randomUUID();
  let restartPending = false;
  let exportPending = false;

  function gameMetadata(record) {
    const snapshot = record.snapshot;
    if (!snapshot) {
      return { lastMoveNo: record.lastMoveNo, lastFingerprint: record.lastFingerprint, pointCount: record.pointCount };
    }
    return {
      lastMoveNo: snapshot.moveNo,
      lastFingerprint: positionFingerprint(snapshot),
      pointCount: snapshot.points.red.length + snapshot.points.blue.length,
    };
  }

  for (const record of dashboard.restore()) {
    const { session, snapshot } = record;
    const number = session.id === session.gameId ? 1 : Number(session.id.slice(session.gameId.length + 1));
    const game = { number, session, ...gameMetadata(record), moves: new Map() };
    if (snapshot?.status === 200 && snapshot.move) {
      game.moves.set(game.lastMoveNo, { fingerprint: game.lastFingerprint, response: snapshot.move });
      if (snapshot.fallback) fallbackResponses.add(snapshot.move);
    }
    games.set(session.gameId, game);
    if (games.size > MAX_CACHED_GAMES) games.delete(games.keys().next().value);
    activityOrder = Math.max(activityOrder, session.activityOrder);
  }

  function requireDashboardAccess(req, res) {
    if (!expectedAuthorization && !passwordAccess) {
      sendError(res, 403, 'forbidden', 'Чтобы открыть партии, задайте DASHBOARD_TOKEN на сервере');
      return false;
    }
    const authorization = req.headers.authorization ?? '';
    const supplied = Buffer.from(authorization);
    const matchesBearer = expectedAuthorization && supplied.length === expectedAuthorization.length &&
      timingSafeEqual(supplied, expectedAuthorization);
    if (matchesBearer || (passwordAccess && !authorization && dashboardAccess.hasSession(req))) return true;
    sendError(res, 401, 'unauthorized', 'Введите действующий токен панели');
    return false;
  }
  async function exportGames(req, res) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const games = dashboard.list();
    const selection = query.getAll('ids');
    const ids = new Set(selection.length === 1 && !games.some(game => game.id === selection[0])
      ? selection[0].split(',') : selection);
    const chosen = ids.size ? games.filter(game => ids.has(game.id)) : games;
    if (!chosen.length) {
      sendError(res, 404, 'no_games', ids.size ? 'Выбранные партии не найдены' : 'В истории нет партий');
      return;
    }
    if (exportPending) {
      sendError(res, 429, 'export_busy', 'Дождитесь окончания другой выгрузки');
      return;
    }
    exportPending = true;
    try {
      const used = new Set(['manifest.json']);
      const exportedAt = new Date().toISOString();
      const manifest = { schemaVersion: DASHBOARD_SCHEMA_VERSION, exportedAt, botVersion: BOT_VERSION, files: [] };
      const files = [];
      for (const entry of chosen) {
        const document = dashboard.get(entry.id);
        if (!document) continue;
        const { id, mode, field, moveCount, score } = document;
        const name = gameFilename(id, used);
        files.push({ name, document });
        manifest.files.push({ name, id, mode, field, moveCount, score });
      }
      if (!files.length) {
        sendError(res, 404, 'no_games', 'Выбранные партии не найдены');
        return;
      }
      files.push({ name: 'manifest.json', document: manifest });
      const { chunks, length } = await createZip(files);
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="games_${exportedAt.slice(0, 10)}.zip"`,
        'Cache-Control': 'no-store',
        'Content-Length': length,
      });
      await pipeline(Readable.from(chunks), res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof ZipLimitError) sendError(res, 413, 'archive_too_large', 'Размер выгрузки превышает 100 МБ');
      else sendError(res, 500, 'export_failed', 'Не удалось подготовить ZIP-архив');
    } finally {
      exportPending = false;
    }
  }

  return http.createServer(async (req, res) => {
    const rawPath = (req.url || '/').split('?', 1)[0];
    if (!rawPath.startsWith('/v1/')) {
      if (passwordAccess && req.method === 'POST' &&
          (rawPath === '/api/dashboard-session' || rawPath === '/api/dashboard-session/logout')) {
        const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          sendError(res, 415, 'unsupported_media_type', 'Ожидается Content-Type: application/json');
          return;
        }
        if (rawPath.endsWith('/logout')) {
          dashboardAccess.signOut(req, res);
          sendJson(res, 200, { ok: true });
          return;
        }
        let body;
        try {
          body = await readJson(req, 1024);
        } catch (error) {
          sendError(res, error.statusCode ?? 400, error.code ?? 'invalid_request', 'Не удалось прочитать запрос');
          return;
        }
        const status = dashboardAccess.signIn(req, res, body?.password);
        if (status === 200) sendJson(res, 200, { ok: true });
        else if (status === 429) sendError(res, 429, 'too_many_attempts', 'Слишком много попыток');
        else sendError(res, 401, 'unauthorized', 'Неверный пароль');
        return;
      }
      if (req.method === 'GET' && rawPath === '/api/status') {
        sendJson(res, 200, { ...dashboard.status(BOT_VERSION), gameLogs: gameLogs.status(), instanceId });
        return;
      }
      if (serveDashboard && req.method === 'POST' && rawPath === '/api/restart') {
        if (!requireDashboardAccess(req, res)) return;
        if (!restart || !dashboardAccess.passwordConfigured) {
          sendError(res, 503, 'restart_unavailable', 'Перезапуск не настроен на сервере');
          return;
        }
        if ((req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          sendError(res, 415, 'unsupported_media_type', 'Ожидается Content-Type: application/json');
          return;
        }
        let body;
        try {
          body = await readJson(req, 1024);
        } catch (error) {
          sendError(res, error.statusCode ?? 400, error.code ?? 'invalid_request', 'Не удалось прочитать запрос');
          return;
        }
        const status = dashboardAccess.verifyPassword(res, body?.password);
        if (status !== 200) {
          sendError(res, status, status === 429 ? 'too_many_attempts' : 'unauthorized',
            status === 429 ? 'Слишком много попыток' : 'Неверный пароль');
          return;
        }
        res.once('finish', () => {
          if (restartPending) return;
          restartPending = true;
          restart();
        });
        sendJson(res, 202, { instanceId });
        return;
      }
      if (serveDashboard && req.method === 'DELETE' && rawPath.startsWith('/api/games/')) {
        if (!requireDashboardAccess(req, res)) return;
        const key = rawPath.slice('/api/games/'.length);
        let id;
        try { if (key && !key.includes('/')) id = decodeURIComponent(key); } catch {}
        const game = id && dashboard.get(id);
        if (game) {
          const latest = games.get(game.gameId);
          const state = latest?.session.id === id ? latest : gameMetadata(game);
          const { lastMoveNo, lastFingerprint, pointCount } = state;
          try {
            if (dashboard.remove(id, { lastMoveNo, lastFingerprint, pointCount })) {
              sendJson(res, 200, { ok: true });
              return;
            }
          } catch (error) {
            console.error('Не удалось удалить партию из истории:', error.message);
            sendError(res, 500, 'delete_failed', 'Не удалось удалить партию');
            return;
          }
        }
        sendError(res, 404, 'not_found', 'Партия не найдена');
        return;
      }
      if (req.method === 'GET' && (rawPath === '/api/recent-moves' || rawPath === '/api/games' || rawPath.startsWith('/api/games/'))) {
        if (!requireDashboardAccess(req, res)) return;
        if (rawPath === '/api/games/export.zip') {
          await exportGames(req, res);
          return;
        }
        if (rawPath === '/api/games') {
          sendJson(res, 200, dashboard.list());
          return;
        }
        if (rawPath === '/api/recent-moves') {
          sendJson(res, 200, dashboard.recent());
          return;
        }
        const id = rawPath.slice('/api/games/'.length);
        let game;
        if (id && !id.includes('/')) {
          try {
            game = dashboard.get(decodeURIComponent(id));
          } catch (error) {
            if (!(error instanceof URIError)) throw error;
          }
        }
        if (game) {
          sendJson(res, 200, game);
          return;
        }
        sendError(res, 404, 'not_found', 'Партия не найдена');
        return;
      }
      if (serveDashboard && await serveDashboardFile(req, res, rawPath, passwordAccess)) return;
      sendError(res, 404, 'not_found', 'Маршрут не найден');
      return;
    }

    addCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/info') {
      sendJson(res, 200, {
        name: 'Dots Bot',
        version: BOT_VERSION,
        project: 'dots',
        specVersion: 'v1',
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/game/end') {
      if (botToken && req.headers.authorization !== `Bearer ${botToken}`) {
        sendError(res, 401, 'unauthorized', 'Неверный или отсутствующий токен');
        return;
      }
      let body;
      try {
        body = await readJson(req, 16 * 1024);
      } catch (error) {
        sendError(res, error.statusCode || 400, error.code || 'invalid_request', error.message);
        return;
      }
      const gameId = body?.gameId;
      if (typeof gameId !== 'string' || !gameId.length) {
        sendError(res, 400, 'bad_request', 'gameId должен быть непустой строкой');
        return;
      }
      const game = games.get(gameId);
      if (game) {
        game.session.endedAt ??= Date.now();
        dashboard.sessionChanged();
      } else {
        // Уведомление браузера может прийти раньше первого запроса хода.
        endedBeforeMove.add(gameId);
        if (endedBeforeMove.size > MAX_CACHED_GAMES) endedBeforeMove.delete(endedBeforeMove.values().next().value);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/move') {
      const receivedAt = Date.now();
      const startedAt = performance.now();
      const mode = req.headers['x-arena-mode'];
      const opponent = req.headers['x-arena-opponent-domain'] ?? req.headers['x-arena-opponent-url'] ?? req.headers['x-arena-opponent'];
      let position;
      let session;
      let playedMove = null;
      let replayed = false;
      let fallback = false;
      // Считаем время до отправки и переносим сбор истории за пределы ответа.
      res.once('finish', () => {
        const durationMs = performance.now() - startedAt;
        const status = res.statusCode;
        setImmediate(() => {
          // Панель и обучающий архив принимают только конечную сетку.
          const finitePosition = position?.field.infinite === true ? undefined : position;
          try {
            dashboard.record({ request: finitePosition, session, mode, opponent, move: playedMove, fallback, receivedAt, durationMs, status, replayed });
          } catch {
            dashboard.recordError();
          }
          try {
            gameLogs.record({ request: finitePosition, mode, move: playedMove, fallback, receivedAt, durationMs, status });
          } catch {
            dashboard.recordError();
          }
        });
      });

      if (botToken) {
        const authorization = req.headers.authorization || '';
        if (authorization !== `Bearer ${botToken}`) {
          sendError(res, 401, 'unauthorized', 'Неверный или отсутствующий токен');
          return;
        }
      }

      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        sendError(res, 415, 'unsupported_media_type', 'Ожидается Content-Type: application/json');
        return;
      }

      const uploadTimer = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.setHeader('Connection', 'close');
        sendError(res, 408, 'request_timeout', 'Истекло время получения позиции');
      }, responseLimit());
      uploadTimer.unref();
      let request;
      try {
        request = await readJson(req);
        if (res.writableEnded) return;
      } catch (error) {
        clearTimeout(uploadTimer);
        if (res.writableEnded || res.destroyed) return;
        sendError(
          res,
          error.statusCode || 400,
          error.code || 'invalid_request',
          error.message || 'Не удалось прочитать запрос'
        );
        return;
      }

      clearTimeout(uploadTimer);
      const validationError = validateMoveRequest(request);
      if (validationError) {
        sendError(res, 400, 'bad_request', validationError);
        return;
      }
      position = request;

      const { gameId, moveNo } = request;
      const now = Date.now();
      if (endedBeforeMove.has(gameId)) {
        sendError(res, 409, 'game_ended', 'Партия уже завершена');
        return;
      }
      const fingerprint = positionFingerprint(request);
      const { width, height } = request.field;
      const infinite = request.field.infinite === true;
      const sessionField = infinite ? { infinite: true } : { width, height };
      const pointCount = request.points.red.length + request.points.blue.length;
      let game = games.get(gameId);
      let entry = game?.moves.get(moveNo);
      const exact = entry?.fingerprint === fingerprint ||
        (game?.lastMoveNo === moveNo && game.lastFingerprint === fingerprint);
      if (!game || (!exact && (moveNo <= game.lastMoveNo || pointCount < game.pointCount ||
          infinite !== (game.session.field.infinite === true) ||
          sessionField.width !== game.session.field.width || sessionField.height !== game.session.field.height))) {
        let number = game?.number ?? 0;
        if (game) {
          game.session.endedAt ??= now;
          dashboard.sessionChanged();
        }
        let id;
        do {
          number += 1;
          id = number === 1 ? gameId : `${gameId}#${number}`;
        } while (dashboard.hasSession(id) || Array.from(games.values()).some((current) => current.session.id === id));
        game = { number, session: { id, gameId, startedAt: now, field: sessionField }, moves: new Map() };
        entry = undefined;
      }
      if (game.session.endedAt !== undefined && !entry?.response) {
        sendError(res, 409, 'game_ended', 'Партия уже завершена');
        return;
      }
      session = game.session;
      session.lastActivityAt = now;
      session.activityOrder = ++activityOrder;
      if (!exact) {
        game.lastMoveNo = moveNo;
        game.lastFingerprint = fingerprint;
        game.pointCount = pointCount;
      }
      games.delete(gameId);
      games.set(gameId, game);
      if (games.size > MAX_CACHED_GAMES) games.delete(games.keys().next().value);

      if (!entry) {
        entry = { fingerprint };
        game.moves.set(moveNo, entry);
        if (game.moves.size > MAX_CACHED_MOVES) game.moves.delete(game.moves.keys().next().value);
      }
      if (entry.response) {
        replayed = true;
        playedMove = entry.response;
        fallback = fallbackResponses.has(playedMove);
        sendJson(res, 200, playedMove);
        return;
      }

      const cancellation = new AbortController();
      const cancel = () => cancellation.abort(new Error('Клиент отменил запрос хода'));
      res.once('close', cancel);
      if (res.destroyed) cancel();
      let move;
      try {
        move = pointCount === 0 ? findAnyFreeMove(request) : await computeMove(request, cancellation.signal, startedAt);
        if (cancellation.signal.aborted) return;
        // Не позволяем ошибке алгоритма превратиться в пропуск хода.
        // Если стратегия вернула некорректную клетку, выбираем любую свободную.
        if (!isLegalMove(move, request)) {
          console.warn('Алгоритм вернул недопустимый ход; используется запасной ход.');
          fallback = true;
          move = findAnyFreeMove(request);
        }
      } catch (error) {
        if (cancellation.signal.aborted) return;
        console.error('Ошибка при выборе хода:', error);
        fallback = true;
        move = findAnyFreeMove(request);

      } finally {
        res.off('close', cancel);
      }
      if (res.destroyed || cancellation.signal.aborted) return;
      if (!move) {
        session.endedAt ??= Date.now();
        sendError(res, 409, 'no_free_moves', 'На поле не осталось свободных пересечений');
        return;
      }
      // Параллельный точный повтор использует первый готовый ответ этого хода.
      const response = entry.response ?? { x: move.x, y: move.y };
      if (entry.response) fallback = fallbackResponses.has(response);
      playedMove = response;
      if (fallback) fallbackResponses.add(response);
      entry.response = response;
      if (!infinite && pointCount + 1 === width * height && game.lastMoveNo === moveNo) {
        session.endedAt ??= Date.now();
      }
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/game/start') {
      sendError(res, 404, 'not_found', 'Маршрут не найден');
      return;
    }

    if (url.pathname.startsWith('/v1/')) {
      sendError(res, 405, 'method_not_allowed', 'Метод не поддерживается для этого адреса');
      return;
    }

    sendError(res, 404, 'not_found', 'Маршрут не найден');
  });
}

// Сервер запускается только при прямом выполнении `node server/index.js`.
// Это также позволяет импортировать createBotServer в тестах без запуска порта.
const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  for (const file of ['../.env', '.env']) {
    try {
      process.loadEnvFile(fileURLToPath(new URL(file, import.meta.url)));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const PORT = Number(process.env.PORT || 4003);
  responseLimit();
  const historyFile = path.join(process.env.GAME_LOG_DIR || fileURLToPath(new URL('../data', import.meta.url)),
    'dashboard-history.json');
  const dashboard = createDashboard({ historyFile });
  let shuttingDown = false;
  const server = createBotServer({
    dashboard, restart: process.env.DOTS_SUPERVISED === '1' ? () => shutdown(75) : undefined,
  });

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 5500);
    deadline.unref();
    server.close(() => setImmediate(() => {
      clearTimeout(deadline);
      try { dashboard.flush(); } catch (error) {
        console.error('Не удалось сохранить историю при остановке:', error.message);
      }
      process.exit(code);
    }));
  }

  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  const useColor = !('NO_COLOR' in process.env) && Boolean(process.stdout.isTTY);
  const paint = (text, code) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (label, value) => console.log(`  ${paint(label.padEnd(16), '90')}${value}`);

  server.on('error', (error) => {
    console.error(`\n  ${paint('ОШИБКА ЗАПУСКА', '1;31')}`);
    console.error(error.code === 'EADDRINUSE'
      ? `  Порт ${PORT} уже занят. Остановите другой сервер или задайте PORT.`
      : `  ${error.message}`);
    console.error('');
    process.exitCode = 1;
  });

  server.listen(PORT, '0.0.0.0', () => {
    const actualPort = server.address().port;
    console.log('');
    console.log(`  ${paint('●', '96')} ${paint('ТОЧКИ', '1;97')} ${paint('/ DOTS BOT', '96')} ${paint(`v${BOT_VERSION}`, '90')}`);
    console.log(`  ${paint('─'.repeat(54), '90')}`);
    console.log(`  ${paint('ГОТОВ К ИГРЕ', '1;32')}  ${paint('HTTP-сервер запущен', '90')}`);
    console.log('');
    line('Адрес', paint(`http://localhost:${actualPort}`, '1;96'));
    line('Доступ', 'Все сетевые интерфейсы (0.0.0.0)');
    line('Проверка', `GET  http://localhost:${actualPort}/v1/health`);
    line('Информация', 'GET  /v1/info');
    line('Ход бота', 'POST /v1/move');
    line('Авторизация', process.env.BOT_TOKEN ? 'Включена · Bearer-токен' : 'Без токена');
    line('Панель', process.env.DASHBOARD_TOKEN || process.env.DASHBOARD_ACCESS_TOKEN_HASH
      ? 'Доступ к партиям защищён' : 'Задайте DASHBOARD_TOKEN');
    console.log('');
    line('Играть', 'Откройте web/index.html в браузере');
    line('Остановить', paint('Ctrl+C', '1;93'));
    console.log(`  ${paint('─'.repeat(54), '90')}\n`);
  });
}
