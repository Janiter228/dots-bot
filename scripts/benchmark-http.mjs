import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadArena, seededRandom } from '../tests/support/arena.mjs';

const { DotsGame, NAME } = await loadArena();
const { createBotServer } = await import(pathToFileURL(resolve(process.argv[3] ?? 'server/index.js')));
const { games } = JSON.parse(await readFile(process.argv[2], 'utf8'));
let fallbacks = 0;
const server = createBotServer({ botToken: '', gameLogs: { record(event) { if (event.fallback) fallbacks++; } } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const samples = [];
const gamesForBench = Object.values(games).filter(g => [g.A.name, g.B.name].includes('Десептиконы'));
let invalid = 0;
let sequence = 0;
async function sample(arena) {
  const request = { ...arena.snapshot(), moveNo: arena.order.length + 1, gameId: 'bench-' + sequence++,
    you: NAME[arena.turn], moveTimeoutMs: 5000, timeLeftMs: 900000 };
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/move',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const move = await response.json();
  samples.push(performance.now() - start);
  if (!response.ok || !arena.isFree(move.x, move.y)) invalid++;
}
try {
  for (const [i, g] of gamesForBench.entries()) {
    const arena = new DotsGame(g.field.width, g.field.height);
    for (const [color, x, y] of g.moves) {
      if ([12 + i, 132 + i, 288 + i, 394].includes(arena.order.length)) await sample(arena);
      arena.play(x, y, color);
    }
  }
  for (const n of [50, 100]) {
    const arena = new DotsGame(n, n);
    const random = seededRandom(n);
    for (const density of [0.01, 0.4, 0.8]) {
      while (arena.order.length < n * n * density) {
        const i = Math.floor(random() * n * n);
        if (arena.owner[i]) continue;
        arena.owner[i] = arena.turn;
        arena.order.push(i);
        arena.turn = 3 - arena.turn;
      }
      arena._settle();
      await sample(arena);
      if (density === 0.8 && n === 100) await Promise.all(Array.from({ length: 4 }, () => sample(arena)));
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  samples.sort((a, b) => a - b);
  const q = p => samples[Math.ceil(p * samples.length) - 1];
  console.log(JSON.stringify({ n: samples.length, mean: samples.reduce((a,b) => a+b)/samples.length,
    median: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), late: samples.filter(x => x > Number(process.env.MAX_RESPONSE_TIME_MS ?? 2000)).length, invalid, fallbacks }));
} finally {
  server.closeAllConnections();
  server.close();
}
