import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArena } from '../tests/support/arena.mjs';
import { chooseMove } from '../bot/index.js';
import { chooseMove as hybrid } from '../ai/hybrid.js';

const { DotsGame, NAME } = await loadArena();
const { games } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { audit } = JSON.parse(await readFile(process.argv[3], 'utf8'));
const players = { autonomous: chooseMove, hybrid };
if (process.argv[4]) players.old = (await import(pathToFileURL(resolve(process.argv[4])))).chooseMove;
for (const game of audit) {
  const d = games[game.id];
  const side = ['A','B'].find(k => d[k].name === 'Десептиконы');
  if (!side) continue;
  const color = side === d.red ? 1 : 2;
  const losses = game.swings.filter(([n, swing]) => n > 1 && d.moves[n-1][0] !== color && (side === 'A' ? swing : -swing) < 0);
  const peak = losses.sort((a,b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  if (!peak) continue;
  const [ply, swing] = peak;
  const arena = DotsGame.fromMoves(d.field.width, d.field.height, d.moves.slice(0, ply - 2).map(m => m.slice(1, 3)));
  const request = { ...arena.snapshot(), you: NAME[color], moveTimeoutMs: 2000, timeLeftMs: 900000 };
  const material = g => g.scoreOf(color) - g.scoreOf(3 - color);
  const replies = {};
  for (const [name, pick] of Object.entries(players)) {
    const move = pick(request);
    const after = arena.clone();
    if (!after.play(move.x, move.y).ok) throw Error('Illegal alternative');
    let worst = Infinity;
    for (const cell of after.freeCells()) {
      const branch = after.clone();
      branch.play(...cell);
      worst = Math.min(worst, material(branch) - material(arena));
    }
    replies[name] = { move, worst };
  }
  console.log(JSON.stringify({ id: game.id, ply, loss: Math.abs(swing), actual: d.moves[ply-2].slice(1,3),
    closing: d.moves[ply-1].slice(1,3), replies }));
}
