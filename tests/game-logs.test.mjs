import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createGameLogs } from '../server/game-logs.js';
import { createBotServer } from '../server/index.js';

const event = () => ({ request: {
  gameId: 'game-one', moveNo: 2, you: 'blue', field: { width: 3, height: 2 },
  points: { red: [[0, 0]], blue: [] }, dead: { red: [[0, 0, 'extra-secret']], blue: [] },
  last: [0, 0], token: 'secret-payload', authorization: 'secret-header',
}, mode: 'round', move: { x: 1, y: 1 }, fallback: false,
receivedAt: Date.UTC(2026, 10, 23), durationMs: 12, status: 200 });

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-logs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('JSONL сохраняет каждую позицию, переживает новый writer и выгружается командой', async (t) => {
  const directory = await temporary(t);
  const logs = createGameLogs({ directory, botVersion: 'test' });
  logs.record(event());
  logs.record({ ...event(), receivedAt: Date.UTC(2026, 10, 24) });
  await logs.flush();
  const first = JSON.parse(await readFile(path.join(directory, '2026-11-23.jsonl'), 'utf8'));
  assert.deepEqual(first.position.points, event().request.points);
  assert.deepEqual(first.position.dead, { red: [], blue: [] });
  assert.equal(first.target.action, 4);
  assert.equal(first.target.outcome, null);
  assert.equal(first.position.token, undefined);
  assert.ok(!JSON.stringify(first).includes('secret'));
  const restart = createGameLogs({ directory, botVersion: 'test' });
  restart.record(event());
  await restart.flush();
  const result = await promisify(execFile)(process.execPath, ['scripts/export-game-logs.mjs'], {
    env: { ...process.env, GAME_LOG_DIR: directory },
  });
  const records = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  assert.notEqual(records[0].runId, records[1].runId);
  assert.equal(records[0].episodeId, records[2].episodeId);
  assert.equal(logs.status().written, 2);
});

test('ошибки записи и переполнение очереди учитываются; неуспешные ходы не пишутся', async (t) => {
  const directory = await temporary(t);
  const blocked = path.join(directory, 'not-directory');
  await writeFile(blocked, 'file');
  const logs = createGameLogs({ directory: blocked, maxPending: 1 });
  logs.record(event());
  logs.record(event());
  await logs.flush();
  assert.deepEqual(logs.status(), { enabled: true, pending: 0, written: 0, errors: 1, dropped: 1 });
  const disabled = createGameLogs();
  disabled.record(event());
  assert.equal(disabled.status().written, 0);
  const healthy = createGameLogs({ directory });
  healthy.record({ ...event(), status: 401 });
  await healthy.flush();
  assert.equal(healthy.status().written, 0);
});

test('HTTP-ход записывается после ответа без токенов', async (t) => {
  const directory = await temporary(t);
  const logs = createGameLogs({ directory, botVersion: 'test' });
  const server = createBotServer({ botToken: 'bot-secret', dashboardToken: 'dashboard-secret', gameLogs: logs });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = { ...event().request, field: { width: 3, height: 3 }, moveTimeoutMs: 5000 };
  const response = await fetch(`${url}/v1/move`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bot-secret' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const move = await response.json();
  // record вызывается через setImmediate после finish HTTP-ответа.
  await new Promise(setImmediate);
  await logs.flush();
  assert.equal(logs.status().written, 1);
  const { readdir } = await import('node:fs/promises');
  const text = await readFile(path.join(directory, (await readdir(directory))[0]), 'utf8');
  assert.ok(!text.includes('secret'));
  assert.deepEqual(JSON.parse(text).response, move);
  const stats = await (await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer dashboard-secret' } })).json();
  assert.equal(stats.gameLogs.written, 1);
  assert.ok(!JSON.stringify(stats).includes(directory));
  // После первой записи делаем путь недоступным: ход всё равно отвечает 200.
  await rm(directory, { recursive: true, force: true });
  await writeFile(directory, 'not-a-directory');
  const repeated = await fetch(`${url}/v1/move`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bot-secret' }, body: JSON.stringify(body) });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), move);
  await new Promise(setImmediate);
  await logs.flush();
  assert.equal(logs.status().errors, 1);
});
