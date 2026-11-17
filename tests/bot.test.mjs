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

test('бот с цветом blue также находит немедленный захват', () => {
  const blue = [
    [1, 1], [3, 1],
    [1, 2], [3, 2],
    [1, 3], [2, 3], [3, 3],
  ];
  const move = chooseMove(game({ you: 'blue', red: [[2, 2]], blue }));
  assert.deepEqual(move, { x: 2, y: 1 });
});

test('бот выбирает только свободную клетку на большом поле 100x100', () => {
  const red = [];
  const blue = [];
  for (let i = 0; i < 450; i += 1) {
    const index = (i * 37 + 11) % 10_000;
    const x = index % 100;
    const y = Math.floor(index / 100);
    (i % 2 === 0 ? red : blue).push([x, y]);
  }
  const request = game({ width: 100, height: 100, red, blue });
  const move = chooseMove(request);
  assert.ok(move);
  assert.ok(move.x >= 0 && move.x < 100);
  assert.ok(move.y >= 0 && move.y < 100);
  const key = `${move.x},${move.y}`;
  const occupied = [...red, ...blue].some(([x, y]) => `${x},${y}` === key);
  assert.equal(occupied, false);
});

test('бот работает, когда на поле осталось мало свободных клеток', () => {
  const width = 6;
  const height = 6;
  const red = [];
  const blue = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x === 2 && y === 2) || (x === 4 && y === 4)) continue;
      (x + y) % 2 === 0 ? red.push([x, y]) : blue.push([x, y]);
    }
  }
  const move = chooseMove(game({ width, height, red, blue }));
  assert.ok([[2, 2], [4, 4]].some(([x, y]) => move.x === x && move.y === y));
});


test('бот избегает пустых клеток внутри собственной закрытой территории', () => {
  // Красные точки образуют замкнутую рамку. Центр принадлежит нашей
  // территории: ставить туда свою точку невыгодно.
  const red = [
    [1, 1], [2, 1], [3, 1],
    [1, 2],          [3, 2],
    [1, 3], [2, 3], [3, 3],
  ];
  const move = chooseMove(game({ width: 5, height: 5, you: 'red', red }));
  assert.notDeepEqual(move, { x: 2, y: 2 });
});

test('бот за blue также избегает территории, замкнутой его цветом', () => {
  const blue = [
    [1, 1], [2, 1], [3, 1],
    [1, 2],          [3, 2],
    [1, 3], [2, 3], [3, 3],
  ];
  const move = chooseMove(game({ width: 5, height: 5, you: 'blue', blue }));
  assert.notDeepEqual(move, { x: 2, y: 2 });
});

test('если все свободные клетки находятся в закрытой зоне, бот всё равно делает допустимый ход', () => {
  const red = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (x !== 1 || y !== 1) red.push([x, y]);
    }
  }
  const move = chooseMove(game({ width: 3, height: 3, you: 'red', red }));
  assert.deepEqual(move, { x: 1, y: 1 });
});
