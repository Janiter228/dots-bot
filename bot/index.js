/**
 * Тактическая стратегия для игры «Точки».
 *
 * Реализовано:
 *  - поиск немедленного захвата через flood fill;
 *  - блокировка хода соперника, который немедленно захватывает наши точки;
 *  - отказ от ходов в уже окружённую территорию соперника;
 *  - оценка перспективных клеток по связности и близости к противнику;
 *  - короткая проверка ответа соперника для лучших кандидатов.
 *
 * Важно: алгоритм flood fill следует формулировке v1: живые точки
 * атакующего являются стенами, области проверяются по 4 направлениям.
 * Эталонный движок арены всё равно остаётся окончательным источником правил.
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
  // Не используем весь лимит арены: оставляем запас на HTTP и сериализацию.
  thinkTimeMs: 1700,
  maxCandidates: 76,
  maxReplyCandidates: 30,
  deepCheckCandidates: 12,
  candidateRadius: 2,
  captureWeight: 250_000,
  blockBaseWeight: 210_000,
  replyLossWeight: 300_000,
  replyThreatWeight: 100_000,
};

function coordIndex(x, y, width) {
  return y * width + x;
}

function buildBoard(request) {
  const { width, height } = request.field;
  const size = width * height;
  const board = new Uint8Array(size);
  const colors = ['red', 'blue'];
  const ourColor = request.you;
  const enemyColor = ourColor === 'red' ? 'blue' : 'red';

  const dead = request.dead || { red: [], blue: [] };
  const deadSets = {
    red: new Set((dead.red || []).map(([x, y]) => coordIndex(x, y, width))),
    blue: new Set((dead.blue || []).map(([x, y]) => coordIndex(x, y, width))),
  };

  for (const color of colors) {
    const isOurs = color === ourColor;
    for (const [x, y] of request.points[color]) {
      const index = coordIndex(x, y, width);
      if (deadSets[color].has(index)) {
        board[index] = isOurs ? OUR_DEAD : ENEMY_DEAD;
      } else {
        board[index] = isOurs ? OUR_LIVE : ENEMY_LIVE;
      }
    }
  }

  return { board, width, height };
}

/**
 * Находит все области, ограниченные живыми точками wallCode.
 * Связность пустого пространства — 4 направления; мёртвые точки
 * остаются занятыми, но не являются стенами и потому проходимы.
 */
function analyzeEnclosures(board, width, height, wallCode, targetCode) {
  const size = width * height;
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

function countLive(board, code) {
  let count = 0;
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === code) count += 1;
  }
  return count;
}

function positionalScore(board, index, width, height, ownCode, enemyCode) {
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
      const isAdjacent = Math.max(Math.abs(dx), Math.abs(dy)) === 1;

      if (value === ownCode) {
        if (isAdjacent) ownAdjacent += 1;
        else ownNear += 1;
      } else if (value === enemyCode) {
        if (isAdjacent) enemyAdjacent += 1;
        else enemyNear += 1;
      }
    }
  }

  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const maxDistance = Math.max(1, centerX + centerY);
  const distance = Math.abs(x - centerX) + Math.abs(y - centerY);
  const centerBonus = 4 * (1 - distance / maxDistance);

  let score = ownAdjacent * 7 + enemyAdjacent * 8;
  score += Math.min(ownNear, 8) * 1.4;
  score += Math.min(enemyNear, 8) * 1.8;
  if (ownAdjacent > 0 && enemyAdjacent > 0) score += 14;
  if (ownAdjacent >= 2) score += 5;
  if (ownAdjacent >= 5) score -= 7; // не скучиваемся без причины
  if (ownAdjacent === 0 && enemyAdjacent === 0) score -= 5;
  score += centerBonus;

  return score;
}

function generateCandidates(
  board,
  width,
  height,
  ownCode,
  enemyCode,
  maxCandidates,
  radius = CONFIG.candidateRadius,
) {
  const size = width * height;
  const marked = new Uint8Array(size);
  const candidates = [];
  let liveCount = 0;

  for (let index = 0; index < size; index += 1) {
    const value = board[index];
    if (value !== ownCode && value !== enemyCode) continue;
    liveCount += 1;
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

  // Дебют: сохраняем несколько центральных вариантов, даже если рядом нет точек.
  if (liveCount < 8) {
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = centerX + dx;
        const y = centerY + dy;
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

  const ranked = candidates.map((index) => ({
    index,
    score: positionalScore(board, index, width, height, ownCode, enemyCode),
  }));

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, maxCandidates).map((item) => item.index);
}

function placeAndCapture(
  board, index, width, height, attackerCode, defenderCode, knownDefenderMask = null,
) {
  const defenderMask = knownDefenderMask || analyzeEnclosures(
    board, width, height, defenderCode, attackerCode,
  ).enclosedMask;

  // Точка в уже окружённой противником области сразу погибнет.
  if (defenderMask[index]) {
    return { board: null, captured: [], selfCaptured: true };
  }

  const nextBoard = board.slice();
  nextBoard[index] = attackerCode;
  const result = analyzeEnclosures(
    nextBoard, width, height, attackerCode, defenderCode,
  );

  const deadCode = defenderCode === OUR_LIVE ? OUR_DEAD : ENEMY_DEAD;
  for (const capturedIndex of result.captured) {
    nextBoard[capturedIndex] = deadCode;
  }

  return { board: nextBoard, captured: result.captured, selfCaptured: false };
}

function findImmediateThreats(
  board,
  width,
  height,
  attackerCode,
  defenderCode,
  maxCandidates,
  deadline,
) {
  const defenderEnclosure = analyzeEnclosures(
    board, width, height, defenderCode, attackerCode,
  );
  const candidates = generateCandidates(
    board,
    width,
    height,
    attackerCode,
    defenderCode,
    maxCandidates,
  );
  const threats = [];

  for (const index of candidates) {
    if (Date.now() >= deadline) break;
    if (defenderEnclosure.enclosedMask[index]) continue;

    const next = board.slice();
    next[index] = attackerCode;
    const result = analyzeEnclosures(
      next, width, height, attackerCode, defenderCode,
    );

    if (result.captured.length > 0) {
      threats.push({ index, captured: result.captured.length });
    }
  }

  threats.sort((a, b) => b.captured - a.captured || a.index - b.index);
  return threats;
}

function findFallback(board, width, height) {
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== EMPTY) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const distance = Math.abs(x - centerX) + Math.abs(y - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) return null;
  return { x: bestIndex % width, y: Math.floor(bestIndex / width) };
}

export function chooseMove(request) {
  const { board, width, height } = buildBoard(request);
  const ownLive = countLive(board, OUR_LIVE);
  const enemyLive = countLive(board, ENEMY_LIVE);

  if (ownLive + enemyLive === 0) {
    return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  }

  const deadline = Date.now() + CONFIG.thinkTimeMs;
  const currentEnemyEnclosure = analyzeEnclosures(
    board, width, height, ENEMY_LIVE, OUR_LIVE,
  );

  // Сначала выясняем, может ли соперник захватить наши точки прямо следующим ходом.
  const enemyThreats = findImmediateThreats(
    board,
    width,
    height,
    ENEMY_LIVE,
    OUR_LIVE,
    CONFIG.maxReplyCandidates * 2,
    deadline,
  );
  const threatByIndex = new Map(
    enemyThreats.map((threat) => [threat.index, threat.captured]),
  );

  let candidates = generateCandidates(
    board,
    width,
    height,
    OUR_LIVE,
    ENEMY_LIVE,
    CONFIG.maxCandidates,
  );

  // Критические клетки защиты обязательно добавляем в список, даже если эвристика
  // позиционного ранжирования поставила их невысоко.
  for (const threat of enemyThreats) {
    if (!candidates.includes(threat.index)) candidates.unshift(threat.index);
  }

  const evaluated = [];
  for (const index of candidates) {
    if (Date.now() >= deadline) break;
    if (board[index] !== EMPTY) continue;

    const simulation = placeAndCapture(
      board, index, width, height, OUR_LIVE, ENEMY_LIVE,
      currentEnemyEnclosure.enclosedMask,
    );
    if (simulation.selfCaptured || !simulation.board) continue;

    const blockCount = threatByIndex.get(index) || 0;
    const position = positionalScore(
      board, index, width, height, OUR_LIVE, ENEMY_LIVE,
    );
    const baseScore = simulation.captured.length * CONFIG.captureWeight
      + (blockCount > 0
        ? CONFIG.blockBaseWeight + blockCount * 120_000
        : 0)
      + position;

    evaluated.push({
      index,
      board: simulation.board,
      captured: simulation.captured.length,
      blockCount,
      baseScore,
      score: baseScore,
    });
  }

  if (evaluated.length === 0) {
    return findFallback(board, width, height);
  }

  evaluated.sort((a, b) => b.baseScore - a.baseScore || a.index - b.index);

  // Проверяем ответ соперника только для лучших вариантов: тактический просмотр
  // остаётся коротким и не перебирает все 10 000 пересечений на каждом уровне.
  const deepChecks = evaluated.slice(0, CONFIG.deepCheckCandidates);
  for (const candidate of deepChecks) {
    if (Date.now() >= deadline) break;

    const replies = findImmediateThreats(
      candidate.board,
      width,
      height,
      ENEMY_LIVE,
      OUR_LIVE,
      CONFIG.maxReplyCandidates,
      deadline,
    );

    if (replies.length > 0) {
      const worstLoss = replies[0].captured;
      const additionalThreats = Math.min(3, replies.length - 1);
      candidate.score -= worstLoss * CONFIG.replyLossWeight;
      candidate.score -= additionalThreats * CONFIG.replyThreatWeight;
    }
  }

  evaluated.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = evaluated[0].index;
  return { x: best % width, y: Math.floor(best / width) };
}
