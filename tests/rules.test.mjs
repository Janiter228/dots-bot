import test from 'node:test';
import assert from 'node:assert/strict';
import { loadArena } from './support/arena.mjs';

const enabled = Boolean(process.env.DOTS_ENGINE);
test('эталон арены: ромб захватывает центральную точку', {
  skip: !enabled && 'Нужен DOTS_ENGINE с эталонным dots.mjs',
}, async () => {
  const { DotsGame, RED, BLUE } = await loadArena();
  const game = new DotsGame(7, 7);
  const moves = [[3, 2, RED], [3, 3, BLUE], [2, 3, RED], [0, 0, BLUE],
    [4, 3, RED], [6, 6, BLUE], [3, 4, RED]];
  for (const [x, y, color] of moves) assert.equal(game.play(x, y, color).ok, true);
  assert.equal(game.score.red, 1);
  assert.equal(game.score.blue, 0);
  assert.ok(game.snapshot().dead.blue.some(([x, y]) => x === 3 && y === 3));
});

test('эталон арены: занятая клетка отклоняется без изменения позиции', {
  skip: !enabled && 'Нужен DOTS_ENGINE с эталонным dots.mjs',
}, async () => {
  const { DotsGame, RED, BLUE } = await loadArena();
  const game = new DotsGame(7, 7);
  assert.equal(game.play(3, 3, RED).ok, true);
  const before = structuredClone(game.snapshot());
  assert.equal(game.play(3, 3, BLUE).ok, false);
  assert.deepEqual(game.snapshot(), before);
});
