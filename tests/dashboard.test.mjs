import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_VERSION } from '../bot/index.js';
import { createDashboard } from '../server/dashboard.js';
import { createBotServer } from '../server/index.js';

async function start(t, options) {
  const server = createBotServer({ botToken: '', ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return server.address().port;
}

function get(port, path, method = 'GET') {
  // HTTP-клиент передаёт исходный путь, включая сегменты, которые Fetch нормализует.
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject).end();
  });
}

test('панель и фавиконы доступны через GET и HEAD', async (t) => {
  const port = await start(t, { serveDashboard: true });
  for (const route of ['/', '/index.html']) {
    const page = await get(port, route);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.match(page.body, /<title>Dots Bot · панель<\/title>/);
    const inline = page.body.match(/rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/);
    assert.ok(inline);
    const icon = await get(port, '/favicon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.equal(decodeURIComponent(inline[1]), icon.body.trim());
    const head = await get(port, route, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], page.headers['content-length']);
    assert.equal(head.body, '');
  }
  const ico = await get(port, '/favicon.ico');
  assert.equal(ico.status, 204);
  assert.equal(ico.body, '');
});

test('недопустимые пути и отсутствующие файлы возвращают JSON 404', async (t) => {
  const port = await start(t, { serveDashboard: true });
  for (const route of ['/x/../favicon.svg', '/x/%2e%2e/favicon.svg', '/%00favicon.svg',
    '//favicon.svg', '/%2Ffavicon.svg', '/C:%5Cfavicon.svg', '/%XZ.svg', '/unknown', '/web/index.html']) {
    const result = await get(port, route);
    assert.equal(result.status, 404, route);
    assert.deepEqual(JSON.parse(result.body), { error: { code: 'not_found', message: 'Маршрут не найден' } });
  }
});

test('SERVE_DASHBOARD=0 отключает страницу и статические файлы', async (t) => {
  const previous = process.env.SERVE_DASHBOARD;
  process.env.SERVE_DASHBOARD = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.SERVE_DASHBOARD;
    else process.env.SERVE_DASHBOARD = previous;
  });
  const port = await start(t);
  for (const route of ['/', '/index.html', '/favicon.svg', '/favicon.ico']) {
    assert.equal((await get(port, route)).status, 404, route);
  }
  assert.equal((await get(port, '/v1/health')).status, 200);
});

const TOKEN = 'test-dashboard-token';
const position = {
  gameId: 'g/тест?1', moveNo: 2, you: 'blue', field: { width: 5, height: 4 },
  points: { red: [[0, 0]], blue: [] }, dead: { red: [[0, 0]], blue: [] },
  score: { red: 0, blue: 1 }, last: [0, 0],
};

function api(port, path, options) {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

function gamesApi(port, path = '/api/games', token = TOKEN) {
  return api(port, path, { headers: { Authorization: `Bearer ${token}` } });
}

function move(port, changes, headers) {
  return api(port, '/v1/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arena-Mode': 'round', ...headers },
    body: JSON.stringify({ ...position, ...changes }),
  });
}

async function jsonOk(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

test('метрики открыты, а список и отдельная партия защищены токеном панели', async (t) => {
  const configured = await start(t, { dashboardToken: TOKEN });
  const closed = await start(t, { dashboardToken: '', serveDashboard: false });
  for (const port of [configured, closed]) {
    const stats = await jsonOk(await api(port, '/api/status'));
    assert.equal(stats.version, BOT_VERSION);
    assert.equal(stats.moves, 0);
    assert.equal(stats.lastRequestAt, null);
    assert.equal(stats.games, undefined);
  }
  for (const path of ['/api/games', '/api/games/any', '/api/recent-moves']) {
    const forbidden = await gamesApi(closed, path);
    assert.equal(forbidden.status, 403);
    assert.match((await forbidden.json()).error.message, /задайте DASHBOARD_TOKEN/i);
    const unauthorized = await gamesApi(configured, path, 'wrong-dashboard-test');
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, 'unauthorized');
    assert.equal((await api(configured, `${path}?token=${TOKEN}`)).status, 401);
  }
  assert.deepEqual(await jsonOk(await gamesApi(configured)), []);
  assert.equal((await gamesApi(configured, '/api/games/any')).status, 404);
});

test('лента содержит 10 последних успешных ходов по всем партиям без дублей повторных запросов', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  const route = '/api/recent-moves';
  assert.deepEqual(await jsonOk(await gamesApi(port, route)), []);
  for (let moveNo = 1; moveNo <= 11; moveNo++) {
    await jsonOk(await move(port, { gameId: `recent-${moveNo % 2}`, moveNo }));
  }
  const reply = await jsonOk(await move(port, { gameId: 'recent-0', moveNo: 10 }));
  const rejected = await move(port, { gameId: 'recent-0', moveNo: 12 }, { 'Content-Type': 'text/plain' });
  assert.equal(rejected.status, 415);
  const recent = await jsonOk(await gamesApi(port, route));
  assert.deepEqual(recent.map((entry) => entry.moveNo), [10, 11, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(recent[0].gameId, 'recent-0');
  assert.equal(recent[1].gameId, 'recent-1');
  assert.deepEqual(recent[0].last, position.last);
  assert.deepEqual(recent[0].move, reply);
});

test('история хранит ходы, режим и последний снимок, а метрики учитывают ошибки', async (t) => {
  const port = await start(t, { botToken: 'test-bot-token', dashboardToken: TOKEN });
  const headers = { Authorization: 'Bearer test-bot-token' };
  assert.equal((await move(port, {}, { Authorization: `Bearer ${TOKEN}` })).status, 401);
  assert.equal((await move(port, { you: 'green' }, headers)).status, 400);
  const first = await jsonOk(await move(port, {}, headers));
  const points = { red: [[0, 0], [1, 0]], blue: [[first.x, first.y]] };
  const last = [1, 0];
  const next = await jsonOk(await move(port, { moveNo: 4, points, last }, headers));
  assert.deepEqual(await jsonOk(await move(port, {}, headers)), first);
  const list = await jsonOk(await gamesApi(port));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, position.gameId);
  assert.equal(list[0].mode, 'round');
  assert.equal(list[0].you, 'blue');
  assert.equal(list[0].moveCount, 3);
  assert.deepEqual(list[0].score, position.score);
  const game = await jsonOk(await gamesApi(port, `/api/games/${encodeURIComponent(position.gameId)}`));
  assert.deepEqual(game.moves.map((item) => item.moveNo), [2, 4, 2]);
  assert.equal(game.id, position.gameId);
  assert.deepEqual(game.moves[1].move, next);
  assert.deepEqual(game.moves[1].last, last);
  assert.equal(game.moves[1].receivedAt > 0, true);
  assert.equal(game.moves[1].durationMs >= 0, true);
  assert.deepEqual(game.snapshot.points, points);
  assert.deepEqual(game.snapshot.dead, position.dead);
  assert.deepEqual(game.snapshot.score, position.score);
  assert.equal(game.snapshot.moveNo, 4);
  assert.doesNotMatch(JSON.stringify(game), /test-bot-token|test-dashboard-token|authorization/i);
  const stats = await jsonOk(await api(port, '/api/status'));
  assert.equal(stats.moves, 3);
  assert.equal(stats.errors, 2);
  assert.equal(stats.fallbackMoves, 0);
  assert.ok(stats.maxMoveMs >= stats.averageMoveMs);
  assert.equal(stats.lastRequestAt, game.moves.at(-1).receivedAt);
});

test('21-я партия вытесняет первую', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  for (let index = 0; index < 21; index++) await jsonOk(await move(port, { gameId: `game-${index}` }));
  const list = await jsonOk(await gamesApi(port));
  assert.equal(list.length, 20);
  assert.equal(list[0].id, 'game-20');
  assert.equal(list.at(-1).id, 'game-1');
  assert.equal((await gamesApi(port, '/api/games/game-0')).status, 404);
});

test('из 10 000 запросов для одной партии история хранит только последние 3000', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  const empty = { points: { red: [], blue: [] }, dead: { red: [], blue: [] }, last: null };
  for (let index = 0; index < 10000; index++) await jsonOk(await move(port, { ...empty, moveNo: index + 1 }));
  const game = await jsonOk(await gamesApi(port, `/api/games/${encodeURIComponent(position.gameId)}`));
  assert.equal(game.moves.length, 3000);
  assert.equal(game.moves[0].moveNo, 7001);
  assert.equal(game.snapshot.moveNo, 10000);
  assert.equal((await jsonOk(await api(port, '/api/status'))).moves, 10000);
});

test('ошибка записи истории не меняет ответ хода и идемпотентность', async (t) => {
  const dashboard = createDashboard();
  const spy = t.mock.method(dashboard, 'record', () => { throw new Error('Сбой тестового сборщика'); });
  const port = await start(t, { dashboard });
  assert.deepEqual(await jsonOk(await move(port)), await jsonOk(await move(port)));
  assert.equal((await jsonOk(await api(port, '/api/status'))).recordingErrors, 2);
  assert.equal(spy.mock.callCount(), 2);
});
