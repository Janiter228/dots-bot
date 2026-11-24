import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArena, seededRandom } from './support/arena.mjs';

const { DotsGame, RED, BLUE, NAME, opp } = await loadArena();
const sizes = (process.env.DOTS_SIZES ?? '8,20,50').split(',').map(Number);
const pairs = Number(process.env.DOTS_PAIRS ?? 100);
const seed = Number(process.env.DOTS_SEED ?? 1);
const moveTimeoutMs = Number(process.env.DOTS_MOVE_TIMEOUT ?? 30);
const maxPlies = Number(process.env.DOTS_MAX_PLIES ?? Infinity);
const gameTimeoutMs = 900_000;
assert(sizes.every(n => Number.isInteger(n) && n >= 2 && n <= 100));
assert(Number.isSafeInteger(pairs) && pairs >= 1 && Number.isSafeInteger(seed));
assert(Number.isFinite(moveTimeoutMs) && moveTimeoutMs > 0);
assert(maxPlies === Infinity || (Number.isSafeInteger(maxPlies) && maxPlies >= 3));

function randomMove(game, random) {
  const free = game.freeCells();
  const [x, y] = free[Math.floor(random() * free.length)];
  return { x, y };
}

function greedyMove(game, random) {
  const color = game.turn;
  const enemy = opp(color);
  const cells = game.freeCells();
  let best = null;
  let bestScore = -Infinity;
  let ties = 0;
  for (const [x, y] of cells) {
    const after = game.clone();
    const result = after.play(x, y, color);
    const swing = result.changes.reduce((sum, change) => sum +
      (change.dead === (change.color === enemy) ? 1 : -1), 0);
    const counter = game.clone().play(x, y, enemy);
    const blocks = counter.killed.some(change => change.color === color);
    const score = swing * 2 + Number(blocks);
    if (score > bestScore) {
      bestScore = score;
      ties = 0;
    }
    if (score === bestScore && random() * ++ties < 1) best = { x, y };
  }
  return best;
}

async function loadPlayer(name, switches, role) {
  if (name === 'random') return (_request, game, random) => randomMove(game, random);
  if (name === 'greedy') return (_request, game, random) => greedyMove(game, random);
  const url = name === 'current' ? new URL('../bot/index.js', import.meta.url) : pathToFileURL(resolve(name));
  url.searchParams.set('role', role);
  const { chooseMove, TACTICS } = await import(url);
  assert.equal(typeof chooseMove, 'function', name);
  for (const key of switches.split(',').filter(Boolean)) {
    assert(TACTICS && Object.hasOwn(TACTICS, key) && typeof TACTICS[key] === 'boolean', `Неизвестный флаг: ${key}`);
    TACTICS[key] = true;
  }
  return chooseMove;
}

function wilson(wins, total) {
  const z = 1.959963984540054;
  const rate = wins / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const radius = z * Math.sqrt((rate * (1 - rate) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

const playerName = process.env.DOTS_PLAYER ?? 'current';
const playerFlags = process.env.DOTS_PLAYER_TACTICS ?? '';
const opponentFlags = process.env.DOTS_OPPONENT_TACTICS ?? '';
const player = await loadPlayer(playerName, playerFlags, 'player');
const opponents = (process.env.DOTS_OPPONENTS ?? 'random,greedy,current').split(',');
for (const opponentName of opponents) {
  const opponent = await loadPlayer(opponentName, opponentFlags, 'opponent');
  for (const size of sizes) {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let difference = 0;
    let partial = 0;
    let timeouts = 0;
    for (let pair = 0; pair < pairs; pair++) {
      for (const playerColor of [RED, BLUE]) {
        const random = seededRandom(seed + pair);
        const game = new DotsGame(size, size);
        // Одна и та же пара стартовых ходов при обмене цветов.
        for (let ply = 0; ply < 2; ply++) {
          const { x, y } = randomMove(game, random);
          assert(game.play(x, y).ok);
        }
        let timeLeftMs = gameTimeoutMs;
        let forfeited;
        while (!game.full && game.order.length < maxPlies && timeLeftMs > 0) {
          const color = game.turn;
          const current = color === playerColor ? player : opponent;
          const request = {
            ...game.snapshot(), gameId: `${size}-${seed + pair}-${playerColor}`,
            moveNo: game.order.length + 1, you: NAME[color], moveTimeoutMs, timeLeftMs,
          };
          const started = performance.now();
          const move = current(request, game, random);
          const elapsed = performance.now() - started;
          // Имитация таймера арены для тестируемых версий, без учёта времени
          // исчерпывающего перебора служебного жадного оппонента.
          if (color === playerColor || !['random', 'greedy'].includes(opponentName)) {
            if (elapsed > moveTimeoutMs) {
              forfeited = color;
              timeouts++;
              break;
            }
            timeLeftMs -= elapsed;
          }
          assert.ok(game.play(move?.x, move?.y).ok, JSON.stringify({ request, move }));
        }
        if (!game.full && !forfeited && timeLeftMs > 0) partial++;
        const delta = game.scoreOf(playerColor) - game.scoreOf(opp(playerColor));
        difference += delta;
        const result = forfeited ? (forfeited === playerColor ? -1 : 1) : delta;
        if (result > 0) wins++;
        else if (result < 0) losses++;
        else draws++;
      }
    }
    const games = pairs * 2;
    console.log(JSON.stringify({
      player: playerName, playerFlags, opponent: opponentName, opponentFlags, size, seed, games, wins, draws, losses,
      meanScoreDifference: difference / games, winRate95: wilson(wins, games), moveTimeoutMs,
      maxPlies: maxPlies === Infinity ? null : maxPlies, partial, timeouts,
    }));
  }
}
