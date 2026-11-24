const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function groupTopology(ids, width, height, deadline) {
  const seen = new Int32Array(ids.length);
  const low = new Int32Array(ids.length);
  const articulation = new Set();
  const bridges = [];
  let clock = 0;
  for (let start = 0; start < ids.length; start++) {
    if ((start & 63) === 0 && performance.now() >= deadline) return null;
    if (!ids[start] || seen[start]) continue;
    const stack = [{ index: start, direction: 0, children: 0 }];
    low[start] = seen[start] = ++clock;
    while (stack.length) {
      if ((clock & 63) === 0 && performance.now() >= deadline) return null;
      const frame = stack.at(-1);
      const { index } = frame;
      if (frame.direction === NEIGHBORS.length) {
        stack.pop();
        const parent = stack.at(-1);
        if (!parent) {
          if (frame.children > 1) articulation.add(index);
          continue;
        }
        low[parent.index] = Math.min(low[parent.index], low[index]);
        if (low[index] > seen[parent.index]) bridges.push([parent.index, index]);
        if (stack.length > 1 && low[index] >= seen[parent.index]) articulation.add(parent.index);
        continue;
      }
      const [dx, dy] = NEIGHBORS[frame.direction++];
      const x = (index % width) + dx;
      const y = Math.floor(index / width) + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const next = y * width + x;
      if (ids[next] !== ids[index] || next === stack.at(-2)?.index) continue;
      if (seen[next]) {
        low[index] = Math.min(low[index], seen[next]);
        continue;
      }
      frame.children++;
      low[next] = seen[next] = ++clock;
      stack.push({ index: next, direction: 0, children: 0 });
    }
  }
  return { articulation, bridges };
}

function inspectGroups(board, width, height, color, groups, opponentGroups, deadline) {
  const frontiers = groups.sizes.map(() => new Set());
  const cuts = new Map();

  for (let index = 0; index < board.length; index++) {
    if ((index & 63) === 0 && performance.now() >= deadline) return null;
    if (board[index] !== 0) continue;
    const x = index % width;
    const y = (index - x) / width;
    const neighbors = new Set();
    let contested = false;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      const group = groups.ids[neighbor];
      if (group) neighbors.add(group);
      if (opponentGroups.ids[neighbor]) contested = true;
    }
    for (const group of neighbors) frontiers[group].add(index);
    if (neighbors.size >= 2) cuts.set(index, { groups: [...neighbors], contested });
  }

  const topology = groupTopology(groups.ids, width, height, deadline);
  return topology && { color, ...groups, frontiers, cuts, ...topology };
}

function distances(board, width, height, color, deadline) {
  const distance = new Int32Array(board.length);
  distance.fill(-1);
  const queue = new Int32Array(board.length);
  let tail = 0;
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== color) continue;
    distance[index] = 0;
    queue[tail++] = index;
  }
  for (let head = 0; head < tail; head++) {
    if ((head & 63) === 0 && performance.now() >= deadline) return null;
    const index = queue[head];
    const x = index % width;
    const nextDistance = distance[index] + 1;
    for (const next of [
      x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1,
      index - width, index + width,
    ]) {
      if (next < 0 || next >= height * width || distance[next] >= 0) continue;
      distance[next] = nextDistance;
      queue[tail++] = next;
    }
  }
  return distance;
}

function distancesFromEdge(board, width, height, wall, deadline) {
  const distances = new Int32Array(board.length).fill(-1);
  const queue = new Int32Array(board.length);
  let tail = 0;
  function visit(index, distance) {
    if (board[index] === wall || distances[index] !== -1) return;
    distances[index] = distance;
    queue[tail++] = index;
  }
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit((height - 1) * width + x, 0);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width, 0);
    visit(y * width + width - 1, 0);
  }
  for (let head = 0; head < tail; head++) {
    if ((head & 63) === 0 && performance.now() >= deadline) return null;
    const index = queue[head];
    const x = index % width;
    const distance = distances[index] + 1;
    if (x > 0) visit(index - 1, distance);
    if (x < width - 1) visit(index + 1, distance);
    if (index >= width) visit(index - width, distance);
    if (index < board.length - width) visit(index + width, distance);
  }
  return distances;
}

function closestGroupExits(groups, edgeDistances, deadline) {
  const closest = Array(groups.sizes.length).fill(Infinity);
  for (let index = 0; index < groups.ids.length; index++) {
    if ((index & 255) === 0 && performance.now() >= deadline) return null;
    const group = groups.ids[index];
    const distance = edgeDistances[index];
    if (group && distance !== -1 && distance < closest[group]) closest[group] = distance;
  }
  return closest;
}

// Маски территорий и немедленные угрозы вычисляет основной симулятор.
export function analyzePosition({ board, width, height, groupsOwn, groupsEnemy, threats, deadline }) {
  const own = inspectGroups(board, width, height, 1, groupsOwn, groupsEnemy, deadline);
  if (!own) return null;
  const enemy = inspectGroups(board, width, height, 2, groupsEnemy, groupsOwn, deadline);
  if (!enemy) return null;
  const ownDistance = distances(board, width, height, 1, deadline);
  if (!ownDistance) return null;
  const enemyDistance = distances(board, width, height, 2, deadline);
  if (!enemyDistance) return null;

  const ownEdge = distancesFromEdge(board, width, height, 2, deadline);
  const enemyEdge = distancesFromEdge(board, width, height, 1, deadline);
  if (!ownEdge || !enemyEdge) return null;
  const ownExitDistance = closestGroupExits(own, ownEdge, deadline);
  const enemyExitDistance = closestGroupExits(enemy, enemyEdge, deadline);
  if (!ownExitDistance || !enemyExitDistance) return null;

  const influence = { own: 0, enemy: 0, neutral: 0 };
  let free = 0;
  let safeOwn = 0;
  let safeEnemy = 0;
  for (let index = 0; index < board.length; index++) {
    if ((index & 255) === 0 && performance.now() >= deadline) return null;
    if (board[index] !== 0) continue;
    free++;
    safeOwn += Number(!threats.enemy[index]);
    safeEnemy += Number(!threats.ours[index]);
    const a = ownDistance[index];
    const b = enemyDistance[index];
    if (a >= 0 && (b < 0 || a < b)) influence.own++;
    else if (b >= 0 && (a < 0 || b < a)) influence.enemy++;
    else influence.neutral++;
  }
  const density = 1 - free / board.length;
  const phase = free <= 12 || density >= 0.8 ? 'endgame' : density < 0.12 ? 'opening' : 'middle';
  return {
    own, enemy, influence, free, safeOwn, safeEnemy,
    safeParity: { own: safeOwn % 2, enemy: safeEnemy % 2 },
    phase, ownDistance, enemyDistance, ownExitDistance, enemyExitDistance, threats,
  };
}
