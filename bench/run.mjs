import { chooseMove } from '../bot/index.js';

function makePosition(stoneCount, seed) {
  const width = 100;
  const height = 100;
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const cells = Array.from({ length: width * height }, (_, index) => index);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  const red = [];
  const blue = [];
  for (let i = 0; i < stoneCount; i += 1) {
    const index = cells[i];
    const point = [index % width, Math.floor(index / width)];
    (i % 2 === 0 ? red : blue).push(point);
  }

  return {
    gameId: `benchmark-${stoneCount}`,
    moveNo: stoneCount + 1,
    you: 'red',
    field: { width, height },
    points: { red, blue },
    dead: { red: [], blue: [] },
    score: { red: 0, blue: 0 },
    last: null,
    moveTimeoutMs: 5_000,
    timeLeftMs: 500_000,
  };
}

for (const stoneCount of [200, 1_000, 4_000, 8_500]) {
  const request = makePosition(stoneCount, stoneCount + 17);
  const started = performance.now();
  const move = chooseMove(request);
  const elapsed = performance.now() - started;
  const occupied = [...request.points.red, ...request.points.blue]
    .some(([x, y]) => x === move.x && y === move.y);
  console.log(`${stoneCount} stones: ${elapsed.toFixed(1)} ms; move=(${move.x}, ${move.y}); legal=${!occupied}`);
}
