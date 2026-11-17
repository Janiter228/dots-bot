import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseMove } from '../bot/index.js';

const PORT = Number(process.env.PORT || 4003);
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

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

export function createBotServer({ botToken = process.env.BOT_TOKEN } = {}) {
  return http.createServer(async (req, res) => {
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
        version: '0.3.0',
        project: 'dots',
        specVersion: 'v1',
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/move') {
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

      try {
        let move = chooseMove(request);

        // Не позволяем ошибке алгоритма превратиться в пропуск хода.
        // Если стратегия вернула некорректную клетку, выбираем любую свободную.
        if (!isLegalMove(move, request)) {
          console.warn('Алгоритм вернул недопустимый ход; используется запасной ход.');
          move = findAnyFreeMove(request);
        }

        if (!move) {
          sendError(res, 409, 'no_free_moves', 'На поле не осталось свободных пересечений');
          return;
        }

        sendJson(res, 200, { x: move.x, y: move.y });
      } catch (error) {
        console.error('Ошибка при выборе хода:', error);
        const fallbackMove = findAnyFreeMove(request);
        if (fallbackMove) {
          sendJson(res, 200, fallbackMove);
        } else {
          sendError(res, 500, 'bot_error', 'Не удалось выбрать ход');
        }
      }
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dots bot API listening on port ${PORT}`);
  });
}
