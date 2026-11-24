import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePosition } from '../bot/position-analysis.js';

function analyze(ownIndices, enemyIndices, enclosedByEnemy = [], ownGroupIds) {
  const board = new Uint8Array(25);
  const groups = [ownIndices, enemyIndices].map((indices, color) => {
    const ids = new Int32Array(board.length);
    indices.forEach((index, group) => {
      ids[index] = (color === 0 ? ownGroupIds?.[group] : undefined) ?? group + 1;
      board[index] = color + 1;
    });
    const sizes = [0];
    for (const index of indices) {
      const id = ids[index];
      sizes[id] = (sizes[id] ?? 0) + 1;
    }
    return { ids, sizes };
  });
  const emptyMask = () => new Uint8Array(board.length);
  const enemy = emptyMask();
  enclosedByEnemy.forEach(index => { enemy[index] = 1; });
  return analyzePosition({
    board, width: 5, height: 5, groupsOwn: groups[0], groupsEnemy: groups[1],
    threats: { ours: emptyMask(), enemy, attacks: [], dangers: [] }, deadline: Infinity,
  });
}

test('клетка между двумя раздельными группами соединяет их в зоне контакта', () => {
  const result = analyze([11, 13], [2]);
  assert.deepEqual(result.own.cuts.get(7), { groups: [1, 2], contested: true });
  assert.equal(result.own.frontiers[1].has(12), true);
  assert.equal(result.own.frontiers[2].has(12), true);
});

test('влияние считает расстояния от обеих сторон и выделяет нейтральные клетки', () => {
  const result = analyze([10], [14]);
  assert.deepEqual(result.influence, { own: 9, enemy: 9, neutral: 5 });
  assert.equal(result.ownDistance[12], 2);
  assert.equal(result.enemyDistance[12], 2);
});

test('пустые клетки в чужом контуре исключаются из запаса безопасных ходов', () => {
  const result = analyze([10], [14], [0, 5]);
  assert.equal(result.free, 23);
  assert.equal(result.safeOwn, 21);
  assert.equal(result.safeEnemy, 23);
  assert.equal(result.phase, 'opening');
});

test('группы противника и маска его территории хранятся отдельно', () => {
  const result = analyze([10], [14], [0]);
  assert.equal(result.enemy.ids[14], 1);
  assert.equal(result.threats.enemy[0], 1);
});

test('цепочка живых точек имеет два моста и центральную точку сочленения', () => {
  const result = analyze([11, 12, 13], [2], [], [1, 1, 1]);
  assert.deepEqual(result.own.articulation, new Set([12]));
  assert.deepEqual(result.own.bridges, [[12, 13], [11, 12]]);
});

test('расстояние от группы до края считается по проходам через стену', () => {
  const open = analyze([12], [7, 11, 13]);
  const enclosed = analyze([12], [7, 11, 13, 17]);
  assert.equal(open.ownExitDistance[1], 2);
  assert.equal(enclosed.ownExitDistance[1], Infinity);
});

test('вилка оставляет хотя бы один захват после любого допустимого ответа', async () => {
  const { applyMove } = await import('../bot/index.js');
  const { proveForkGain, unavoidableForkLoss } = await import('../bot/fork-defense.js');
  for (const offset of [0, 1, 2]) {
    const width = 9;
    const height = 5;
    const index = (x, y) => y * width + x + offset;
    const board = new Uint8Array(width * height);
    for (const [x, y] of [[2, 1], [2, 3], [4, 1], [4, 3], [3, 2]]) board[index(x, y)] = 2;
    for (const [x, y] of [[2, 2], [4, 2]]) board[index(x, y)] = 1;
    const simulate = (position, at, color) => applyMove(position, at, width, height, color, 3 - color, undefined, 1).board;
    const closures = [index(1, 2), index(5, 2)];
    assert.equal(unavoidableForkLoss(board, closures, simulate, Infinity), 1);
    assert.equal(unavoidableForkLoss(board, closures, simulate, -Infinity), null);
    for (const [block, capture] of [closures, [...closures].reverse()]) {
      const defended = simulate(board, block, 1);
      const after = simulate(defended, capture, 2);
      assert.equal(after.filter(cell => cell === 3).length, 1);
    }
    const withCounter = board.slice();
    withCounter[index(3, 1)] = 1;
    assert.equal(simulate(withCounter, index(3, 3), 1)[index(3, 2)], 4);
    assert.equal(unavoidableForkLoss(withCounter, closures, simulate, Infinity), 0);
    const attacking = board.map(color => color === 0 ? 0 : 3 - color);
    const redAttacks = simulate(attacking, closures[0], 1);
    assert.equal(redAttacks[index(2, 2)], 4);
    assert.equal(proveForkGain(attacking, 1, closures, simulate, Infinity), 1);
  }
});

test('решатель эндшпиля совпадает с полным минимаксом без отсечений', async () => {
  const { solveEndgame } = await import('../bot/endgame.js');
  const { applyMove } = await import('../bot/index.js');
  function minimax(board, side, simulate) {
    const free = Array.from(board.keys()).filter(index => board[index] === 0);
    if (!free.length) {
      return board.filter(cell => cell === 4).length - board.filter(cell => cell === 3).length;
    }
    const values = free.map(index => minimax(simulate(board, index, side), 3 - side, simulate));
    return side === 1 ? Math.max(...values) : Math.min(...values);
  }
  for (const width of [3, 4, 5]) {
    const height = width;
    const simulate = (board, index, color) =>
      applyMove(board, index, width, height, color, 3 - color, undefined, 1).board;
    let board = new Uint8Array(width * height);
    for (let i = 0; i < board.length - 5; i++) {
      board = simulate(board, (i * (width + 1)) % board.length, i % 2 + 1);
    }
    const solution = solveEndgame(board, simulate, Infinity);
    assert.equal(solution.solved, true);
    assert.equal(solution.value, minimax(board, 1, simulate));
    assert.equal(minimax(simulate(board, solution.move, 1), 2, simulate), solution.value);
    assert.equal(solveEndgame(board, simulate, -Infinity), null);
  }
});
