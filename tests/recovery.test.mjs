import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotServer } from '../server/index.js';

const IDLE_MS = 10 * 1000;

async function setup(t) {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const server = createBotServer({ botToken: '', dashboardToken: '', serveDashboard: false });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return {
    advance(ms) { now += ms; },
    async move(gameId, blue = []) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, moveNo: 1, you: 'red',
          field: { width: 3, height: 3 }, points: { red: [], blue }, last: null,
          moveTimeoutMs: 5000 }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('после паузы изменённая позиция с тем же номером хода рассчитывается заново', async (t) => {
  const client = await setup(t);
  const first = await client.move('reload');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { x: 1, y: 1 });
  client.advance(IDLE_MS);
  const resumed = await client.move('reload', [[1, 1]]);
  assert.equal(resumed.status, 200);
  assert.notDeepEqual(resumed.body, first.body);
  assert.ok(resumed.body.x >= 0 && resumed.body.x < 3 && resumed.body.y >= 0 && resumed.body.y < 3);
  assert.deepEqual(await client.move('reload', [[1, 1]]), resumed);
});

test('точный повтор после паузы использует кэш, изменённая позиция пересчитывается', async (t) => {
  const client = await setup(t);
  const first = await client.move('active');
  client.advance(IDLE_MS - 1);
  assert.deepEqual(await client.move('active'), first);
  client.advance(IDLE_MS - 1);
  const changed = await client.move('active', [[first.body.x, first.body.y]]);
  assert.equal(changed.status, 200);
  assert.notDeepEqual(changed.body, first.body);
});

test('новая позиция одной партии не сбрасывает кэш другой', async (t) => {
  const client = await setup(t);
  const idle = await client.move('idle');
  const active = await client.move('active');
  client.advance(IDLE_MS - 1);
  assert.deepEqual(await client.move('active'), active);
  client.advance(1);
  const resumed = await client.move('idle', [[idle.body.x, idle.body.y]]);
  assert.equal(resumed.status, 200);
  assert.notDeepEqual(resumed.body, idle.body);
  assert.deepEqual(await client.move('active'), active);
  const changed = await client.move('active', [[active.body.x, active.body.y]]);
  assert.equal(changed.status, 200);
  assert.notDeepEqual(changed.body, active.body);
});
