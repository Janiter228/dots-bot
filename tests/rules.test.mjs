import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyMove } from '../bot/index.js';
import { loadArena } from './support/arena.mjs';
import { closingMove, nestedBoard, nestedPosition } from './support/nested-capture.mjs';

const enabled = Boolean(process.env.DOTS_ENGINE);
const webScript = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function runWeb(check) {
  const elements = new Map();
  const noop = () => {};
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '10', style: {}, dataset: {}, children: [], append: noop, prepend: noop,
      clientWidth: 320, clientHeight: 320, replaceChildren: noop, scrollTo: noop,
      setAttribute: noop, querySelectorAll: () => [],
      getContext: () => new Proxy({}, { get: () => noop }),
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      requestSubmit: noop,
      addEventListener(event, handler) { this[event] = handler; },
    });
    return elements.get(id);
  };
  return runInNewContext(`${webScript}\n${check}`, {
    document: { getElementById, createElement: () => ({ dataset: {}, append: noop }) },
    requestAnimationFrame: noop,
    matchMedia: () => ({ matches: true }),
    ResizeObserver: class { observe() {} },
    console: { groupCollapsed: noop, groupEnd: noop, log: noop }, performance,
    nestedBoard, closingMove,
  });
}

test('ход с вложенным захватом оживляет центральную точку в поиске и в браузере', async () => {
  const { owners, live } = nestedBoard();
  const index = closingMove[1] * 9 + closingMove[0];
  const expected = owners.slice();
  expected[index] = 1;
  for (const [x, y] of nestedPosition.points.blue) expected[y * 9 + x] = 0;

  for (const redCode of [1, 2]) {
    const encode = (owner) => owner === 1 ? redCode : 3 - redCode;
    const board = owners.map((owner, i) => owner ? encode(owner) + (live[i] ? 0 : 2) : 0);
    const result = applyMove(board, index, 9, 9, redCode, 3 - redCode, undefined, redCode);
    assert.deepEqual(result.board, owners.map((owner, i) => i === index ? redCode :
      owner ? encode(owner) + (expected[i] ? 0 : 2) : 0));
    assert.equal(result.captured, 4);
    assert.equal(result.selfCaptured, false);
  }

  const web = runWeb(`
    const { owners, live } = nestedBoard();
    const [x, y] = closingMove;
    const index = y * 9 + x;
    owners[index] = 1;
    const settled = resolveCaptures(owners, 9, live, index);
    ({ live: settled, score: score({ owners, live: settled }) });
  `);
  assert.deepEqual(Array.from(web.live), Array.from(expected));
  assert.deepEqual({ ...web.score }, { red: 4, blue: 0 });

  if (enabled) {
    const { DotsGame, RED, BLUE } = await loadArena();
    const arena = new DotsGame(9, 9);
    arena.play(4, 4, RED);
    for (const point of nestedPosition.points.blue) arena.play(...point, BLUE);
    for (const point of nestedPosition.points.red.slice(1)) arena.play(...point, RED);
    assert.deepEqual(arena.snapshot().dead, nestedPosition.dead);
    assert.equal(arena.play(...closingMove, RED).ok, true);
    assert.deepEqual(arena.owner.map((owner, i) => arena.dead[i] ? 0 : owner), expected);
    assert.deepEqual(arena.score, { ...web.score });
  }
});

test('веб-игра показывает итог и блокирует ходы после заполнения поля', () => {
  const result = runWeb(`
    startGame({ n: 2, mode: 'local' });
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      canvas.click({ clientX: x * cell, clientY: y * cell });
    }
    const status = $('status').textContent;
    canvas.click({ clientX: cell, clientY: cell });
    ({ status, ended: state.ended, moveNo: state.moveNo, retryHidden: $('retry').hidden });
  `);
  assert.equal(result.status, 'Поле заполнено · ничья · 0:0');
  assert.equal(result.ended, true);
  assert.equal(result.moveNo, 5);
  assert.equal(result.retryHidden, true);
});

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
