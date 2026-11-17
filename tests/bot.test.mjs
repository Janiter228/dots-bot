import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMove } from '../bot/index.js';

function game({ width = 5, height = 5, you = 'red', red = [], blue = [], dead = { red: [], blue: [] } }) {
  return {
    gameId: 'bot-test',
    moveNo: red.length + blue.length + 1,
    you,
    field: { width, height },
    points: { red, blue },
    dead,
    score: { red: 0, blue: 0 },
    last: null,
    moveTimeoutMs: 5000,
    timeLeftMs: 900000,
  };
}

test('на пустом поле бот начинает из центра', () => {
  const move = chooseMove(game({ width: 10, height: 10 }));
  assert.deepEqual(move, { x: 5, y: 5 });
});

test('бот выбирает немедленный захват вражеской точки', () => {
  const red = [
    [1, 1], [3, 1],
    [1, 2], [3, 2],
    [1, 3], [2, 3], [3, 3],
  ];
  const move = chooseMove(game({ red, blue: [[2, 2]] }));
  assert.deepEqual(move, { x: 2, y: 1 });
});

test('бот блокирует немедленный захват своей точки', () => {
  const blue = [
    [0, 0], [2, 0],
    [0, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ];
  const move = chooseMove(game({ width: 3, height: 3, you: 'red', red: [[1, 1]], blue }));
  assert.deepEqual(move, { x: 1, y: 0 });
});

test('бот не ставит точку в уже окружённую область противника', () => {
  const blue = [
    [1, 1], [2, 1], [3, 1],
    [1, 2],          [3, 2],
    [1, 3], [2, 3], [3, 3],
  ];
  const move = chooseMove(game({ you: 'red', blue }));
  assert.notDeepEqual(move, { x: 2, y: 2 });
});

test('бот учитывает мёртвые точки как занятые, но не как живые стены', () => {
  const red = [[1, 1], [2, 1]];
  const dead = { red: [[1, 1]], blue: [] };
  const move = chooseMove(game({ red, dead }));
  assert.ok(move);
  assert.notDeepEqual(move, { x: 1, y: 1 });
  assert.notDeepEqual(move, { x: 2, y: 1 });
});

test('бот на почти заполненном поле возвращает последнюю свободную клетку', () => {
  const move = chooseMove(game({
    width: 2,
    height: 2,
    red: [[0, 0], [1, 0]],
    blue: [[0, 1]],
  }));
  assert.deepEqual(move, { x: 1, y: 1 });
});
