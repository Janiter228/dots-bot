import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotServer } from '../server/index.js';

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
  assert.equal(data.version, '0.3.1');
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
    body: JSON.stringify({ ...emptyPosition, field: { width: 1, height: 1 }, points: { red: [[0, 0]], blue: [] } }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'no_free_moves');
});
