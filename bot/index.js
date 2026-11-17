/**
 * Dots Bot v0.3 — ограниченный двухполуходовый поиск.
 *
 * Что делает алгоритм:
 *  - использует правила связности из спецификации: точки соединяются по 8
 *    направлениям, пустые области проверяются flood fill по 4 направлениям;
 *  - моделирует немедленный захват и мгновенную гибель точки внутри территории
 *    противника;
 *  - выбирает кандидатов не только рядом с последним ходом, а по всему фронтиру;
 *  - оценивает ходы по захватам, связности групп, изоляции и контролю фронтира;
 *  - для каждого нашего хода ищет сильнейшие ответы соперника и оценивает
 *    худший из них (ограниченный minimax глубины 2 полухода);
 *  - ограничивает время поиска, оставляя запас до лимита API.
 *
 * Ограничение: в архиве нет эталонного движка арены. Поэтому гипотетическая
 * симуляция здесь применяет захват после каждого отдельного хода, но пока не
 * воспроизводит полный цикл вложенных окружений с оживлением ранее мёртвых точек.
 * Состояние текущей позиции берётся из points/dead, присланных самой ареной.
 */

const EMPTY = 0;
const OUR_LIVE = 1;
const ENEMY_LIVE = 2;
const OUR_DEAD = 3;
const ENEMY_DEAD = 4;

const NEIGHBORS_4 = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

const NEIGHBORS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],             [1, 0],
  [-1, 1],  [0, 1],    [1, 1],
];

const CONFIG = {
  maxThinkMs: 1850,
  thinkFraction: 0.52,
  rootMoves: 28,
  replyMoves: 10,
  oversample: 2,
  earlyRadius: 2,
  lateRadius: 1,
  earlyGameStones: 450,
  captureWeight: 6_500,
  selfCapturePenalty: 12_000,
  connectivityWeight: 13,
  frontierWeight: 0.22,
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

function countCode(board, code) {
  let count = 0;
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === code) count += 1;
  }
  return count;
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

/**
 * Разбивает все клетки, не занятые живой точкой wallCode, на компоненты
 * связности по 4 направлениям. Компоненты без выхода к краю окружены.
 */
function analyzeEnclosures(board, width, height, wallCode, targetCode) {
  const size = board.length;
  const visited = new Uint8Array(size);
  const enclosedMask = new Uint8Array(size);
  const queue = new Int32Array(size);
  const captured = [];

  for (let start = 0; start < size; start += 1) {
    if (visited[start] || board[start] === wallCode) continue;

    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }

      for (const [dx, dy] of NEIGHBORS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = coordIndex(nx, ny, width);
        if (visited[next] || board[next] === wallCode) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    if (!touchesBorder) {
      for (let i = 0; i < tail; i += 1) {
        const index = queue[i];
        enclosedMask[index] = 1;
        if (board[index] === targetCode) captured.push(index);
      }
    }
  }

  return { enclosedMask, captured };
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

  let score = ownAdjacent * 8 + enemyAdjacent * 7;
  score += Math.min(ownNear, 8) * 1.5;
  score += Math.min(enemyNear, 8) * 2.1;
  if (ownAdjacent && enemyAdjacent) score += 10;
  if (ownAdjacent >= 2) score += 4;
  if (ownAdjacent >= 5) score -= 9;
  if (ownAdjacent === 0 && enemyAdjacent === 0) score -= 8;

  // Соединение разрозненных групп обычно полезнее, чем добавление точки
  // в уже плотную группу. Аналогично, контакт с несколькими вражескими
  // группами создаёт возможности для разделения и давления.
  score += Math.max(0, ownGroupCount - 1) * 18;
  score += Math.max(0, enemyGroupCount - 1) * 5;

  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
    if (ownAdjacent || enemyAdjacent) score += 3;
  }

  if (liveTotal < 30) {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const maxDistance = Math.max(1, cx + cy);
    const distance = Math.abs(x - cx) + Math.abs(y - cy);
    score += 7 * (1 - distance / maxDistance);
  }

  return score;
}

function generateCandidateIndices(board, width, height, ownCode, enemyCode, limit) {
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
        if (board[next] !== EMPTY || marked[next]) continue;
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
        if (board[index] === EMPTY && !marked[index]) {
          marked[index] = 1;
          candidates.push(index);
        }
      }
    }
  }

  if (candidates.length === 0) {
    for (let index = 0; index < size; index += 1) {
      if (board[index] === EMPTY) candidates.push(index);
    }
  }

  const ownGroups = buildGroups(board, width, height, ownCode);
  const enemyGroups = buildGroups(board, width, height, enemyCode);
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

/** Применяет один ход, используя уже рассчитанную маску территории соперника. */
function applyMove(board, index, width, height, playerCode, enemyCode, enemyTerritoryMask) {
  if (board[index] !== EMPTY) return null;

  const nextBoard = board.slice();
  const selfCaptured = Boolean(enemyTerritoryMask[index]);
  if (selfCaptured) {
    nextBoard[index] = deadCodeFor(playerCode);
    return { board: nextBoard, captured: 0, selfCaptured: true };
  }

  nextBoard[index] = playerCode;
  const result = analyzeEnclosures(nextBoard, width, height, playerCode, enemyCode);
  const enemyDeadCode = deadCodeFor(enemyCode);
  for (const capturedIndex of result.captured) {
    nextBoard[capturedIndex] = enemyDeadCode;
  }

  return { board: nextBoard, captured: result.captured.length, selfCaptured: false };
}

function rankMoves(board, width, height, playerCode, enemyCode, limit, deadline) {
  const enemyTerritory = analyzeEnclosures(
    board, width, height, enemyCode, playerCode,
  ).enclosedMask;
  const rawCandidates = generateCandidateIndices(
    board, width, height, playerCode, enemyCode,
    Math.max(limit * CONFIG.oversample, limit),
  );
  const groupsOwn = buildGroups(board, width, height, playerCode);
  const groupsEnemy = buildGroups(board, width, height, enemyCode);
  const liveTotal = countLive(board, playerCode) + countLive(board, enemyCode);
  const ranked = [];

  for (const index of rawCandidates) {
    if (Date.now() >= deadline) break;
    const simulation = applyMove(
      board, index, width, height, playerCode, enemyCode, enemyTerritory,
    );
    if (!simulation) continue;

    const position = positionalScore(
      board, index, width, height, playerCode, enemyCode,
      groupsOwn, groupsEnemy, liveTotal,
    );
    const score = simulation.captured * CONFIG.captureWeight
      + position
      - (simulation.selfCaptured ? CONFIG.selfCapturePenalty : 0);

    ranked.push({
      index,
      board: simulation.board,
      captured: simulation.captured,
      selfCaptured: simulation.selfCaptured,
      orderScore: score,
    });
  }

  ranked.sort((a, b) => b.orderScore - a.orderScore || a.index - b.index);
  return ranked.slice(0, limit);
}

/**
 * Статическая оценка позиции с точки зрения OUR_LIVE.
 * Это не официальный счёт: он нужен только для сравнения веток поиска.
 */
function evaluatePosition(board, width, height) {
  const ownDead = countCode(board, OUR_DEAD);
  const enemyDead = countCode(board, ENEMY_DEAD);
  const ownLive = countCode(board, OUR_LIVE);
  const enemyLive = countCode(board, ENEMY_LIVE);

  const ownGroups = buildGroups(board, width, height, OUR_LIVE);
  const enemyGroups = buildGroups(board, width, height, ENEMY_LIVE);

  function groupValue(groupSizes) {
    let value = 0;
    for (let id = 1; id < groupSizes.length; id += 1) {
      const size = groupSizes[id];
      if (size === 1) value -= 0.8;
      else value += Math.sqrt(size) + Math.min(size, 8) * 0.12;
    }
    return value;
  }

  let ownFrontier = 0;
  let enemyFrontier = 0;
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== EMPTY) continue;
    const x = index % width;
    const y = Math.floor(index / width);
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

  return (enemyDead * 5_000) - (ownDead * 5_400)
    + (ownLive - enemyLive) * 1.8
    + (groupValue(ownGroups.sizes) - groupValue(enemyGroups.sizes))
      * CONFIG.connectivityWeight
    + (ownFrontier - enemyFrontier) * CONFIG.frontierWeight;
}

function findAnyFreeMove(board, width, height) {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== EMPTY) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const distance = Math.abs(x - cx) + Math.abs(y - cy);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best < 0 ? null : { x: best % width, y: Math.floor(best / width) };
}

export function chooseMove(request) {
  const { board, width, height } = buildBoard(request);
  const liveTotal = countLive(board, OUR_LIVE) + countLive(board, ENEMY_LIVE);
  if (liveTotal === 0) {
    return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  }

  const requestedTimeout = Number.isFinite(request.moveTimeoutMs)
    ? request.moveTimeoutMs
    : 5_000;
  const thinkBudget = Math.max(10, Math.min(
    CONFIG.maxThinkMs,
    Math.floor(requestedTimeout * CONFIG.thinkFraction),
  ));
  const deadline = Date.now() + thinkBudget;

  const rootMoves = rankMoves(
    board, width, height, OUR_LIVE, ENEMY_LIVE,
    CONFIG.rootMoves, deadline,
  );

  if (rootMoves.length === 0) return findAnyFreeMove(board, width, height);

  let bestIndex = rootMoves[0].index;
  let bestScore = -Infinity;
  let completedRootMoves = 0;

  for (const rootMove of rootMoves) {
    if (Date.now() >= deadline) break;

    const replies = rankMoves(
      rootMove.board, width, height, ENEMY_LIVE, OUR_LIVE,
      CONFIG.replyMoves, deadline,
    );

    let worstReplyScore = Infinity;
    let fullyEvaluated = true;

    if (replies.length === 0) {
      worstReplyScore = evaluatePosition(rootMove.board, width, height);
    } else {
      for (const reply of replies) {
        if (Date.now() >= deadline) {
          fullyEvaluated = false;
          break;
        }
        const score = evaluatePosition(reply.board, width, height);
        if (score < worstReplyScore) worstReplyScore = score;
      }
    }

    // Неполную ветку не сравниваем с полностью просмотренными: это не даёт
    // случайно предпочесть ход, для которого мы успели проверить лишь один ответ.
    if (!fullyEvaluated) break;

    completedRootMoves += 1;
    // Небольшая поправка за немедленный результат и за точку, погибающую сразу.
    const finalScore = worstReplyScore
      + rootMove.captured * 120
      - (rootMove.selfCaptured ? 300 : 0);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestIndex = rootMove.index;
    }
  }

  // Если таймер поиска сработал до завершения первой ветки, используем
  // уже проверенный тактический рейтинг, а не рискуем пропустить ход.
  if (completedRootMoves === 0) bestIndex = rootMoves[0].index;
  return { x: bestIndex % width, y: Math.floor(bestIndex / width) };
}

export const BOT_VERSION = '0.3.0';
