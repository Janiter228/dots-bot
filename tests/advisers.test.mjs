import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DotsGame } from './support/arena-reference.mjs';
import { chooseMove } from '../bot/index.js';
import { adviser } from '../ai/local-advisers.js';
import { loadAdvice } from '../ai/hybrid.js';
import { requestBudget, responseLimit } from '../bot/time-budget.js';

const crisis = JSON.parse(readFileSync(new URL('./fixtures/hardware-245.json', import.meta.url)));
test('Hardware, ход 245: все режимы достигают лучшей возможной разницы после ответа', () => {
  const arena = new DotsGame(20, 20);
  for (const [name, code] of [['red', 1], ['blue', 2]]) {
    for (const [x, y] of crisis.points[name]) arena.owner[arena.idx(x, y)] = code;
    for (const [x, y] of crisis.dead[name]) arena.dead[arena.idx(x, y)] = 1;
  }
  function worstReply(x, y) {
    const next = arena.clone();
    assert.ok(next.play(x, y, 1).ok);
    let worst = Infinity;
    for (const cell of next.freeCells()) {
      const reply = next.clone();
      reply.play(...cell, 2);
      worst = Math.min(worst, reply.scoreOf(1) - reply.scoreOf(2));
    }
    return worst;
  }
  const best = Math.max(...arena.freeCells().map(([x, y]) => worstReply(x, y)));
  assert.equal(best, -69);
  for (const mode of ['autonomous', 'strategist', 'critic', 'hybrid']) {
    const advice = loadAdvice(mode);
    assert.equal(typeof advice, mode === 'autonomous' ? 'undefined' : 'function');
    const move = chooseMove(crisis, { advice });
    assert.equal(worstReply(move.x, move.y), best);
  }
});
test('ошибка одного советника сохраняет второй, отсутствие обоих сохраняет поиск', () => {
  const model = { policy: [0, 0, 0, 0, 0, 0], risk: [NaN] };
  assert.equal(adviser(model, 'hybrid')([0], 0, 1, 1), 6);
  assert.equal(adviser({}, 'hybrid'), undefined);
  assert.equal(adviser(model, 'critic'), undefined);
});
test('лимит на запрос учитывает настройки, арену и часы партии', () => {
  for (const limit of [1000, 2000, 3000]) assert.equal(requestBudget({}, responseLimit(limit)), limit);
  assert.equal(requestBudget({ moveTimeoutMs: 600, timeLeftMs: 450 }, 1000), 450);
  for (const bad of ['', -1, '1.5', 'abc', Infinity]) assert.throws(() => responseLimit(bad));
});

test('медленная передача тела запроса получает 408 в общем бюджете', async t => {
  const { request } = await import('node:http');
  const { once } = await import('node:events');
  const { createBotServer } = await import('../server/index.js');
  const previous = process.env.MAX_RESPONSE_TIME_MS;
  process.env.MAX_RESPONSE_TIME_MS = '100';
  t.after(() => {
    if (previous === undefined) delete process.env.MAX_RESPONSE_TIME_MS;
    else process.env.MAX_RESPONSE_TIME_MS = previous;
  });
  const server = createBotServer({ botToken: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/move',
    method: 'POST', headers: { 'Content-Type': 'application/json' } });
  t.after(() => client.destroy());
  const response = once(client, 'response');
  client.write('{');
  const [res] = await response;
  assert.equal(res.statusCode, 408);
  res.resume();
  client.end();
});
