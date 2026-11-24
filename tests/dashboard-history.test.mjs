import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboard } from '../server/dashboard.js';
import { createBotServer } from '../server/index.js';

const token = 'panel-test';
const password = '1234';
const salt = Buffer.alloc(16);
const passwordHash = salt.toString('hex') + ':' + scryptSync(password, salt, 32).toString('hex');
const auth = { Authorization: `Bearer ${token}` };

async function historyFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dots-dashboard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'history.json');
}

async function start(t, dashboard, restart) {
  const server = createBotServer({ botToken: '', dashboardToken: token, dashboardAccessPasswordHash: passwordHash, dashboard, restart });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return (route, options) => fetch(origin + route, options);
}

const input = { gameId: 'g/1', moveNo: 1, you: 'red', field: { width: 5, height: 5 }, points: { red: [], blue: [] } };
function post(body, headers = {}) {
  return { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

test('перезапуск требует входа в панель и того же хеша PIN', async t => {
  let requested = 0;
  const api = await start(t, createDashboard(), () => requested++);
  const restart = (pin, headers) => api('/api/restart', post({ password: pin }, headers));
  assert.equal((await restart(password, {})).status, 401);
  assert.equal((await restart('0000', auth)).status, 401);
  assert.equal(requested, 0);
  const status = await (await api('/api/status')).json();
  const response = await restart(password, auth);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { instanceId: status.instanceId });
  assert.equal((await restart(password, auth)).status, 202);
  assert.equal(requested, 1);
});

test('история переживает перезапуск, удаление сохраняется и не мешает сыграть следующий ход', async t => {
  const file = await historyFile(t);
  const first = createDashboard({ historyFile: file });
  const api = await start(t, first);
  const move = await (await api('/v1/move', post(input))).json();
  first.flush();

  const restored = createDashboard({ historyFile: file });
  const reopened = await start(t, restored);
  const list = async () => (await reopened('/api/games', { headers: auth })).json();
  assert.equal((await list())[0].id, input.gameId);
  const route = '/api/games/' + encodeURIComponent(input.gameId);
  assert.equal((await reopened(route, { method: 'DELETE' })).status, 401);
  assert.equal((await reopened(route, { method: 'DELETE', headers: auth })).status, 200);
  assert.deepEqual(await list(), []);

  const afterDelete = createDashboard({ historyFile: file });
  const afterRestart = await start(t, afterDelete);
  const next = { ...input, moveNo: 3, points: { red: [[move.x, move.y]], blue: [[0, 0]] } };
  assert.equal((await afterRestart('/v1/move', post(next))).status, 200);
  assert.deepEqual(await (await afterRestart('/api/games', { headers: auth })).json(), []);
  assert.deepEqual(await (await afterRestart('/api/recent-moves', { headers: auth })).json(), []);
});

test('история удаляет партии через сутки', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const file = await historyFile(t);
  const dashboard = createDashboard({ historyFile: file });
  const api = await start(t, dashboard);
  assert.equal((await api('/v1/move', post(input))).status, 200);
  dashboard.flush();
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal(dashboard.list().length, 1);
  now++;
  assert.equal(dashboard.list().length, 0);
  assert.equal(createDashboard({ historyFile: file }).get(input.gameId), null);
});
