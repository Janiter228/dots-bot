import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, chooseMove } from '../bot/index.js';
import { DotsGame } from './support/arena-reference.mjs';

function request(width, height, points, you = 'red') {
  return { gameId: 'regression', moveNo: points.red.length + points.blue.length + 1,
    you, field: { width, height }, points, dead: { red: [], blue: [] },
    score: { red: 0, blue: 0 }, last: null, moveTimeoutMs: 50, timeLeftMs: 900000 };
}

test('прямоугольные поля, оба цвета и плотности: допустимость и неизменность входа', () => {
  for (const [width, height] of [[1, 1], [1, 9], [9, 1], [3, 7], [11, 4]]) {
    for (const density of [0, 0.4, 0.9]) {
      const points = { red: [], blue: [] };
      const count = Math.min(width * height - 1, Math.floor(width * height * density));
      for (let i = 0; i < count; i++) points[i % 2 ? 'blue' : 'red'].push([i % width, Math.floor(i / width)]);
      for (const color of ['red', 'blue']) {
        const input = request(width, height, points, color);
        const original = structuredClone(input);
        const move = chooseMove(input);
        assert.ok(Number.isInteger(move?.x) && Number.isInteger(move?.y));
        assert.ok(move.x >= 0 && move.x < width && move.y >= 0 && move.y < height);
        assert.ok(![...points.red, ...points.blue].some(([x, y]) => x === move.x && y === move.y));
        assert.deepEqual(input, original);
      }
    }
  }
});

test('полностью заполненное поле возвращает null', () => {
  assert.equal(chooseMove(request(2, 1, { red: [[0, 0]], blue: [[1, 0]] })), null);
});

test('безграничный режим избегает центра собственного и чужого ромба', () => {
  for (const you of ['red', 'blue']) {
    const input = request(5, 5, { red: [], blue: [[0, -1], [-1, 0], [1, 0], [0, 1]] }, you);
    input.field = { infinite: true };
    for (const timeLeftMs of [0, 900000]) {
      const move = chooseMove({ ...input, timeLeftMs });
      assert.ok(Number.isSafeInteger(move?.x) && Number.isSafeInteger(move?.y));
      assert.notDeepEqual(move, { x: 0, y: 0 });
      assert.ok(!input.points.blue.some(([x, y]) => x === move.x && y === move.y));
    }
  }
});

test('мёртвая точка не закрывает ромб на безграничном поле', () => {
  const input = request(5, 5, { red: [], blue: [[0, -1], [-1, 0], [1, 0], [0, 1]] });
  input.field = { infinite: true };
  input.dead.blue = [[0, 1]];
  assert.deepEqual(chooseMove(input), { x: 0, y: 0 });
});

test('запасной ход при исчерпанном таймере не попадает в чужой контур', () => {
  const input = request(5, 5, { red: [], blue: [[2, 1], [1, 2], [3, 2], [2, 3]] });
  assert.deepEqual(chooseMove({ ...input, timeLeftMs: 0 }), { x: 2, y: 0 });
});

test('синие блокируют красных вместо захвата, на который возможен контрзахват изнутри', () => {
  const red = [[3, 0], [4, 0], [1, 1], [4, 1], [3, 2], [0, 3], [1, 3], [2, 3], [3, 4], [4, 4]];
  const blue = [[0, 0], [1, 0], [2, 0], [0, 1], [3, 1], [2, 2], [4, 3], [0, 4], [2, 4]];
  const input = request(5, 5, { red, blue }, 'blue');
  // Ход синих (1, 2) замыкает контур вокруг (1, 1) и (2, 1).
  // Красные могут сыграть в (2, 1) и разрушить этот контур первыми.
  assert.deepEqual(chooseMove({ ...input, moveTimeoutMs: 5000 }), { x: 2, y: 1 });
});

test('вложенный захват ломает синий контур и оживляет центральную красную точку', () => {
  const blue = [[4, 3], [3, 4], [5, 4], [4, 5]];
  const red = [[3, 2], [5, 2], [2, 3], [6, 3], [1, 4], [7, 4],
    [2, 5], [6, 5], [3, 6], [5, 6], [4, 7]];
  const index = (x, y) => y * 9 + x;
  for (const redCode of [1, 2]) {
    const blueCode = 3 - redCode;
    const board = new Uint8Array(81);
    for (const point of red) board[index(...point)] = redCode;
    for (const point of blue) board[index(...point)] = blueCode;
    board[index(4, 4)] = redCode + 2;
    const result = applyMove(board, index(4, 1), 9, 9, redCode, blueCode, undefined, redCode);
    assert.equal(result.captured, 4);
    assert.equal(result.board[index(4, 4)], redCode);
    for (const point of blue) assert.equal(result.board[index(...point)], blueCode + 2);
  }
});

test('sandbox#40, ход 55: красные закрывают угрозу и сохраняют вилку', (t) => {
  const prefix = [
    [10, 10], [10, 9], [9, 9], [9, 10], [10, 8], [11, 9], [9, 11], [8, 10], [11, 7],
    [11, 8], [8, 9], [9, 8], [10, 7], [11, 10], [10, 11], [8, 11], [8, 12], [9, 12],
    [9, 13], [10, 12], [11, 11], [10, 13], [10, 14], [8, 13], [9, 14], [7, 12], [8, 15],
    [8, 14], [7, 14], [7, 13], [6, 13], [11, 12], [12, 11], [11, 13], [11, 15], [11, 14],
    [12, 14], [12, 13], [6, 12], [12, 12], [13, 10], [12, 10], [13, 11], [12, 9], [13, 9],
    [12, 8], [6, 11], [7, 11], [14, 12], [13, 12], [13, 7], [7, 10], [14, 8], [9, 15],
  ];
  const arena = DotsGame.fromMoves(20, 20, prefix);
  // Очередь процессов в параллельном прогоне не должна менять тактический результат.
  const clock = t.mock.method(performance, 'now', () => 0);
  const move = chooseMove({ ...arena.snapshot(), you: 'red', moveTimeoutMs: 5000, timeLeftMs: 900_000 });
  clock.mock.restore();
  assert.deepEqual(move, { x: 10, y: 15 });

  const trade = arena.clone();
  trade.play(12, 6);
  trade.play(10, 15);
  assert.deepEqual(trade.score, { red: 7, blue: 4 });

  arena.play(move.x, move.y);
  for (const reply of arena.freeCells()) {
    const after = arena.clone();
    after.play(...reply);
    assert.equal(after.score.blue, 1);
    const preservesCapture = [[12, 6], [12, 7]].some(closure => {
      if (!after.isFree(...closure)) return false;
      const captured = after.clone();
      captured.play(...closure);
      return captured.score.red >= 7;
    });
    assert.ok(preservesCapture, `Ответ синих: ${reply}`);
  }
});
