import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { BOT_VERSION } from '../bot/index.js';
import { createDashboard } from '../server/dashboard.js';
import test from 'node:test';
import { createBotServer } from '../server/index.js';

const token = 'fixture-dashboard-token';
const auth = { Authorization: 'Bearer ' + token };

async function start(t, options = {}) {
  const server = createBotServer({ botToken: '', dashboardToken: token, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, options) => fetch(base + path, options);
}

const opening = {
  gameId: 'sandbox', moveNo: 2, you: 'blue', field: { width: 5, height: 5 },
  points: { red: [[0, 0]], blue: [] }, dead: { red: [], blue: [] },
  score: { red: 0, blue: 0 }, last: [0, 0], moveTimeoutMs: 5000, timeLeftMs: 30000,
};
async function play(api, position, headers) {
  const response = await api('/v1/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(position),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const games = (api) => api('/api/games', { headers: auth }).then(response => response.json());
const detail = (api, id) => api('/api/games/' + encodeURIComponent(id), { headers: auth }).then(response => response.json());

test('первые одинаковые позиции второй партии переходят к ней после расхождения', async (t) => {
  const api = await start(t);
  const reply = await play(api, opening);
  const blue = [[reply.x, reply.y]];
  const next = { ...opening, moveNo: 4, points: { red: [[0, 0], [0, 1]], blue }, last: [0, 1] };
  const response = await play(api, next);
  const nextBlue = [...blue, [response.x, response.y]];
  const sixth = { ...opening, moveNo: 6, points: { red: [[0, 0], [0, 1], [0, 2]], blue: nextBlue }, last: [0, 2] };
  await play(api, sixth);
  assert.deepEqual(await play(api, opening), reply);
  assert.deepEqual(await play(api, next), response);
  assert.equal((await games(api)).length, 1);
  await play(api, { ...sixth, points: { red: [[0, 0], [0, 1], [1, 0]], blue: nextBlue }, last: [1, 0] });
  assert.deepEqual((await detail(api, 'sandbox#2')).moves.map(turn => turn.moveNo), [2, 4, 6]);
  assert.deepEqual((await detail(api, 'sandbox')).moves.map(turn => turn.moveNo), [2, 4, 6]);
});

function slowCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzip(buffer) {
  const files = new Map();
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  let central = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(central), 0x02014b50);
    const len = buffer.readUInt16LE(central + 28);
    const filename = buffer.toString('utf8', central + 46, central + 46 + len);
    const offset = buffer.readUInt32LE(central + 42);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    assert.equal(buffer.readUInt16LE(offset + 6), 0x0800);
    assert.equal(buffer.readUInt16LE(offset + 8), 8);
    assert.equal(buffer.toString('utf8', offset + 30, offset + 30 + len), filename);
    const bodyAt = offset + 30 + len + buffer.readUInt16LE(offset + 28);
    const body = inflateRawSync(buffer.subarray(bodyAt, bodyAt + buffer.readUInt32LE(offset + 18)));
    assert.equal(body.length, buffer.readUInt32LE(offset + 22));
    assert.equal(slowCrc(body), buffer.readUInt32LE(offset + 14));
    assert.equal(slowCrc(body), buffer.readUInt32LE(central + 16));
    assert.ok(!files.has(filename));
    files.set(filename, body.toString('utf8'));
    central += 46 + len + buffer.readUInt16LE(central + 30) + buffer.readUInt16LE(central + 32);
  }
  assert.equal(central, end);
  return files;
}

test('ZIP: авторизация, безопасные имена, манифест, CRC и точное содержимое одиночного JSON', async (t) => {
  const api = await start(t, { botToken: 'fixture-bot-token' });
  const closed = await start(t, { dashboardToken: '' });
  const route = '/api/games/export.zip';
  assert.equal((await closed(route, { headers: auth })).status, 403);
  assert.equal((await api(route, { headers: { Authorization: 'Bearer wrong-test' } })).status, 401);
  const empty = await api(route, { headers: auth });
  assert.equal(empty.status, 404);
  assert.equal((await empty.json()).error.code, 'no_games');

  for (const gameId of ['sandbox#2', 'sandbox_2', '../манифест\\партия', 'manifest']) {
    await play(api, {
      ...opening, gameId, opponentUrl: 'https://bot.example.org/move?token=private-url-value',
      Authorization: 'private-body-value',
    }, { Authorization: 'Bearer fixture-bot-token', 'X-Arena-Mode': 'practice' });
  }
  const response = await api(route, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="games_\d{4}-\d{2}-\d{2}\.zip"$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.botVersion, BOT_VERSION);
  assert.equal(new Date(manifest.exportedAt).toISOString(), manifest.exportedAt);
  assert.equal(manifest.files.length, 4);
  for (const entry of manifest.files) {
    assert.doesNotMatch(entry.name, /[#/\\]|\.\./);
    const game = await detail(api, entry.id);
    assert.deepEqual(entry.field, game.field);
    assert.deepEqual(entry.score, game.score);
    assert.equal(entry.mode, 'practice');
    assert.equal(entry.moveCount, game.moveCount);
    assert.equal(files.get(entry.name), JSON.stringify(game, null, 2));
    assert.doesNotMatch(files.get(entry.name), /fixture-dashboard-token|fixture-bot-token|private-url-value|private-body-value/);
  }
  const subset = await api(route + '?ids=sandbox%232&ids=manifest', { headers: auth });
  const selected = unzip(Buffer.from(await subset.arrayBuffer()));
  assert.deepEqual(JSON.parse(selected.get('manifest.json')).files.map(entry => entry.id).sort(), ['manifest', 'sandbox#2']);
  assert.equal((await api(route + '?ids=missing', { headers: auth })).status, 404);
});

test('ZIP отклоняет суммарный объём JSON свыше 100 МБ', async (t) => {
  const dashboard = createDashboard();
  t.mock.method(dashboard, 'list', () => [{ id: 'large' }]);
  t.mock.method(dashboard, 'get', () => ({ id: 'large', sample: 'a'.repeat(100 * 1024 * 1024) }));
  const api = await start(t, { dashboard });
  const response = await api('/api/games/export.zip', { headers: auth });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'archive_too_large');
});

test('сохраняются прежние поля, таймеры, счёт и обратимая дельта захвата и оживления', async (t) => {
  const api = await start(t);
  const capture = {
    ...opening, gameId: 'capture', moveNo: 8, you: 'blue',
    points: { red: [[2, 2]], blue: [[1, 2], [2, 1], [3, 2]] }, last: [2, 2],
  };
  const reply = await play(api, capture);
  assert.deepEqual(reply, { x: 2, y: 3 });
  const placed = [...capture.points.blue, [reply.x, reply.y]];
  const before = { ...capture, moveNo: 10, points: { red: [[2, 2], [0, 0]], blue: placed },
    dead: { red: [[2, 2]], blue: [] }, score: { red: 0, blue: 1 }, last: [0, 0] };
  const next = await play(api, before);
  await play(api, {
    ...before, moveNo: 12, points: { red: [[2, 2], [0, 0], [4, 4]], blue: [...placed, [next.x, next.y]] },
    dead: { red: [], blue: [] }, score: { red: 0, blue: 0 }, last: [4, 4],
  });
  const game = await detail(api, 'capture');
  for (const key of ['id', 'gameId', 'title', 'opponentDomain', 'field', 'startedAt', 'lastActivityAt', 'active',
    'mode', 'you', 'moveCount', 'revision', 'lastMoveAt', 'score', 'moves', 'snapshot', 'afterResponse']) {
    assert.ok(Object.hasOwn(game, key), key);
  }
  assert.equal(game.schemaVersion, 1);
  assert.equal(game.botVersion, BOT_VERSION);
  assert.equal(game.outcome, 'unfinished');
  assert.equal(game.endedAt, null);
  assert.equal(game.botMoveCount, 6);
  assert.equal(game.opponentMoveCount, 3);
  assert.deepEqual(game.gaps, [{ from: 2, to: 6 }]);
  assert.ok(game.latency.p95Ms >= game.latency.medianMs);
  assert.deepEqual(game.moves[0].scoreAfter, { red: 0, blue: 1 });
  assert.deepEqual(game.moves[0].scoreDelta, { red: 0, blue: 1 });
  assert.deepEqual(game.moves[0].events, ['capture']);
  assert.equal(game.moves[0].moveTimeoutMs, 5000);
  assert.equal(game.moves[0].timeLeftMs, 30000);
  assert.equal(game.moves[0].latencyMs, game.moves[0].durationMs);
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const code = html.match(/<script id="board-replay">([\s\S]*?)<\/script>/)[1];
  const exactReplay = runInNewContext(code + '\nexactReplay', { atob });
  const frames = new Map(game.moves.map(move => [move.moveNo, move]));
  assert.deepEqual(JSON.parse(JSON.stringify(exactReplay(game.snapshot, frames, game.moves[1]).dead)), before.dead);
  assert.deepEqual(JSON.parse(JSON.stringify(exactReplay(game.snapshot, frames, game.moves[0]).points)), capture.points);
  assert.equal(exactReplay({ ...game.snapshot, deadDelta: null }, frames, game.moves[0]), null);
});

test('полная сетка 20×20 подтверждает итог и 200 ходов каждого цвета', async (t) => {
  const dashboard = createDashboard();
  const now = Date.now();
  const field = { width: 20, height: 20 };
  const points = { red: [], blue: [] };
  for (let i = 0; i < 399; i++) points[i % 2 ? 'blue' : 'red'].push([i % 20, Math.floor(i / 20)]);
  dashboard.record({
    session: { id: 'full', gameId: 'full', field, startedAt: now - 1000, lastActivityAt: now, endedAt: now },
    request: { ...opening, gameId: 'full', moveNo: 400, field, points },
    move: { x: 19, y: 19 }, mode: 'round', status: 200, durationMs: 10, receivedAt: now,
  });
  const game = dashboard.get('full');
  assert.equal(game.botMoveCount, 200);
  assert.equal(game.opponentMoveCount, 200);
  assert.equal(game.endReason, 'board_full');
  assert.ok(game.finalScore);
  assert.ok(['win', 'loss', 'draw'].includes(game.outcome));
  assert.equal(game.durationMs, 1000);
});

test('последние ходы восстанавливаются из старой истории без ленты', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dots-recent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyFile = join(directory, 'history.json');
  const dashboard = createDashboard({ historyFile });
  const api = await start(t, { dashboard });
  await play(api, opening);
  dashboard.flush();
  const saved = JSON.parse(await readFile(historyFile, 'utf8'));
  delete saved.recent;
  await writeFile(historyFile, JSON.stringify(saved));
  const restored = await start(t, { dashboard: createDashboard({ historyFile }) });
  const response = await restored('/api/recent-moves', { headers: auth });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map(({ sessionId, moveNo }) => [sessionId, moveNo]), [['sandbox', 2]]);
});

test('выбор архива и имя используют список панели и локальную дату', async () => {
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const code = html.match(/<script id="archive-selection">([\s\S]*?)<\/script>/)[1];
  const { archiveIds, archiveName } = runInNewContext(code + '\n({ archiveIds, archiveName })');
  const all = [{ id: 'a' }, { id: 'b' }];
  assert.equal(archiveIds('all', all, [], new Set()), null);
  assert.equal(JSON.stringify(archiveIds('filtered', all, [all[1]], new Set())), '["b"]');
  assert.equal(JSON.stringify(archiveIds('selected', all, [], new Set(['a']))), '["a"]');
  assert.equal(archiveName(new Date(2026, 10, 25, 23, 30)), 'games_2026-11-25.zip');
});
