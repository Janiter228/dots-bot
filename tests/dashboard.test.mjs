import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_VERSION } from '../bot/index.js';
import { createDashboard } from '../server/dashboard.js';
import { createBotServer } from '../server/index.js';

async function start(t, options) {
  const server = createBotServer({ botToken: '', dashboardToken: TOKEN, ...options });
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
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.match(page.body, /<title>Точки · Вход<\/title>/);
    assert.doesNotMatch(page.body, /id="(?:metrics-title|board|games|toggle-bot)"/);
    assert.match(page.body, /href="\/favicon\.svg"/);
    const icon = await get(port, '/favicon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');

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
const WRONG_TOKEN = 'x' + TOKEN.slice(1);
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

test('новая песочница на меньшем поле пересчитывает первый ход', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  const first = {
    gameId: 'sandbox', moveNo: 1, you: 'red', field: { width: 7, height: 7 },
    points: { red: [], blue: [] }, dead: { red: [], blue: [] }, last: null,
  };
  assert.deepEqual(await jsonOk(await move(port, first)), { x: 3, y: 3 });
  await jsonOk(await move(port, {
    ...first, moveNo: 3, points: { red: [[3, 3]], blue: [[0, 0]] }, last: [0, 0],
  }));

  const second = { ...first, field: { width: 3, height: 3 } };
  const reply = await jsonOk(await move(port, second));
  assert.deepEqual(reply, { x: 1, y: 1 });
  assert.deepEqual(await jsonOk(await move(port, second)), reply);

  const list = await jsonOk(await gamesApi(port));
  assert.deepEqual(list.map(({ id }) => id), ['sandbox#2', 'sandbox']);
  assert.deepEqual(list.map(({ field }) => field), [second.field, first.field]);
  assert.deepEqual(list.map(({ active }) => active), [true, false]);
  assert.ok(list.every(({ startedAt, lastActivityAt }) => startedAt <= lastActivityAt));
  const original = await jsonOk(await gamesApi(port, '/api/games/sandbox'));
  const restarted = await jsonOk(await gamesApi(port, '/api/games/sandbox%232'));
  assert.deepEqual(original.moves.map(({ moveNo }) => moveNo), [1, 3]);
  assert.deepEqual(restarted.moves.map(({ moveNo }) => moveNo), [1, 1]);
  assert.deepEqual(restarted.snapshot.points, second.points);
  assert.equal((await jsonOk(await gamesApi(port, '/api/status'))).errors, 0);
  const recent = await jsonOk(await gamesApi(port, '/api/recent-moves'));
  assert.deepEqual(recent.map(({ sessionId, moveNo }) => [sessionId, moveNo]), [
    ['sandbox#2', 1], ['sandbox', 3], ['sandbox', 1],
  ]);
});

test('изменение позиции при том же номере и уменьшение числа точек открывают новые сессии', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  const initial = { gameId: 'sandbox', moveNo: 1, points: { red: [], blue: [] }, last: null };
  const first = await jsonOk(await move(port, initial));
  const changed = { ...initial, points: { red: [[first.x, first.y]], blue: [] }, last: [first.x, first.y] };
  assert.notDeepEqual(await jsonOk(await move(port, changed)), first);
  assert.deepEqual(await jsonOk(await move(port, { ...initial, moveNo: 3 })), first);
  const list = await jsonOk(await gamesApi(port));
  assert.deepEqual(list.map(({ id }) => id), ['sandbox#3', 'sandbox#2', 'sandbox']);
});

test('на границе лимита сессий сохраняется старая активная партия', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const port = await start(t, { dashboardToken: TOKEN });
  const initial = { moveNo: 1, points: { red: [], blue: [] }, last: null };
  const keep = await jsonOk(await move(port, { ...initial, gameId: 'keep' }));
  now += 1;
  await jsonOk(await move(port, { ...initial, gameId: 'sandbox' }));
  now += 30_000;
  assert.deepEqual(await jsonOk(await move(port, { ...initial, gameId: 'keep' })), keep);
  assert.equal((await jsonOk(await gamesApi(port, '/api/games/sandbox'))).active, true);
  for (let width = 6; width < 45; width++) {
    await jsonOk(await move(port, { ...initial, gameId: 'sandbox', field: { width, height: 4 } }));
  }
  const list = await jsonOk(await gamesApi(port));
  assert.equal(list.length, 40);
  assert.equal(list[0].id, 'sandbox#40');
  assert.ok(list.some((item) => item.id === 'keep' && item.active));
  assert.equal((await gamesApi(port, '/api/games/sandbox')).status, 404);
});

test('долгая пауза сохраняет партию и кэш, сброс страницы закрывает её явно', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const port = await start(t, { botToken: TOKEN, dashboardToken: TOKEN });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const first = { gameId: 'web-old', moveNo: 1, field: { width: 3, height: 3 },
    points: { red: [], blue: [] }, last: null };
  const opening = await jsonOk(await move(port, first, auth));
  now += 3_600_000;
  assert.equal((await jsonOk(await gamesApi(port, '/api/games/web-old'))).active, true);
  assert.deepEqual(await jsonOk(await move(port, { ...first, moveTimeoutMs: 1 }, auth)), opening);
  assert.equal((await jsonOk(await gamesApi(port, '/api/status'))).fallbackMoves, 0);
  const next = { ...first, moveNo: 3, points: { red: [[opening.x, opening.y]], blue: [[0, 0]] } };
  await jsonOk(await move(port, next, auth));
  assert.deepEqual((await jsonOk(await gamesApi(port))).map(({ id, active }) => [id, active]), [['web-old', true]]);

  const end = (gameId, headers = auth) => api(port, '/v1/game/end', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ gameId }),
  });
  assert.equal((await end('web-old', {})).status, 401);
  await jsonOk(await end('web-old'));
  await jsonOk(await end('web-old'));
  assert.equal((await move(port, { ...next, moveNo: 5 }, auth)).status, 409);
  await jsonOk(await move(port, { ...first, gameId: 'web-reloaded' }, auth));
  assert.deepEqual((await jsonOk(await gamesApi(port))).map(({ id, active }) => [id, active]),
    [['web-reloaded', true], ['web-old', false]]);

  await jsonOk(await end('reloaded-during-first-move'));
  assert.equal((await move(port, { ...first, gameId: 'reloaded-during-first-move' }, auth)).status, 409);
});

test('последняя свободная клетка завершает сессию, а повтор хода остаётся доступен', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  const final = { gameId: 'full', moveNo: 1, field: { width: 1, height: 1 },
    points: { red: [], blue: [] }, last: null };
  const reply = await jsonOk(await move(port, final));
  assert.deepEqual(reply, { x: 0, y: 0 });
  assert.equal((await jsonOk(await gamesApi(port, '/api/games/full'))).active, false);
  assert.deepEqual(await jsonOk(await move(port, final)), reply);
});

test('панель удерживает ручной выбор, переключается при слежении и заменяет вытесненную сессию', async () => {
  const page = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const script = page.match(/<script id="game-selection">([\s\S]*?)<\/script>/)[1];
  const chooseSession = runInNewContext(`${script}\nchooseSession`);
  const old = { id: 'sandbox', startedAt: 10, active: true };
  const latest = { id: 'sandbox#2', startedAt: 20, active: true };
  const games = [old, latest];
  assert.equal(chooseSession(games, [latest], old.id, false), old.id);
  assert.equal(chooseSession(games, games, old.id, true), latest.id);
  assert.equal(chooseSession([latest], [latest], old.id, false), latest.id);
  assert.equal(chooseSession(games, [old], null, true), old.id);
});

test('метрики и история включённой панели требуют авторизацию', async (t) => {
  const configured = await start(t);
  const closed = await start(t, { dashboardToken: '', serveDashboard: false });
  assert.equal((await api(configured, '/api/status')).status, 401);
  const stats = await jsonOk(await gamesApi(configured, '/api/status'));
  assert.equal(stats.version, BOT_VERSION);
  assert.equal(stats.moves, 0);
  assert.equal(stats.lastRequestAt, null);
  assert.equal(stats.games, undefined);
  assert.ok(!JSON.stringify(stats).includes(TOKEN));
  assert.equal((await api(closed, '/api/status')).status, 200);
  for (const path of ['/api/games', '/api/games/any', '/api/recent-moves']) {
    const forbidden = await gamesApi(closed, path);
    assert.equal(forbidden.status, 403);
    const unavailable = await forbidden.text();
    assert.match(JSON.parse(unavailable).error.message, /задайте DASHBOARD_TOKEN/i);
    assert.ok(!unavailable.includes(TOKEN));
    for (const unauthorized of [await api(configured, path), await gamesApi(configured, path, WRONG_TOKEN),
      await api(configured, `${path}?token=${TOKEN}`)]) {
      assert.equal(unauthorized.status, 401);
      const body = await unauthorized.text();
      assert.equal(JSON.parse(body).error.code, 'unauthorized');
      assert.ok(!body.includes(TOKEN) && !body.includes(WRONG_TOKEN));
    }
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
  assert.ok(!JSON.stringify(recent).includes(TOKEN));
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
  assert.ok(!JSON.stringify(list).includes(TOKEN));
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
  const stats = await jsonOk(await gamesApi(port, '/api/status'));
  assert.equal(stats.moves, 3);
  assert.equal(stats.errors, 2);
  assert.equal(stats.fallbackMoves, 0);
  assert.ok(stats.maxMoveMs >= stats.averageMoveMs);
  assert.equal(stats.lastRequestAt, game.moves.at(-1).receivedAt);
});

test('41-я партия вытесняет первую', async (t) => {
  const port = await start(t, { dashboardToken: TOKEN });
  for (let index = 0; index < 41; index++) await jsonOk(await move(port, { gameId: `game-${index}` }));
  const list = await jsonOk(await gamesApi(port));
  assert.equal(list.length, 40);
  assert.equal(list[0].id, 'game-40');
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
  assert.equal((await jsonOk(await gamesApi(port, '/api/status'))).moves, 10000);
});

test('ошибка записи истории не меняет ответ хода и идемпотентность', async (t) => {
  const dashboard = createDashboard();
  const spy = t.mock.method(dashboard, 'record', () => { throw new Error('Сбой тестового сборщика'); });
  const port = await start(t, { dashboard });
  assert.deepEqual(await jsonOk(await move(port)), await jsonOk(await move(port)));
  assert.equal((await jsonOk(await gamesApi(port, '/api/status'))).recordingErrors, 2);
  assert.equal(spy.mock.callCount(), 2);
});

test('воспроизведение учитывает пропущенный ход и соединяет только живые соседние точки', async () => {
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script id="board-replay">([\s\S]*?)<\/script>/)[1];
  const { replayPlacements, liveConnections } = runInNewContext(`${script}\n({ replayPlacements, liveConnections })`);
  const snapshot = { moveNo: 8, points: { red: [[1, 1], [1, 2]], blue: [[2, 2], [3, 3], [3, 4]] } };
  const timeline = replayPlacements(snapshot, [
    { moveNo: 2, you: 'blue', last: [1, 1], move: { x: 2, y: 2 }, status: 200 },
    { moveNo: 4, you: 'blue', last: [2, 2], move: { x: 3, y: 3 }, status: 200 },
    { moveNo: 6, you: 'blue', last: [1, 2], move: { x: 3, y: 4 }, status: 200 },
  ]);
  assert.equal(JSON.stringify(timeline.red.map(p => p.presentBy)), '[1,5]');
  assert.equal(JSON.stringify(timeline.blue.map(p => p.presentBy)), '[2,4,6]');
  assert.equal(JSON.stringify(liveConnections(snapshot.points.blue, [[3, 4]])), '[[[2,2],[3,3]]]');
});

test('управление ботом использует сессию через «Наш токен», панель доступна в паузе', async t => {
  const { scryptSync } = await import('node:crypto');
  const salt = Buffer.alloc(16);
  const password = '1234';
  const port = await start(t, {
    dashboardToken: 'test-dashboard',
    dashboardAccessTokenHash: 'a'.repeat(64),
    dashboardAccessPasswordHash: salt.toString('hex') + ':' + scryptSync(password, salt, 32).toString('hex'),
  });
  const url = 'http://127.0.0.1:' + port;
  const post = (path, body, headers = {}) => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const auth = { Authorization: 'Bearer test-dashboard' };
  assert.equal((await post('/api/bot-state', { enabled: false })).status, 401);
  assert.equal((await post('/api/bot-state', { password, enabled: false }, auth)).status, 403);
  const login = await post('/api/dashboard-session', { password });
  assert.equal(login.status, 200);
  const session = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual(await (await post('/api/bot-state', { enabled: false }, session)).json(), { botEnabled: false });
  const input = { gameId: 'pause-test', moveNo: 1, you: 'red', field: { width: 20, height: 20 },
    points: { red: [], blue: [] }, last: null };
  const paused = await post('/v1/move', input);
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).error.code, 'bot_disabled');
  assert.match(await (await api(port, '/', { headers: session })).text(), /id="board"/);
  assert.deepEqual(await (await post('/api/bot-state', { enabled: true }, session)).json(), { botEnabled: true });
  assert.deepEqual(await (await post('/v1/move', input)).json(), { x: 10, y: 10 });
});
