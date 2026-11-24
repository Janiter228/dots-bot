import assert from 'node:assert/strict';
import { applyMove } from '../bot/index.js';
import { loadArena, seededRandom } from './support/arena.mjs';

const { DotsGame } = await loadArena();
const games = Number(process.env.DOTS_RULE_GAMES ?? 3000);
assert.ok(Number.isSafeInteger(games) && games > 0);
let plies = 0;
let gamesWithDifferences = 0;
let firstDifference = null;

for (let seed = 1; seed <= games; seed++) {
  const size = [5, 8, 12][seed % 3];
  const game = new DotsGame(size, size);
  const random = seededRandom(seed);
  let board = new Uint8Array(size * size);
  let different = false;
  while (!game.full) {
    const choices = game.freeCells();
    const [x, y] = choices[Math.floor(random() * choices.length)];
    const color = game.turn;
    board = applyMove(board, y * size + x, size, size, color, 3 - color, undefined, 1).board;
    assert.ok(game.play(x, y).ok);
    const mismatch = board.findIndex((cell, index) => cell !== game.owner[index] + 2 * game.dead[index]);
    if (mismatch !== -1) {
      different = true;
      firstDifference ??= { seed, size, ply: game.order.length, index: mismatch };
      board = game.owner.map((owner, index) => owner + 2 * game.dead[index]);
    }
    plies++;
  }
  if (different) gamesWithDifferences++;
}
console.log(JSON.stringify({ games, plies, gamesWithDifferences, firstDifference }));
if (gamesWithDifferences > 0) process.exitCode = 1;
