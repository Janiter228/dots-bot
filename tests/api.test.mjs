import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_VERSION } from '../bot/index.js';
import { createBotServer } from '../server/index.js';
import { nestedPosition } from './support/nested-capture.mjs';

let server;
let baseUrl;

before(async () => {
  server = createBotServer({ botToken: '' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('GET /v1/health возвращает статус ok', async () => {
  const response = await fetch(`${baseUrl}/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /v1/info возвращает информацию о боте', async () => {
  const response = await fetch(`${baseUrl}/v1/info`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.specVersion, 'v1');
  assert.equal(data.version, BOT_VERSION);
});

test('POST /v1/move возвращает свободную клетку на пустом поле', async () => {
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId: 'test-game',
      moveNo: 1,
      you: 'red',
      field: { width: 10, height: 10 },
      points: { red: [], blue: [] },
      dead: { red: [], blue: [] },
      score: { red: 0, blue: 0 },
      last: null,
      moveTimeoutMs: 5000,
      timeLeftMs: 900000,
    }),
  });

  const move = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Number.isInteger(move.x) && move.x >= 0 && move.x < 10);
  assert.ok(Number.isInteger(move.y) && move.y >= 0 && move.y < 10);
});

test('POST /v1/move выбирает одну из оставшихся свободных клеток', async () => {
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId: 'almost-full',
      moveNo: 20,
      you: 'blue',
      field: { width: 2, height: 2 },
      points: {
        red: [[0, 0], [1, 0]],
        blue: [[0, 1]],
      },
      dead: { red: [], blue: [] },
      score: { red: 0, blue: 0 },
      last: [0, 1],
      moveTimeoutMs: 5000,
      timeLeftMs: 800000,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { x: 1, y: 1 });
});

test('POST /v1/move отклоняет некорректный запрос', async () => {
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ you: 'green' }),
  });

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.code, 'bad_request');
});

const emptyPosition = {
  gameId: 'contract', moveNo: 1, you: 'red', field: { width: 3, height: 3 },
  points: { red: [], blue: [] }, dead: { red: [], blue: [] }, last: null,
  moveTimeoutMs: 50, timeLeftMs: 900000,
};

async function postMove(position) {
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arena-Seq': String(position.moveNo) },
    body: JSON.stringify(position),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('повтор хода возвращает первый ответ, а другая партия обрабатывается независимо', async () => {
  const position = { ...emptyPosition, gameId: 'repeat' };
  const first = await postMove(position);
  assert.deepEqual(first, { x: 1, y: 1 });
  for (let i = 0; i < 3; i++) assert.deepEqual(await postMove(position), first);

  const largerField = { ...position, field: { width: 5, height: 5 } };
  // Изменённая позиция делает пересчёт наблюдаемым при том же ключе повтора.
  assert.deepEqual(await postMove(largerField), first);
  assert.deepEqual(await postMove({ ...largerField, gameId: 'different-game' }), { x: 2, y: 2 });
  assert.deepEqual(await postMove({ ...largerField, moveNo: 2 }), { x: 2, y: 2 });

  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arena-Seq': '1' },
    body: JSON.stringify({ ...position, points: { red: [], blue: [[1, 1]] } }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'conflicting_position');
});

test('HTTP-ход при вложенном окружении указывает свободную клетку', async () => {
  const { x, y } = await postMove(nestedPosition);
  assert.ok(Number.isInteger(x) && x >= 0 && x < nestedPosition.field.width);
  assert.ok(Number.isInteger(y) && y >= 0 && y < nestedPosition.field.height);
  assert.ok(!Object.values(nestedPosition.points).flat().some(([px, py]) => px === x && py === y));
});

test('CORS preflight разрешает браузерную песочницу', async () => {
  const response = await fetch(`${baseUrl}/v1/move`, { method: 'OPTIONS',
    headers: { Origin: 'https://arena.projectset.ru', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
});

test('ошибочные запросы не мешают следующему допустимому ходу', async () => {
  const cases = [
    ['application/json', '{', 400],
    ['application/json', '', 400],
    ['text/plain', '{}', 415],
    ['application/json', JSON.stringify({ ...emptyPosition, you: 'green' }), 400],
    ['application/json', JSON.stringify({ ...emptyPosition, points: { red: [[3, 0]], blue: [] } }), 400],
  ];
  for (const [type, body, status] of cases) {
    const response = await fetch(`${baseUrl}/v1/move`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    });
    assert.equal(response.status, status);
    assert.ok((await response.json()).error.code);
  }
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emptyPosition),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { x: 1, y: 1 });
});

test('полное поле возвращает 409', async () => {
  const response = await fetch(`${baseUrl}/v1/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...emptyPosition, gameId: 'full-field', field: { width: 1, height: 1 },
      points: { red: [[0, 0]], blue: [] } }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'no_free_moves');
});
