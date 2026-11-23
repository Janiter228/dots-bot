import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMove } from '../server/compute-move.js';

const position = { gameId: 'new-game', moveNo: 1, you: 'red',
  field: { width: 10, height: 10 }, points: { red: [], blue: [] },
  dead: { red: [], blue: [] }, last: null, moveTimeoutMs: 5000, timeLeftMs: 900000 };

test('отмена предыдущей партии завершает расчёт и не мешает новой', async () => {
  const old = new AbortController();
  const calculation = computeMove(position, old.signal);
  const rejected = assert.rejects(calculation, /старая партия/);
  old.abort(new Error('старая партия'));
  await rejected;
  const next = await computeMove({ ...position, gameId: 'next-game' }, new AbortController().signal);
  assert.deepEqual(next, { x: 5, y: 5 });
});

test('заранее отменённый запрос не запускает расчёт', async () => {
  const controller = new AbortController();
  controller.abort(new Error('отмена'));
  await assert.rejects(computeMove(position, controller.signal), /отмена/);
});

test('независимые партии получают собственные ответы', async () => {
  const moves = await Promise.all([10, 20].map(n => computeMove({ ...position,
    gameId: `game-${n}`, field: { width: n, height: n } }, new AbortController().signal)));
  assert.deepEqual(moves, [{ x: 5, y: 5 }, { x: 10, y: 10 }]);
});
