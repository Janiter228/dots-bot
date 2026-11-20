import assert from 'node:assert/strict';
import { chooseMove } from '../bot/index.js';
import { loadArena, seededRandom } from './support/arena.mjs';

const { DotsGame, RED, BLUE, NAME } = await loadArena();
const sizes = (process.env.DOTS_SIZES || '10,20').split(',').map(Number);
const seeds = (process.env.DOTS_SEEDS || '1,17,42').split(',').map(Number);
assert.ok(sizes.every(n => Number.isInteger(n) && n > 0 && n <= 100));
assert.ok(seeds.every(Number.isSafeInteger));
const report = [];
for (const size of sizes) {
  for (const seed of seeds) {
    for (const botColor of [RED, BLUE]) {
      const game = new DotsGame(size, size);
      const random = seededRandom(seed);
      const times = [];
      const errors = [];
      const replay = [];
      while (!game.full && replay.length < size * size) {
        const color = game.turn;
        let move;
        if (color === botColor) {
          const snap = game.snapshot();
          const input = { ...snap, gameId: `size-${size}-seed-${seed}-bot-${NAME[color]}`,
            moveNo: replay.length + 1, you: NAME[color], moveTimeoutMs: 5000, timeLeftMs: 900000 };
          const started = performance.now();
          try { move = chooseMove(input); }
          catch (error) { errors.push({ ply: replay.length + 1, reason: error.message }); break; }
          const elapsed = performance.now() - started;
          times.push(elapsed);
          if (elapsed > 5000) { errors.push({ ply: replay.length + 1, reason: 'timeout', elapsed }); break; }
        } else {
          const snap = game.snapshot();
          const occupied = new Set([...snap.points.red, ...snap.points.blue].map(p => p.join(',')));
          const free = [];
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) if (!occupied.has(`${x},${y}`)) free.push({ x, y });
          }
          move = free[Math.floor(random() * free.length)];
        }
        if (!Number.isInteger(move?.x) || !Number.isInteger(move?.y)) {
          errors.push({ ply: replay.length + 1, reason: 'invalid coordinates', move }); break;
        }
        const result = game.play(move.x, move.y, color);
        replay.push({ color: NAME[color], ...move });
        if (!result.ok) { errors.push({ ply: replay.length, reason: result.reason }); break; }
      }
      times.sort((a, b) => a - b);
      const row = { size, seed, botColor: NAME[botColor], opponent: 'seeded-random',
        score: game.score, moves: replay.length, finished: game.full,
        meanMs: times.reduce((a, b) => a + b, 0) / (times.length || 1),
        p95Ms: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? 0,
        maxMs: times.at(-1) ?? 0, errors, replay };
      report.push(row);
      console.error(JSON.stringify({ ...row, replay: undefined }));
    }
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.some(row => row.errors.length || !row.finished)) process.exitCode = 1;
