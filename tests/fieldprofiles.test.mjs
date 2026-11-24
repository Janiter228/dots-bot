import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { chooseMove } from '../bot/index.js';
import { fieldProfile, infiniteFallback } from '../bot/field-profile.js';
import { createBotServer } from '../server/index.js';

function request(field, points = { red: [], blue: [] }, moveTimeoutMs = 5000) {
  return {
    gameId: 'field-profiles', moveNo: points.red.length + points.blue.length + 1,
    you: 'red', field, points, dead: { red: [], blue: [] }, last: null,
    moveTimeoutMs, timeLeftMs: 0,
  };
}

test('профиль учитывает размер, запас клеток и отладочное переопределение', () => {
  assert.equal(fieldProfile({ width: 8, height: 8 }), 'tiny');
  assert.equal(fieldProfile({ width: 20, height: 20 }), 'small');
  assert.equal(fieldProfile({ width: 100, height: 100 }), 'standard');
  assert.equal(fieldProfile({ width: 100, height: 100 }, 60), 'tiny');
  assert.equal(fieldProfile({ width: 100, height: 100 }, 100, 'small'), 'small');
  assert.equal(fieldProfile({ infinite: true }, Infinity, 'small'), 'infinite');
  assert.deepEqual(chooseMove(request({ width: 20, height: 20 })), { x: 10, y: 10 });
});

test('безграничное поле выбирает начало координат и избегает занятой верхней строки', () => {
  assert.deepEqual(chooseMove(request({ infinite: true })), { x: 0, y: 0 });
  const points = { red: [[0, -5], [1, -5]], blue: [[-1, -4]] };
  const move = infiniteFallback(points);
  assert.deepEqual(move, { x: 2, y: -5 });
  const extreme = { red: [[Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]], blue: [] };
  const chosen = chooseMove(request({ infinite: true }, extreme));
  assert.ok(Number.isSafeInteger(chosen.x) && Number.isSafeInteger(chosen.y));
  assert.notDeepEqual([chosen.x, chosen.y], extreme.red[0]);
});

test('HTTP принимает отрицательные координаты без размеров поля и сохраняет корректный запасной ход', async t => {
  const recorded = [];
  const server = createBotServer({ botToken: '', dashboardToken: '', gameLogs: {
    record(event) { recorded.push(event); },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });

  const url = `http://127.0.0.1:${server.address().port}/v1/move`;
  const post = body => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const opening = await post(request({ infinite: true }));
  assert.equal(opening.status, 200);
  assert.deepEqual(await opening.json(), { x: 0, y: 0 });

  const points = { red: [[0, -5], [1, -5]], blue: [[-1, -4]] };
  const input = { ...request({ infinite: true }, points, 1), last: [-1, -4] };
  const fallback = await post(input);
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { x: 2, y: -5 });
  const retry = await post(input);
  assert.deepEqual(await retry.json(), { x: 2, y: -5 });

  const invalid = await post({ ...input, last: [-1, 0.5] });
  assert.equal(invalid.status, 400);
  await invalid.json();
  const finite = await post({ ...input, field: { width: 8, height: 8 } });
  assert.equal(finite.status, 400);
  await finite.json();
  assert.ok(recorded.some(event => event.status === 200 && event.move?.y === -5));
  assert.ok(recorded.every(event => event.request === undefined));
});
