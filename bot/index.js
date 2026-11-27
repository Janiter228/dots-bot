/**
 * Dots Bot v0.5.0 — поиск с приоритетом защиты от немедленного захвата.
 *
 * Что делает алгоритм:
 *  - использует правила связности из спецификации: точки соединяются по 8
 *    направлениям, пустые области проверяются flood fill по 4 направлениям;
 *  - моделирует немедленный захват и мгновенную гибель точки внутри территории
 *    противника;
 *  - выбирает кандидатов не только рядом с последним ходом, а по всему фронтиру;
 *  - оценивает ходы по захватам, связности групп, изоляции и контролю фронтира;
 *  - для каждого нашего хода ищет сильнейшие ответы соперника и оценивает
 *    худший из них (2 полухода, выборочно до 4 в тактике);
 *  - ограничивает время поиска, оставляя запас до лимита API.
 *
 * Симуляция на конечном поле пересчитывает окружения и оживление точек.
 * На безграничном поле используется разреженный позиционный выбор без minimax.
 */

import { requestBudget, responseLimit } from './time-budget.js';
import { analyzePosition } from './position-analysis.js';
import { proveForkGain, unavoidableForkLoss } from './fork-defense.js';
import { solveEndgame } from './endgame.js';
import { fieldProfile } from './field-profile.js';

const EMPTY = 0;
const OUR_LIVE = 1;
const ENEMY_LIVE = 2;
const OUR_DEAD = 3;
const ENEMY_DEAD = 4;

const NEIGHBORS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],             [1, 0],
  [-1, 1],  [0, 1],    [1, 1],
];

// Экспериментальные изменения выбора хода требуют отдельной абляции.
export const TACTICS = {
  frontierAnalysis: false,
  forkDefense: false,
  forcingAttack: false,
  exactEndgame: true,
  profile: undefined,
};

const CONFIG = {
  maxThinkFraction: 0.2375,
  thinkFraction: 0.52,
  gameClockDivisor: 120,
  rootMoves: 28,
  replyMoves: 10,
  tacticalRoots: 6,
  oversample: 2,
  earlyRadius: 2,
  lateRadius: 1,
  earlyGameStones: 450,
};

const WEIGHTS = {
  orderingCapture: 6_500,
  selfCapturePenalty: 12_000,
  captured: 5_000,
  lost: 5_400,
  live: 1.8,
  connectivity: 13,
  frontier: 0.22,
  singleton: 0.8,
  groupSize: 0.12,
  rootCapture: 120,
  rootSelfCapture: 300,
  ownAdjacent: 8,
  enemyAdjacent: 7,
  ownNear: 1.5,
  enemyNear: 2.1,
  contact: 10,
  support: 4,
  crowding: 9,
  isolation: 8,
  bridge: 18,
  pressure: 5,
  edge: 3,
  center: 7,
};

function coordIndex(x, y, width) {
  return y * width + x;
}

function countLive(board, code) {
  let count = 0;
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === code) count += 1;
  }
  return count;
}

function materialScore(board) {
  let score = 0;
  for (const cell of board) {
    if (cell === ENEMY_DEAD) score++;
    else if (cell === OUR_DEAD) score--;
  }
  return score;
}

function buildBoard(request) {
  const { width, height } = request.field;
  const board = new Uint8Array(width * height);
  const dead = request.dead || { red: [], blue: [] };
  const deadSets = {
    red: new Set((dead.red || []).map(([x, y]) => coordIndex(x, y, width))),
    blue: new Set((dead.blue || []).map(([x, y]) => coordIndex(x, y, width))),
  };
  const ourColor = request.you;

  for (const color of ['red', 'blue']) {
    const ours = color === ourColor;
    const liveCode = ours ? OUR_LIVE : ENEMY_LIVE;
    const deadCode = ours ? OUR_DEAD : ENEMY_DEAD;
    for (const [x, y] of request.points[color]) {
      const index = coordIndex(x, y, width);
      board[index] = deadSets[color].has(index) ? deadCode : liveCode;
    }
  }

  return { board, width, height };
}

/** Клетки, недостижимые с края по четырём направлениям. */
function enclosed(board, width, height, wallCode) {
  const outside = new Uint8Array(board.length);
  const queue = new Int32Array(board.length);
  let head = 0;
  let tail = 0;
  const visit = (index) => {
    if (outside[index] || board[index] === wallCode) return;
    outside[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < board.length - width) visit(index + width);
  }
  for (let index = 0; index < board.length; index++) {
    outside[index] = Number(!outside[index] && board[index] !== wallCode);
  }
  return outside;
}

/**
 * Создаёт группы точек одного цвета по 8 направлениям.
 * Возвращает id группы для каждой клетки и размеры групп.
 */
function buildGroups(board, width, height, code) {
  const ids = new Int32Array(board.length);
  const sizes = [0];
  const queue = new Int32Array(board.length);
  let groupId = 0;

  for (let start = 0; start < board.length; start += 1) {
    if (board[start] !== code || ids[start] !== 0) continue;
    groupId += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    ids[start] = groupId;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of NEIGHBORS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = coordIndex(nx, ny, width);
        if (board[next] !== code || ids[next] !== 0) continue;
        ids[next] = groupId;
        queue[tail++] = next;
      }
    }
    sizes[groupId] = tail;
  }

  return { ids, sizes };
}

function countAdjacentGroups(ids, x, y, width, height) {
  const seen = new Set();
  for (const [dx, dy] of NEIGHBORS_8) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const groupId = ids[coordIndex(nx, ny, width)];
    if (groupId) seen.add(groupId);
  }
  return seen.size;
}

function positionalScore(
  board, index, width, height, ownCode, enemyCode, ownGroups, enemyGroups, liveTotal,
) {
  const x = index % width;
  const y = Math.floor(index / width);
  let ownAdjacent = 0;
  let enemyAdjacent = 0;
  let ownNear = 0;
  let enemyNear = 0;

  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const value = board[coordIndex(nx, ny, width)];
      const adjacent = Math.max(Math.abs(dx), Math.abs(dy)) === 1;
      if (value === ownCode) {
        if (adjacent) ownAdjacent += 1;
        else ownNear += 1;
      } else if (value === enemyCode) {
        if (adjacent) enemyAdjacent += 1;
        else enemyNear += 1;
      }
    }
  }

  const ownGroupCount = countAdjacentGroups(ownGroups.ids, x, y, width, height);
  const enemyGroupCount = countAdjacentGroups(enemyGroups.ids, x, y, width, height);

  let score = ownAdjacent * WEIGHTS.ownAdjacent + enemyAdjacent * WEIGHTS.enemyAdjacent;
  score += Math.min(ownNear, 8) * WEIGHTS.ownNear;
  score += Math.min(enemyNear, 8) * WEIGHTS.enemyNear;
  if (ownAdjacent && enemyAdjacent) score += WEIGHTS.contact;
  if (ownAdjacent >= 2) score += WEIGHTS.support;
  if (ownAdjacent >= 5) score -= WEIGHTS.crowding;
  if (ownAdjacent === 0 && enemyAdjacent === 0) score -= WEIGHTS.isolation;

  // Соединение разрозненных групп обычно полезнее, чем добавление точки
  // в уже плотную группу. Аналогично, контакт с несколькими вражескими
  // группами создаёт возможности для разделения и давления.
  score += Math.max(0, ownGroupCount - 1) * WEIGHTS.bridge;
  score += Math.max(0, enemyGroupCount - 1) * WEIGHTS.pressure;

  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
    if (ownAdjacent || enemyAdjacent) score += WEIGHTS.edge;
  }

  if (liveTotal < 30) {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const maxDistance = Math.max(1, cx + cy);
    const distance = Math.abs(x - cx) + Math.abs(y - cy);
    score += WEIGHTS.center * (1 - distance / maxDistance);
  }

  return score;
}

function generateCandidateIndices(board, width, height, ownCode, enemyCode, limit, forbiddenMask, enemyTerritory, ownGroups, enemyGroups) {
  const size = board.length;
  const marked = new Uint8Array(size);
  const candidates = [];
  let liveTotal = 0;
  for (let i = 0; i < size; i += 1) {
    if (board[i] === ownCode || board[i] === enemyCode) liveTotal += 1;
  }

  const radius = liveTotal < CONFIG.earlyGameStones
    ? CONFIG.earlyRadius
    : CONFIG.lateRadius;

  for (let index = 0; index < size; index += 1) {
    if (board[index] !== ownCode && board[index] !== enemyCode) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = coordIndex(nx, ny, width);
        if (board[next] !== EMPTY || marked[next] || forbiddenMask[next]) continue;
        marked[next] = 1;
        candidates.push(next);
      }
    }
  }

  if (liveTotal < 8) {
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const index = coordIndex(x, y, width);
        if (board[index] === EMPTY && !marked[index] && !forbiddenMask[index]) {
          marked[index] = 1;
          candidates.push(index);
        }
      }
    }
  }

  // Если рядом с фронтиром нет безопасных клеток, ищем любую свободную
  // клетку вне закрытых территорий, затем внутри своей. В чужую идём
  // только если все свободные клетки там.
  if (candidates.length === 0) {
    for (let index = 0; index < size; index += 1) {
      if (board[index] === EMPTY && !forbiddenMask[index]) candidates.push(index);
    }
  }

  if (candidates.length === 0) {
    for (let index = 0; index < size; index += 1) {
      if (board[index] === EMPTY && !enemyTerritory[index]) candidates.push(index);
    }
  }

  if (candidates.length === 0) {
    for (let index = 0; index < size; index += 1) {
      if (board[index] === EMPTY) candidates.push(index);
    }
  }

  const ranked = candidates.map((index) => ({
    index,
    positional: positionalScore(
      board, index, width, height, ownCode, enemyCode,
      ownGroups, enemyGroups, liveTotal,
    ),
  }));
  ranked.sort((a, b) => b.positional - a.positional || a.index - b.index);
  return ranked.slice(0, limit).map((item) => item.index);
}

function deadCodeFor(playerCode) {
  return playerCode === OUR_LIVE ? OUR_DEAD : ENEMY_DEAD;
}

/** Моделирует пересчёт Arena v1: сначала красные, затем синие. */
export function applyMove(board, index, width, height, playerCode, enemyCode, enemyTerritory, redCode) {
  if (board[index] !== EMPTY) return null;

  const nextBoard = board.slice();
  nextBoard[index] = playerCode;
  const blueCode = redCode === playerCode ? enemyCode : playerCode;
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const [wall, victim] of [[redCode, blueCode], [blueCode, redCode]]) {
      // Если противник проверяется первым, его стены ещё не изменились.
      const mask = round === 0 && wall === enemyCode && wall === redCode && enemyTerritory
        ? enemyTerritory
        : enclosed(nextBoard, width, height, wall);
      const dead = deadCodeFor(victim);
      for (let i = 0; i < nextBoard.length; i++) {
        const current = nextBoard[i];
        if (current !== victim && current !== dead) continue;
        const updated = mask[i] ? dead : victim;
        if (current !== updated) {
          nextBoard[i] = updated;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  let captured = 0;
  const enemyDead = deadCodeFor(enemyCode);
  for (let i = 0; i < board.length; i++) {
    if (board[i] === enemyCode && nextBoard[i] === enemyDead) captured++;
  }
  return { board: nextBoard, captured, selfCaptured: nextBoard[index] === deadCodeFor(playerCode) };
}

// Точка сочленения в графе клеток, проходимых из-за края поля: если
// поставить в неё стену, поддерево без обходного пути окажется в окружении.
function captureMoves(board, width, height, wall, target, enemyTerritory, redCode) {
  const size = board.length;
  const seen = new Int32Array(size);
  const low = new Int32Array(size);
  const targets = new Int32Array(size);
  const captures = new Int32Array(size);
  const stack = new Int32Array(size);
  const direction = new Uint8Array(size);
  const isBorder = (i) => i < width || i >= size - width
    || i % width === 0 || i % width === width - 1;
  let clock = 1;

  function enter(i) {
    seen[i] = ++clock;
    low[i] = isBorder(i) ? 1 : clock;
    targets[i] = Number(board[i] === target);
  }

  for (let start = 0; start < size; start += 1) {
    if (seen[start] || board[start] === wall || !isBorder(start)) continue;
    enter(start);
    let depth = 0;
    stack[0] = start;
    while (depth >= 0) {
      const i = stack[depth];
      const dir = direction[i]++;
      if (dir === 4) {
        depth -= 1;
        if (depth >= 0) {
          const parent = stack[depth];
          if (low[i] >= seen[parent]) captures[parent] += targets[i];
          low[parent] = Math.min(low[parent], low[i]);
          targets[parent] += targets[i];
        }
        continue;
      }
      if ((dir === 0 && i % width === 0) || (dir === 1 && i % width === width - 1)) continue;
      const next = dir === 0 ? i - 1 : dir === 1 ? i + 1 : dir === 2 ? i - width : i + width;
      if (next < 0 || next >= size || board[next] === wall) continue;
      if (seen[next]) {
        if (depth === 0 || next !== stack[depth - 1]) low[i] = Math.min(low[i], seen[next]);
      } else {
        enter(next);
        stack[++depth] = next;
      }
    }
  }

  const moves = [];
  for (let index = 0; index < size; index += 1) {
    if (!captures[index] || board[index] !== EMPTY) continue;
    // Красные проверяются первыми: замыкание внутри синей территории
    // может разрушить её стены и спасти поставленную красную точку.
    const count = !enemyTerritory[index] ? captures[index] : wall === redCode
      ? applyMove(board, index, width, height, wall, target, enemyTerritory, redCode).captured
      : 0;
    if (count) moves.push({ index, count });
  }
  return moves.sort((a, b) => b.count - a.count || a.index - b.index);
}

function rankMoves(board, width, height, playerCode, enemyCode, limit, deadline,
  ownTerritory, enemyTerritory, forced, redCode, analysis, advice) {
  // Любая клетка внутри закрытой области нежелательна:
  // - в чужой территории наша точка сразу погибнет и даст сопернику очко;
  // - в своей территории ход не приносит очков и расходует очередь, хотя
  //   такая клетка могла бы остаться ловушкой для точки соперника.
  const forbiddenMask = new Uint8Array(board.length);
  for (let i = 0; i < board.length; i += 1) {
    if (ownTerritory[i] || enemyTerritory[i]) forbiddenMask[i] = 1;
  }

  const groupsOwn = analysis?.own ?? buildGroups(board, width, height, playerCode);
  const groupsEnemy = analysis?.enemy ?? buildGroups(board, width, height, enemyCode);
  const rawCandidates = generateCandidateIndices(
    board, width, height, playerCode, enemyCode,
    Math.max(limit * CONFIG.oversample, limit), forbiddenMask, enemyTerritory, groupsOwn, groupsEnemy,
  );
  const liveTotal = countLive(board, playerCode) + countLive(board, enemyCode);
  const ranked = [];

  for (const index of new Set([...forced, ...rawCandidates])) {
    if (performance.now() >= deadline) {
      if (!ranked.length || playerCode !== OUR_LIVE) return null;
      break;
    }
    const simulation = applyMove(
      board, index, width, height, playerCode, enemyCode, enemyTerritory, redCode,
    );
    if (!simulation) continue;

    const position = positionalScore(
      board, index, width, height, playerCode, enemyCode,
      groupsOwn, groupsEnemy, liveTotal,
    );
    const connection = analysis?.own.cuts.get(index);
    const cut = analysis?.enemy.cuts.get(index);
    const frontierBonus = (connection?.contested ? 12 : 0) + (cut?.contested ? 8 : 0);
    // Surface quiet preparations for a large enclosure among the opponent replies.
    const setup = playerCode === ENEMY_LIVE && board.length >= 100 && board.length <= 400
      ? projectedPressure(simulation.board, width, height, playerCode, enemyCode)
      : 0;
    const score = simulation.captured * WEIGHTS.orderingCapture + frontierBonus + setup
      + position + (advice?.(board, index, width, height) ?? 0)
      - (simulation.selfCaptured ? WEIGHTS.selfCapturePenalty : 0);

    ranked.push({
      index,
      board: simulation.board,
      captured: simulation.captured,
      selfCaptured: simulation.selfCaptured,
      orderScore: score,
    });
  }

  ranked.sort((a, b) => b.orderScore - a.orderScore || a.index - b.index);
  const shortlist = ranked.slice(0, limit);
  const required = new Set(forced);
  return ranked.filter(({ index }) => required.has(index))
    .concat(shortlist.filter(({ index }) => !required.has(index)));
}

// Project only straight one-cell gaps. A virtual wall changes the search
// heuristic, never the live board or the official capture count.
function projectedPressure(board, width, height, wall, victim) {
  const projected = board.slice();
  for (let y = 1; y + 1 < height; y++) {
    for (let x = 1; x + 1 < width; x++) {
      const i = y * width + x;
      if (board[i] !== EMPTY) continue;
      if ((board[i - 1] === wall && board[i + 1] === wall)
          || (board[i - width] === wall && board[i + width] === wall)
          || (board[i - width - 1] === wall && board[i + width + 1] === wall)
          || (board[i - width + 1] === wall && board[i + width - 1] === wall)) projected[i] = wall;
    }
  }
  const inside = enclosed(projected, width, height, wall);
  let value = 0;
  for (let i = 0; i < board.length; i++) {
    if (inside[i]) value += board[i] === victim ? 100 : board[i] === EMPTY ? 4 : 0;
  }
  return value;
}

/**
 * Статическая оценка позиции с точки зрения OUR_LIVE.
 * Это не официальный счёт: он нужен только для сравнения веток поиска.
 */
function evaluatePosition(board, width, height) {
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < board.length; i += 1) counts[board[i]] += 1;
  const [, ownLive, enemyLive, ownDead, enemyDead] = counts;

  const ownGroups = buildGroups(board, width, height, OUR_LIVE);
  const enemyGroups = buildGroups(board, width, height, ENEMY_LIVE);

  function groupValue(groupSizes) {
    let value = 0;
    for (let id = 1; id < groupSizes.length; id += 1) {
      const size = groupSizes[id];
      if (size === 1) value -= WEIGHTS.singleton;
      else value += Math.sqrt(size) + Math.min(size, 8) * WEIGHTS.groupSize;
    }
    return value;
  }

  const pressure = board.length >= 100 && board.length <= 2500
    ? projectedPressure(board, width, height, OUR_LIVE, ENEMY_LIVE)
      - projectedPressure(board, width, height, ENEMY_LIVE, OUR_LIVE)
    : 0;
  let ownFrontier = 0;
  let enemyFrontier = 0;
  for (let index = 0; index < board.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (board[index] !== EMPTY) continue;
    let nearOwn = false;
    let nearEnemy = false;
    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const value = board[coordIndex(nx, ny, width)];
      if (value === OUR_LIVE) nearOwn = true;
      else if (value === ENEMY_LIVE) nearEnemy = true;
      if (nearOwn && nearEnemy) break;
    }
    if (nearOwn) ownFrontier += 1;
    if (nearEnemy) enemyFrontier += 1;
  }

  return enemyDead * WEIGHTS.captured - ownDead * WEIGHTS.lost
    + pressure + (ownLive - enemyLive) * WEIGHTS.live
    + (groupValue(ownGroups.sizes) - groupValue(enemyGroups.sizes))
      * WEIGHTS.connectivity
    + (ownFrontier - enemyFrontier) * WEIGHTS.frontier;
}

function findFreeIndex(board, width, height, ownTerritory, enemyTerritory) {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  let best = -1;
  let bestPriority = Infinity;
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== EMPTY) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const zone = enemyTerritory?.[index] ? 2 : ownTerritory?.[index] ? 1 : 0;
    const priority = zone * (width + height) + Math.abs(x - cx) + Math.abs(y - cy);
    if (priority < bestPriority) {
      best = index;
      bestPriority = priority;
    }
  }
  return best;
}

function threats(board, width, height, redCode) {
  const ours = enclosed(board, width, height, OUR_LIVE);
  const enemy = enclosed(board, width, height, ENEMY_LIVE);
  return {
    ours, enemy,
    attacks: captureMoves(board, width, height, OUR_LIVE, ENEMY_LIVE, enemy, redCode),
    dangers: captureMoves(board, width, height, ENEMY_LIVE, OUR_LIVE, ours, redCode),
  };
}

// Достаточно одного ответа соперника, удерживающего потолок размена.
function keepsTradeAtFloor(board, width, height, redCode, floor, deadline) {
  const enemyZone = enclosed(board, width, height, ENEMY_LIVE);
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== EMPTY) continue;
    if (performance.now() >= deadline) return false;
    const after = applyMove(board, index, width, height, OUR_LIVE, ENEMY_LIVE, enemyZone, redCode).board;
    if (materialScore(after) > floor) return false;
    if (!after.includes(EMPTY)) continue;
    const ownZone = enclosed(after, width, height, OUR_LIVE);
    const reply = after.findIndex((cell, at) => cell === EMPTY && !ownZone[at]);
    if (reply < 0) return false;
    const leaf = applyMove(after, reply, width, height, ENEMY_LIVE, OUR_LIVE, ownZone, redCode).board;
    if (materialScore(leaf) > floor) return false;
  }
  return performance.now() < deadline;
}

// Проверяем блок перед разменом: после любого ответа должен остаться
// захват, чей результат выдерживает ещё один ответ соперника.
function provesBetterDelayedCapture(board, width, height, redCode, floor, deadline) {
  const enemyZone = enclosed(board, width, height, ENEMY_LIVE);
  const closures = captureMoves(board, width, height, OUR_LIVE, ENEMY_LIVE, enemyZone, redCode).slice(0, 4);
  if (closures.length < 2) return false;

  const ownZone = enclosed(board, width, height, OUR_LIVE);
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== EMPTY) continue;
    if (performance.now() >= deadline) return false;
    const reply = applyMove(board, index, width, height, ENEMY_LIVE, OUR_LIVE, ownZone, redCode).board;
    const replyZone = enclosed(reply, width, height, ENEMY_LIVE);
    const survives = closures.some(({ index: closure }) => {
      if (reply[closure] !== EMPTY || performance.now() >= deadline) return false;
      const after = applyMove(reply, closure, width, height, OUR_LIVE, ENEMY_LIVE, replyZone, redCode).board;
      if (materialScore(after) <= floor) return false;
      const territory = enclosed(after, width, height, OUR_LIVE);
      const counters = captureMoves(after, width, height, ENEMY_LIVE, OUR_LIVE, territory, redCode);
      return counters.every(({ index: counter }) => {
        if (performance.now() >= deadline) return false;
        const leaf = applyMove(after, counter, width, height, ENEMY_LIVE, OUR_LIVE, territory, redCode).board;
        return materialScore(leaf) > floor;
      });
    });
    if (!survives) return false;
  }
  return performance.now() < deadline;
}

// На третьем полуходе пробуем захваты и прямые блоки, на четвёртом —
// сильнейший оставшийся захват соперника. Это выборочная, не полная глубина.
function tacticalLeaf(board, width, height, deadline, staticScore, redCode) {
  if (performance.now() >= deadline) return null;
  const { enemy, attacks, dangers } = threats(board, width, height, redCode);
  if (attacks.length === 0 && dangers.length === 0) return staticScore;

  const indices = new Set([...attacks, ...dangers].map(({ index }) => index));
  const fallback = findFreeIndex(board, width, height, undefined, enemy);
  if (fallback >= 0) indices.add(fallback);
  let best = -Infinity;
  for (const index of indices) {
    if (performance.now() >= deadline) return null;
    const next = applyMove(board, index, width, height, OUR_LIVE, ENEMY_LIVE, enemy, redCode).board;
    const ownTerritory = enclosed(next, width, height, OUR_LIVE);
    const counters = captureMoves(next, width, height, ENEMY_LIVE, OUR_LIVE, ownTerritory, redCode);
    let floor = evaluatePosition(next, width, height);
    for (const { index: counter } of counters.slice(0, 3)) {
      if (performance.now() >= deadline) return null;
      const { board: leaf } = applyMove(next, counter, width, height, ENEMY_LIVE, OUR_LIVE, ownTerritory, redCode);
      floor = Math.min(floor, evaluatePosition(leaf, width, height));
    }
    best = Math.max(best, floor);
  }
  return performance.now() >= deadline ? null : best;
}

function chooseInfiniteMove(request, deadline) {
  const occupied = new Map();
  const key = (x, y) => `${x},${y}`;
  const makeTerritory = () => ({ rows: new Map(), columns: new Map(), known: new Map() });
  const territories = { red: makeTerritory(), blue: makeTerritory() };
  function extend(bounds, line, coordinate) {
    const range = bounds.get(line);
    if (range) {
      range[0] = Math.min(range[0], coordinate);
      range[1] = Math.max(range[1], coordinate);
    } else bounds.set(line, [coordinate, coordinate]);
  }
  let top = Infinity;
  let left = Infinity;
  for (const color of ['red', 'blue']) {
    const dead = new Set((request.dead?.[color] ?? []).map(([x, y]) => key(x, y)));
    const { rows, columns } = territories[color];
    for (const [x, y] of request.points[color]) {
      const k = key(x, y);
      occupied.set(k, dead.has(k) ? null : color);
      if (!dead.has(k)) {
        extend(rows, y, x);
        extend(columns, x, y);
      }
      if (y < top || (y === top && x < left)) {
        top = y;
        left = x;
      }
    }
  }
  if (occupied.size === 0) return { x: 0, y: 0 };

  function isEnclosed(x, y, color) {
    const { rows, columns, known } = territories[color];
    // Если в каком-либо из четырёх направлений нет стены, есть прямой
    // выход наружу. Не строим прямоугольник между удалёнными группами точек.
    const hasExit = (px, py) => {
      const row = rows.get(py);
      const col = columns.get(px);
      return !row || px < row[0] || px > row[1] || !col || py < col[0] || py > col[1];
    };
    if (hasExit(x, y)) return false;
    const start = key(x, y);
    if (known.has(start)) return known.get(start);
    const visited = new Set([start]);
    const queue = [[x, y]];
    let enclosed = true;
    for (let head = 0; head < queue.length; head++) {
      if (performance.now() >= deadline) return null;
      const [px, py] = queue[head];
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const k = key(nx, ny);
        if (visited.has(k) || occupied.get(k) === color) continue;
        if (known.get(k) === false || hasExit(nx, ny)) {
          enclosed = false;
          break;
        }
        // Закрытая область из кеша не может дать выхода.
        if (known.get(k) === true) continue;
        visited.add(k);
        queue.push([nx, ny]);
      }
      if (!enclosed) break;
    }
    for (const k of visited) known.set(k, enclosed);
    return enclosed;
  }

  // Из любой свободной клетки верхней занятой строки можно уйти вверх.
  // Этот ход безопасен, даже когда бюджет поиска уже исчерпан.
  let fallbackX = left - 1;
  if (!Number.isSafeInteger(fallbackX)) {
    fallbackX = left + 1;
    while (occupied.has(key(fallbackX, top))) fallbackX++;
  }
  const seen = new Set();
  const opponent = request.you === 'red' ? 'blue' : 'red';
  let best = { x: fallbackX, y: top };
  let bestScore = -Infinity;
  for (const point of occupied.keys()) {
    if (performance.now() >= deadline) return best;
    const [x, y] = point.split(',').map(Number);
    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      const candidate = key(nx, ny);
      if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny)
          || occupied.has(candidate) || seen.has(candidate)) continue;
      if (performance.now() >= deadline) return best;
      seen.add(candidate);
      const inEnemy = isEnclosed(nx, ny, opponent);
      if (inEnemy === null) return best;
      if (inEnemy) continue;
      const inOwn = isEnclosed(nx, ny, request.you);
      if (inOwn === null) return best;
      if (inOwn) continue;
      let score = 0;
      for (const [ax, ay] of NEIGHBORS_8) {
        const color = occupied.get(key(nx + ax, ny + ay));
        if (color) score += color === request.you ? WEIGHTS.ownAdjacent : WEIGHTS.enemyAdjacent;
      }
      if (score > bestScore) {
        best = { x: nx, y: ny };
        bestScore = score;
      }
    }
  }
  return best;
}

export function chooseMove(request, { advice, checkpoint } = {}) {
  const started = performance.now();
  const limit = responseLimit();
  const requestedTimeout = requestBudget(request, limit);
  const remainingCells = request.field.infinite ? 0 : request.field.width * request.field.height
    - request.points.red.length - request.points.blue.length;
  const expectedTurns = Math.ceil(remainingCells / 2);
  const clockBudget = Number.isFinite(request.timeLeftMs)
    ? Math.max(0, request.timeLeftMs / Math.max(CONFIG.gameClockDivisor, expectedTurns)
      - (expectedTurns > CONFIG.gameClockDivisor ? 50 : 0))
    : Infinity;
  const thinkBudget = Math.max(0, Math.min(
    limit * CONFIG.maxThinkFraction,
    requestedTimeout * CONFIG.thinkFraction,
    clockBudget,
  ));
  const deadline = started + thinkBudget;
  if (fieldProfile(request.field) === 'infinite') return chooseInfiniteMove(request, deadline);

  const { board, width, height } = buildBoard(request);
  const freeCount = board.length - request.points.red.length - request.points.blue.length;
  const profile = fieldProfile(request.field, freeCount, TACTICS.profile);
  const redCode = request.you === 'red' ? OUR_LIVE : ENEMY_LIVE;
  const moveAt = (index) => index < 0 ? null : { x: index % width, y: Math.floor(index / width) };
  const legal = findFreeIndex(board, width, height);
  if (legal < 0 || request.points.red.length + request.points.blue.length === 0
      || (freeCount <= 1 && board.indexOf(EMPTY) === board.lastIndexOf(EMPTY))) {
    return moveAt(legal);
  }

  if (performance.now() >= deadline) {
    const ours = enclosed(board, width, height, OUR_LIVE);
    const enemy = enclosed(board, width, height, ENEMY_LIVE);
    return moveAt(findFreeIndex(board, width, height, ours, enemy));
  }

  if (TACTICS.exactEndgame && freeCount <= 7 && board.length <= 400) {
    try {
      const endgameDeadline = Math.min(deadline, performance.now() + thinkBudget * 0.5);
      const endgame = solveEndgame(board, (position, index, color) =>
        applyMove(position, index, width, height, color, 3 - color, undefined, redCode).board,
      endgameDeadline);
      if (endgame?.solved) return moveAt(endgame.move);
    } catch {
      // При недоказанном результате остаётся обычный поиск.
    }
  }

  const rootThreats = threats(board, width, height, redCode);
  const { ours, enemy, attacks, dangers } = rootThreats;
  const safe = findFreeIndex(board, width, height, ours, enemy);
  const blocks = dangers.filter(({ index }) => !enemy[index]);
  // A long wall can capture an entire group at once. Test the actual swing
  // after the opponent's largest closures before spending time on quiet moves.
  if ((dangers[0]?.count ?? 0) >= 3 && blocks.length && performance.now() < deadline) {
    const directBlocks = blocks.slice(0, 4).map(m => m.index);
    const urgent = new Set([...directBlocks, ...attacks.slice(0, 4).map(m => m.index)]);
    const safeBlocks = [];
    let best = -1;
    let bestFloor = -Infinity;
    let bestCounter;
    const initial = materialScore(board);
    for (const index of urgent) {
      if (performance.now() >= deadline) break;
      const next = applyMove(board, index, width, height, OUR_LIVE, ENEMY_LIVE, enemy, redCode).board;
      const ownZone = enclosed(next, width, height, OUR_LIVE);
      const replies = captureMoves(next, width, height, ENEMY_LIVE, OUR_LIVE, ownZone, redCode);
      const immediate = materialScore(next);
      let floor = immediate;
      let worstReply;
      for (const reply of replies.slice(0, 3)) {
        const after = applyMove(next, reply.index, width, height, ENEMY_LIVE, OUR_LIVE, ownZone, redCode);
        const material = materialScore(after.board);
        if (material < floor) {
          floor = material;
          worstReply = after.board;
        }
      }
      if (directBlocks.includes(index) && replies.length === 0 && immediate >= initial) safeBlocks.push({ index, next });
      if (floor > bestFloor) {
        bestFloor = floor;
        bestCounter = worstReply;
        best = index;
      }
    }
    if (best >= 0 && bestFloor >= initial) {
      if (board.length <= 400 && attacks.length >= 2 && bestCounter && safeBlocks.length) {
        checkpoint?.(moveAt(best));
        const proofDeadline = Math.min(deadline, performance.now() + Math.min(120, thinkBudget * 0.3));
        if (keepsTradeAtFloor(bestCounter, width, height, redCode, bestFloor, proofDeadline)) {
          for (const { index, next } of safeBlocks) {
            if (performance.now() >= proofDeadline) break;
            if (provesBetterDelayedCapture(next, width, height, redCode, bestFloor, proofDeadline)) return moveAt(index);
          }
        }
      }
      return moveAt(best);
    }
  }
  const quickAttack = dangers.length === 0 && attacks.length === 1 ? attacks[0].index : undefined;
  const quickBlock = dangers.length === 1 && attacks.length === 0 ? blocks[0]?.index : undefined;
  const quick = quickAttack ?? quickBlock;
  if (quick !== undefined && performance.now() < deadline) {
    // Само замыкание может поставить новую точку под контрзахват.
    const next = applyMove(board, quick, width, height, OUR_LIVE, ENEMY_LIVE, enemy, redCode);
    const nextOurs = enclosed(next.board, width, height, OUR_LIVE);
    if (!next.selfCaptured
      && (quickBlock !== undefined || next.captured > 0)
      && captureMoves(next.board, width, height, ENEMY_LIVE, OUR_LIVE, nextOurs, redCode).length === 0) {
      return moveAt(quick);
    }
  }
  // При встречных угрозах запасной ход блокирует одиночное замыкание,
  // если таймер не позволил проверить последствия размена.
  const directBlock = dangers.length === 1 ? blocks[0]?.index : undefined;
  const fallback = directBlock ?? attacks[0]?.index ?? blocks[0]?.index ?? safe;
  checkpoint?.(moveAt(fallback));
  if (performance.now() >= deadline) {
    return moveAt(fallback);
  }

  const forced = [...attacks, ...blocks].map(({ index }) => index);
  const ordinaryDeadline = started + thinkBudget * 0.8;
  let analysis;
  if (TACTICS.frontierAnalysis) {
    try {
      analysis = analyzePosition({
        board, width, height, threats: rootThreats,
        groupsOwn: buildGroups(board, width, height, OUR_LIVE),
        groupsEnemy: buildGroups(board, width, height, ENEMY_LIVE),
        deadline: Math.min(ordinaryDeadline, performance.now() + thinkBudget * 0.03),
      });
    } catch {
      // Обычный поиск остаётся доступен при сбое экспериментального анализа.
    }
  }
  const rootMoves = rankMoves(
    board, width, height, OUR_LIVE, ENEMY_LIVE,
    CONFIG.rootMoves, ordinaryDeadline, ours, enemy, forced, redCode, analysis, advice,
  );
  if (!rootMoves?.length) return moveAt(fallback);
  if (directBlock !== undefined) {
    const blockPosition = rootMoves.findIndex(({ index }) => index === directBlock);
    if (blockPosition > 0) rootMoves.unshift(rootMoves.splice(blockPosition, 1)[0]);
  }
  if (TACTICS.forcingAttack && profile === 'tiny' && forced.length === 0 && board.length <= 100) {
    try {
      const attackDeadline = Math.min(ordinaryDeadline, performance.now() + Math.min(18, thinkBudget * 0.15));
      const startingScore = countLive(board, ENEMY_DEAD) - countLive(board, OUR_DEAD);
      const simulate = (position, index, color) =>
        applyMove(position, index, width, height, color, 3 - color, undefined, redCode).board;
      let bestAttack = null;
      let bestGain = 0;
      for (const candidate of rootMoves.slice(0, 12)) {
        if (performance.now() >= attackDeadline) break;
        if (candidate.selfCaptured) continue;
        const defendingTerritory = enclosed(candidate.board, width, height, ENEMY_LIVE);
        const closures = captureMoves(candidate.board, width, height, OUR_LIVE, ENEMY_LIVE, defendingTerritory, redCode);
        if (closures.length < 2) continue;
        const gain = proveForkGain(
          candidate.board, OUR_LIVE, closures.slice(0, 4).map(({ index }) => index),
          simulate, attackDeadline,
        );
        if (!gain) continue;
        const openingSwing = countLive(candidate.board, ENEMY_DEAD) -
          countLive(candidate.board, OUR_DEAD) - startingScore;
        if (openingSwing + gain > bestGain) {
          bestGain = openingSwing + gain;
          bestAttack = candidate.index;
        }
      }
      if (bestAttack !== null) return moveAt(bestAttack);
    } catch {
      // Обычный поиск остаётся доступен при сбое доказательного поиска.
    }
  }
  const forkBudget = TACTICS.forkDefense && profile === 'tiny' && board.length <= 81 ? Math.min(12, thinkBudget * 0.12) : 0;
  let forkTimeRemaining = forkBudget;
  let lossFreeIndex = -1;
  const completed = [];

  for (const rootMove of rootMoves) {
    if (performance.now() >= ordinaryDeadline) break;
    const next = threats(rootMove.board, width, height, redCode);
    const lossFree = !rootMove.selfCaptured && next.dangers.length === 0;
    if (lossFree && lossFreeIndex < 0) lossFreeIndex = rootMove.index;
    // Размен не вытесняет ход без немедленной потери, даже если на третьем
    // полуходе получается отыграть очко. Если защиты нет, сравниваем размены.
    if (!lossFree && lossFreeIndex >= 0) continue;
    const required = [...next.dangers, ...next.attacks.filter(({ index }) => !next.ours[index])];

    const replies = rankMoves(
      rootMove.board, width, height, ENEMY_LIVE, OUR_LIVE,
      CONFIG.replyMoves, ordinaryDeadline, next.enemy, next.ours, required.map(({ index }) => index), redCode,
    );
    if (!replies) break;

    let worstReplyScore = Infinity;
    let fullyEvaluated = true;

    if (replies.length === 0) {
      worstReplyScore = evaluatePosition(rootMove.board, width, height);
    } else {
      for (const reply of replies) {
        if (performance.now() >= ordinaryDeadline) {
          fullyEvaluated = false;
          break;
        }
        const staticScore = evaluatePosition(reply.board, width, height);
        let score = staticScore;
        if (forkTimeRemaining > 0) {
          const start = performance.now();
          const forkDeadline = Math.min(ordinaryDeadline, start + forkTimeRemaining);
          try {
            const territory = enclosed(reply.board, width, height, OUR_LIVE);
            const closures = captureMoves(reply.board, width, height, ENEMY_LIVE, OUR_LIVE, territory, redCode);
            if (closures.length >= 2 && performance.now() < forkDeadline) {
              const damage = unavoidableForkLoss(
                reply.board, closures.slice(0, 4).map(({ index }) => index),
                (position, index, color) => applyMove(position, index, width, height, color, 3 - color, undefined, redCode).board,
                forkDeadline,
              );
              score -= (damage ?? 0) * WEIGHTS.lost;
            }
          } catch {
            // Без доказательства сохраняем прежнюю оценку ответа.
          }
          forkTimeRemaining -= performance.now() - start;
        }
        reply.staticScore = staticScore;
        if (score < worstReplyScore) worstReplyScore = score;
      }
    }

    // Неполную ветку не сравниваем с полностью просмотренными: это не даёт
    // случайно предпочесть ход, для которого мы успели проверить лишь один ответ.
    if (!fullyEvaluated || performance.now() >= ordinaryDeadline) break;

    const bonus = rootMove.captured * WEIGHTS.rootCapture
      - (rootMove.selfCaptured ? WEIGHTS.rootSelfCapture : 0);
    completed.push({ rootMove, replies, bonus, finalScore: worstReplyScore + bonus, lossFree });
  }

  const eligible = lossFreeIndex < 0 ? completed : completed.filter(({ lossFree }) => lossFree);
  const shortlist = eligible.sort((a, b) => b.finalScore - a.finalScore).slice(0, CONFIG.tacticalRoots);
  if (!shortlist.length) {
    return moveAt(lossFreeIndex >= 0 ? lossFreeIndex : forced.length ? fallback : rootMoves[0].index);
  }
  const bestIndex = shortlist[0].rootMove.index;
  checkpoint?.(moveAt(bestIndex));
  let deeperIndex = bestIndex;
  let deeperScore = -Infinity;
  let tactical = false;
  for (const { rootMove, replies, bonus } of shortlist) {
    let worst = replies.length ? Infinity : evaluatePosition(rootMove.board, width, height);
    for (const reply of replies) {
      const score = tacticalLeaf(reply.board, width, height, deadline, reply.staticScore, redCode);
      if (score === null) return moveAt(bestIndex);
      if (score !== reply.staticScore) tactical = true;
      worst = Math.min(worst, score);
    }
    if (worst + bonus > deeperScore) {
      deeperScore = worst + bonus;
      deeperIndex = rootMove.index;
    }
  }
  return moveAt(tactical ? deeperIndex : bestIndex);
}

export const BOT_VERSION = '0.5.0';
