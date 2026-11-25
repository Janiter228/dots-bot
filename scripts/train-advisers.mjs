import { readFile, writeFile } from 'node:fs/promises';
import { loadArena, seededRandom } from '../tests/support/arena.mjs';
import { features, probability } from '../ai/local-advisers.js';

const { DotsGame } = await loadArena();
const data = JSON.parse(await readFile(process.argv[2], 'utf8'));
const random = seededRandom(561367);
const rows = { policy: [[], [], []], risk: [[], [], []] };
const pairs = new Map();
const audit = [];
for (const [id, game] of Object.entries(data.games).sort()) {
  const pair = [game.A.name, game.B.name].sort().join('/');
  if (!pairs.has(pair)) pairs.set(pair, pairs.size);
  const group = pairs.get(pair);
  const holdout = group % 4 ? 0 : group % 8 ? 1 : 2;
  const { width, height } = game.field;
  const arena = new DotsGame(width, height);
  const pending = [];
  const swings = [];
  const checkpoints = [];
  const contact = { A: 0, B: 0 };
  let previous = 0;
  for (const [color, x, y] of game.moves) {
    const side = color === 1 ? game.red : game.red === 'A' ? 'B' : 'A';
    const i = arena.idx(x, y);
    const encode = index => features(index, width, height, j => arena.dead[j] || !arena.owner[j] ? 0 : arena.owner[j] === color ? 1 : 2);
    const values = encode(i);
    if (values[1] + values[3] > 0) contact[side]++;
    if (side === game.winner && arena.freeCount > 1) {
      const other = arena.freeCells().filter(([a, b]) => a !== x || b !== y);
      const [a, b] = other[Math.floor(random() * other.length)];
      rows.policy[holdout].push([values, 1], [encode(arena.idx(a, b)), 0]);
    }
    if (color !== arena.turn || !arena.play(x, y, color).ok) throw Error('Invalid replay ' + id);
    pending.push({ i, values });
    if (pending.length === 9) {
      const entry = pending.shift();
      rows.risk[holdout].push([entry.values, Number(arena.dead[entry.i])]);
    }
    const score = arena.score;
    const diff = (score.red - score.blue) * (game.red === 'A' ? 1 : -1);
    if (previous !== diff) swings.push([arena.order.length, diff - previous]);
    previous = diff;
    if (arena.order.length % 100 === 0) checkpoints.push(diff);
  }
  if (arena.scoreOf(game.red === 'A' ? 1 : 2) !== game.scoreA ||
      arena.scoreOf(game.red === 'B' ? 1 : 2) !== game.scoreB) throw Error('Score mismatch ' + id);
  audit.push({ id, holdout, contact, checkpoints, swings });
}

const weights = {};
const metrics = {};
for (const [name, [train, validation, test]] of Object.entries(rows)) {
  const w = Array(6).fill(0);
  for (let pass = 0; pass < 35; pass++) {
    const g = Array(6).fill(0);
    for (const [x, y] of train) {
      const error = y - probability(w, x);
      g[0] += error;
      x.forEach((v, i) => { g[i + 1] += error * v; });
    }
    w.forEach((v, i) => { w[i] += 0.45 * (g[i] / train.length - (i ? 0.001 * v : 0)); });
  }
  weights[name] = w;
  const prior = train.reduce((s, r) => s + r[1], 0) / train.length;
  const quality = samples => {
    const mse = predict => samples.reduce((s, [x, y]) => s + (y - predict(x)) ** 2, 0) / samples.length;
    return { n: samples.length, brier: mse(x => probability(w, x)), baseline: mse(() => prior) };
  };
  metrics[name] = { train: train.length, validation: quality(validation), test: quality(test) };
}
await writeFile(process.argv[3], JSON.stringify(weights, null, 2) + '\n');
console.log(JSON.stringify({ metrics, audit }));
