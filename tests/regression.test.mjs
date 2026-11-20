import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMove } from '../bot/index.js';

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

test('регрессия: безграничный режим избегает центра чужого ромба', { todo: 'Известный дефект v0.3.2: оценка соседства без проверки территории' }, () => {
  const input = request(5, 5, { red: [], blue: [[0, -1], [-1, 0], [1, 0], [0, 1]] });
  input.field = { infinite: true };
  assert.notDeepEqual(chooseMove(input), { x: 0, y: 0 });
});
