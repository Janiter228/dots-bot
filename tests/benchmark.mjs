import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArena, seededRandom } from './support/arena.mjs';

const { DotsGame, RED, BLUE } = await loadArena();
const { chooseMove } = process.env.DOTS_PLAYER
  ? await import(pathToFileURL(resolve(process.env.DOTS_PLAYER)))
  : await import('../bot/index.js');
const size = 100;

function makePosition(density, seed) {
  const arena = new DotsGame(size, size);
  const indices = Array.from({ length: size * size }, (_, index) => index);
  const random = seededRandom(seed);
  for (let i = 0; i < density * indices.length; i++) {
    const next = i + Math.floor(random() * (indices.length - i));
    [indices[i], indices[next]] = [indices[next], indices[i]];
    arena.owner[indices[i]] = i % 2 ? BLUE : RED;
    arena.order.push(indices[i]);
  }
  arena._settle();
  return arena;
}

for (const density of [0.01, 0.1, 0.4, 0.8]) {
  const times = [];
  for (let seed = 1; seed <= 6; seed++) {
    const arena = makePosition(density, seed);
    const request = {
      ...arena.snapshot(), you: 'red', gameId: 'benchmark', moveNo: arena.order.length + 1,
      moveTimeoutMs: 5_000, timeLeftMs: 900_000,
    };
    const start = performance.now();
    const move = chooseMove(request);
    const elapsed = performance.now() - start;
    assert.ok(arena.isFree(move?.x, move?.y), 'Бот должен вернуть свободную клетку');
    if (seed !== 1) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ size, density, samples: times.length, medianMs: times[2], maxMs: times.at(-1) }));
}
