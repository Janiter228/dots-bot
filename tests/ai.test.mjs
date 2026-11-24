import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePosition, selectLegalMove, PLANE_NAMES } from '../ai/position.js';
import { createModelStrategy } from '../ai/strategy.js';
import { chooseMove } from '../bot/index.js';

const position = () => ({
  gameId: 'not-model-input', you: 'blue', moveNo: 4,
  field: { width: 3, height: 2 },
  points: { red: [[0, 0], [2, 1]], blue: [[1, 0]] },
  dead: { red: [[2, 1]], blue: [] }, last: [2, 1],
});

test('модель получает прямоугольное поле от своего цвета и маску занятых клеток', () => {
  const request = position();
  const before = structuredClone(request);
  const input = encodePosition(request);
  assert.deepEqual(PLANE_NAMES, ['own', 'opponent', 'ownDead', 'opponentDead', 'last']);
  assert.deepEqual(Array.from(input.planes), [
    0, 1, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1,
  ]);
  assert.deepEqual(Array.from(input.legalMask), [0, 0, 1, 1, 1, 0]);
  assert.equal(input.gameId, undefined);
  assert.deepEqual(request, before);
  const swapped = encodePosition({ ...request, you: 'red' });
  assert.deepEqual(swapped.planes.slice(0, 6), input.planes.slice(6, 12));
  assert.deepEqual(swapped.legalMask, input.legalMask);
});

test('маска исключает занятые клетки, NaN и Infinity; действие переводится в x,y', () => {
  const input = encodePosition(position());
  assert.deepEqual(selectLegalMove([100, 100, NaN, 3, 4, 100], input), { x: 1, y: 1 });
  assert.deepEqual(selectLegalMove([100, 100, 4, 4, 0, 100], input), { x: 2, y: 0 });
  assert.equal(selectLegalMove(new Float32Array(6).fill(Infinity), input), null);
  assert.throws(() => selectLegalMove([1], input), /Число оценок/);
});

test('отсутствие модели сохраняет выбор текущего алгоритма', async () => {
  const request = { ...position(), points: { red: [], blue: [] }, dead: {}, last: null };
  assert.deepEqual(await createModelStrategy()(request), chooseMove(request));
});

test('ошибка, неверная форма и непригодные оценки модели возвращают запасной алгоритм', async () => {
  for (const predict of [() => { throw new Error('ошибка'); }, async () => [0],
    () => new Float32Array(6).fill(NaN)]) {
    let calls = 0;
    const request = position();
    const strategy = createModelStrategy({ predict, fallback: (received) => {
      assert.equal(received, request);
      calls += 1;
      return { x: 0, y: 1 };
    } });
    assert.deepEqual(await strategy(request), { x: 0, y: 1 });
    assert.equal(calls, 1);
  }
});

test('асинхронная модель не получает секреты и не может снять запрет занятой клетки', async () => {
  const request = { ...position(), authorization: 'private-header', token: 'private-token' };
  const strategy = createModelStrategy({ predict: async (input) => {
    assert.deepEqual(Object.keys(input).sort(), ['height', 'legalMask', 'planes', 'version', 'width']);
    input.legalMask.fill(1);
    return [100, 100, 0, 1, 2, 100];
  } });
  assert.deepEqual(await strategy(request), { x: 1, y: 1 });
});

test('полное поле не запускает модель, неподдерживаемое поле использует fallback', async () => {
  const full = { you: 'red', field: { width: 1, height: 1 }, points: { red: [[0, 0]], blue: [] } };
  const strategy = createModelStrategy({ predict: () => assert.fail('Модель не нужна'),
    fallback: () => ({ x: 7, y: 8 }) });
  assert.equal(await strategy(full), null);
  assert.deepEqual(await strategy({ ...full, field: { infinite: true } }), { x: 7, y: 8 });
  assert.throws(() => encodePosition({ ...full, points: { red: [[-1, 0]], blue: [] } }), /Координата/);
});
