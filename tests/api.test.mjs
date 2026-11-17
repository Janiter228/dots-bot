import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotServer } from '../server/index.js';

let server;
let baseUrl;

before(async () => {
  server = createBotServer({ botToken: '' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
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
  assert.equal(data.version, '0.3.0');
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
