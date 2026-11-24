import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_VERSION } from '../bot/index.js';
import { computeMove } from './compute-move.js';
import { createDashboard, serveDashboardFile } from './dashboard.js';
import { createGameLogs } from './game-logs.js';

const PORT = Number(process.env.PORT || 4003);
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
// После паузы клиент мог начать новую партию с прежним gameId.
// Сбрасываем только кэш ходов; следующая позиция полностью задаётся запросом.
const MOVE_CACHE_IDLE_MS = 10 * 1000;
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
    'Content-Type, Authorization, X-Arena-Run, X-Arena-Spec, X-Arena-Mode, X-Arena-Seq'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > BODY_LIMIT_BYTES) {
      const error = new Error('Размер запроса превышает 8 МБ');
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

function isCoordinate(value, width, height) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isInteger(value[0]) &&
    isInteger(value[1]) &&
    value[0] >= 0 && value[0] < width &&
    value[1] >= 0 && value[1] < height
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
  if (!field || !isInteger(field.width) || !isInteger(field.height) ||
      field.width < 1 || field.height < 1) {
    return 'field.width и field.height должны быть положительными целыми числами';
  }
  if (field.infinite === true) {
    return 'Бот пока поддерживает только конечное поле';
  }

  const points = request.points;
  if (!points || !Array.isArray(points.red) || !Array.isArray(points.blue)) {
    return 'points должен содержать массивы points.red и points.blue';
  }

  for (const color of ['red', 'blue']) {
    for (const point of points[color]) {
      if (!isCoordinate(point, field.width, field.height)) {
        return `В points.${color} найдена координата за пределами поля или неверного формата`;
      }
    }
  }

  if (request.last !== null && request.last !== undefined &&
      !isCoordinate(request.last, field.width, field.height)) {
    return 'last должен быть null или парой координат внутри поля';
  }

  return null;
}

function findAnyFreeMove(request) {
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
  if (!move || !isInteger(move.x) || !isInteger(move.y)) return false;

  const { width, height } = request.field;
  if (move.x < 0 || move.x >= width || move.y < 0 || move.y >= height) {
    return false;
  }

  const key = `${move.x},${move.y}`;
  return !request.points.red.some(([x, y]) => `${x},${y}` === key) &&
    !request.points.blue.some(([x, y]) => `${x},${y}` === key);
}

function positionFingerprint({ you, field, points, dead }) {
  const position = [you, field.width, field.height, points.red, points.blue, dead?.red ?? [], dead?.blue ?? []];
  return createHash('sha256').update(JSON.stringify(position)).digest('base64');
}

export function createBotServer({
  botToken = process.env.BOT_TOKEN,
  dashboardToken = process.env.DASHBOARD_TOKEN,
  serveDashboard = process.env.SERVE_DASHBOARD !== '0',
  dashboard = createDashboard(),
  gameLogs = createGameLogs({ directory: process.env.GAME_LOG_DIR, botVersion: BOT_VERSION }),
} = {}) {
  const games = new Map();
  let activityOrder = 0;
  const fallbackResponses = new WeakSet();
  const expectedAuthorization = dashboardToken && Buffer.from(`Bearer ${dashboardToken}`);
  return http.createServer(async (req, res) => {
    const rawPath = (req.url || '/').split('?', 1)[0];
    if (!rawPath.startsWith('/v1/')) {
      if (req.method === 'GET' && rawPath === '/api/status') {
        sendJson(res, 200, { ...dashboard.status(BOT_VERSION), gameLogs: gameLogs.status() });
        return;
      }
      if (req.method === 'GET' && (rawPath === '/api/recent-moves' || rawPath === '/api/games' || rawPath.startsWith('/api/games/'))) {
        if (!expectedAuthorization) {
          sendError(res, 403, 'forbidden', 'Чтобы открыть партии, задайте DASHBOARD_TOKEN на сервере');
          return;
        }
        const authorization = Buffer.from(req.headers.authorization || '');
        if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
          sendError(res, 401, 'unauthorized', 'Введите действующий токен панели');
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
      if (serveDashboard && await serveDashboardFile(req, res, rawPath)) return;
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

    if (req.method === 'POST' && url.pathname === '/v1/move') {
      const receivedAt = Date.now();
      const startedAt = performance.now();
      const mode = req.headers['x-arena-mode'];
      let position;
      let session;
      let playedMove = null;
      let fallback = false;
      // Считаем время до отправки и переносим сбор истории за пределы ответа.
      res.once('finish', () => {
        const durationMs = performance.now() - startedAt;
        const status = res.statusCode;
        setImmediate(() => {
          try {
            dashboard.record({ request: position, session, mode, move: playedMove, fallback, receivedAt, durationMs, status });
          } catch {
            dashboard.recordError();
          }
          try {
            gameLogs.record({ request: position, mode, move: playedMove, fallback, receivedAt, durationMs, status });
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

      let request;
      try {
        request = await readJson(req);
      } catch (error) {
        sendError(
          res,
          error.statusCode || 400,
          error.code || 'invalid_request',
          error.message || 'Не удалось прочитать запрос'
        );
        return;
      }

      const validationError = validateMoveRequest(request);
      if (validationError) {
        sendError(res, 400, 'bad_request', validationError);
        return;
      }
      position = request;

      const { gameId, moveNo } = request;
      const now = Date.now();
      for (const previous of games.values()) {
        if (now - previous.session.lastActivityAt < MOVE_CACHE_IDLE_MS) break;
        previous.moves.clear();
      }
      const fingerprint = positionFingerprint(request);
      const { width, height } = request.field;
      const pointCount = request.points.red.length + request.points.blue.length;
      let game = games.get(gameId);
      let entry = game?.moves.get(moveNo);
      const exact = entry?.fingerprint === fingerprint ||
        (game?.lastMoveNo === moveNo && game.lastFingerprint === fingerprint);
      if (!game || (!exact && (moveNo <= game.lastMoveNo || pointCount < game.pointCount ||
          width !== game.session.field.width || height !== game.session.field.height))) {
        let number = game?.number ?? 0;
        let id;
        do {
          number += 1;
          id = number === 1 ? gameId : `${gameId}#${number}`;
        } while (dashboard.hasSession(id) || Array.from(games.values()).some((current) => current.session.id === id));
        game = { number, session: { id, gameId, startedAt: now, field: { width, height } }, moves: new Map() };
        entry = undefined;
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
        move = await computeMove(request, cancellation.signal);
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
        if (!move) {
          sendError(res, 500, 'bot_error', 'Не удалось выбрать ход');
          return;
        }
      } finally {
        res.off('close', cancel);
      }
      if (res.destroyed || cancellation.signal.aborted) return;
      if (!move) {
        sendError(res, 409, 'no_free_moves', 'На поле не осталось свободных пересечений');
        return;
      }
      // Параллельный точный повтор использует первый готовый ответ этого хода.
      const response = entry.response ?? { x: move.x, y: move.y };
      if (entry.response) fallback = fallbackResponses.has(response);
      playedMove = response;
      if (fallback) fallbackResponses.add(response);
      entry.response = response;
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && ['/v1/game/start', '/v1/game/end'].includes(url.pathname)) {
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
  const server = createBotServer();
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
    line('Панель', process.env.DASHBOARD_TOKEN ? 'Партии защищены токеном' : 'Задайте DASHBOARD_TOKEN');
    console.log('');
    line('Играть', 'Откройте web/index.html в браузере');
    line('Остановить', paint('Ctrl+C', '1;93'));
    console.log(`  ${paint('─'.repeat(54), '90')}\n`);
  });
}
