import { readFile } from 'node:fs/promises';
import { loadArena, seededRandom } from '../tests/support/arena.mjs';
import { chooseMove } from '../bot/index.js';
import { loadAdvice } from '../ai/hybrid.js';
import { features } from '../ai/local-advisers.js';

const { DotsGame, NAME } = await loadArena();
const { games } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const profiles = new Map();
const team = 'Десептиконы';
function key(g, i) {
  return features(i, g.w, g.h, j => g.dead[j] || !g.owner[j] ? 0 : g.owner[j] === g.turn ? 1 : 2).join(',');
}
function count(map, k) { map.set(k, 1 + (map.get(k) ?? 0)); }
for (const g of Object.values(games)) {
  if (g.A.name === team || g.B.name === team) continue;
  const arena = new DotsGame(g.field.width, g.field.height);
  const random = seededRandom(1);
  for (const [color, x, y] of g.moves) {
    const name = g[color === 1 ? g.red : g.red === 'A' ? 'B' : 'A'].name;
    if (!profiles.has(name)) profiles.set(name, { played: new Map(), available: new Map() });
    const profile = profiles.get(name);
    count(profile.played, key(arena, arena.idx(x, y)));
    const cells = arena.freeCells();
    for (let i = 0; i < 3; i++) {
      const [a, b] = cells[Math.floor(random() * cells.length)];
      count(profile.available, key(arena, arena.idx(a, b)));
    }
    arena.play(x, y, color);
  }
}
for (const [name, { played, available }] of profiles) {
  for (const mode of ['autonomous', 'hybrid']) {
    const advice = loadAdvice(mode);
    for (const color of [1, 2]) {
      const arena = new DotsGame(20, 20);
      const random = seededRandom(23);
      arena.play(10, 10);
      arena.play(9, 9);
      while (!arena.full) {
        if (arena.turn === color) {
          const m = chooseMove({ ...arena.snapshot(), you: NAME[color], moveTimeoutMs: 40 }, { advice });
          if (!arena.play(m.x, m.y).ok) throw Error('Недопустимый ход бота');
        } else {
          let best, bestValue = -Infinity;
          for (const cell of arena.freeCells()) {
            const k = key(arena, arena.idx(...cell));
            const preference = Math.log(((played.get(k) ?? 0) + 2) / ((available.get(k) ?? 0) + 6));
            const sample = preference - 0.35 * Math.log(-Math.log(Math.max(Number.EPSILON, random())));
            if (sample > bestValue) { bestValue = sample; best = cell; }
          }
          arena.play(...best);
        }
      }
      console.log(JSON.stringify({name, mode, color, own:arena.scoreOf(color), other:arena.scoreOf(3-color)}));
    }
  }
}
