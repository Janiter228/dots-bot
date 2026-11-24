function score(board) {
  let difference = 0;
  for (const cell of board) {
    if (cell === 3) difference--;
    if (cell === 4) difference++;
  }
  return difference;
}

function zobristKeys(length) {
  let state = 0x5665704d;
  return Uint32Array.from({ length: length * 5 + 1 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state;
  });
}

/**
 * Итеративное углубление по всем свободным клеткам. Оценка — разница
 * захваченных точек. Равные варианты упорядочены предыдущей итерацией.
 */
export function solveEndgame(board, simulate, deadline, maxFree = 9) {
  const free = Array.from(board.keys()).filter(index => board[index] === 0);
  if (free.length === 0 || free.length > maxFree || performance.now() >= deadline) return null;
  const keys = zobristKeys(board.length);
  const table = new Map();
  const interrupted = Symbol('deadline');
  let completed = null;

  function key(position, turn) {
    let hash = turn === 1 ? 0 : keys.at(-1);
    let identity = String(turn);
    for (let index = 0; index < position.length; index++) {
      hash ^= keys[index * 5 + position[index]];
      identity += position[index];
    }
    return { hash, identity };
  }

  function search(position, turn, depth, alpha, beta, remaining) {
    if (performance.now() >= deadline) throw interrupted;
    if (depth === 0 || remaining === 0) return { value: score(position), move: null };
    const { hash, identity } = key(position, turn);
    const entry = table.get(hash);
    const previous = entry?.identity === identity ? entry : null;
    if (previous?.depth === depth && (previous.bound === 'exact'
      || (previous.bound === 'lower' && previous.value >= beta)
      || (previous.bound === 'upper' && previous.value <= alpha))) return previous;
    const startAlpha = alpha;
    const startBeta = beta;

    const candidates = free.filter(index => position[index] === 0);
    const preferred = candidates.indexOf(previous?.move);
    if (preferred > 0) candidates.unshift(candidates.splice(preferred, 1)[0]);
    let value = turn === 1 ? -Infinity : Infinity;
    let move = null;
    for (const index of candidates) {
      const after = simulate(position, index, turn);
      const child = search(after, 3 - turn, depth - 1, alpha, beta, remaining - 1).value;
      if (turn === 1 ? child > value : child < value) {
        value = child;
        move = index;
      }
      if (turn === 1) alpha = Math.max(alpha, value);
      else beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    const bound = value <= startAlpha ? 'upper' : value >= startBeta ? 'lower' : 'exact';
    const result = { identity, depth, bound, value, move };
    table.set(hash, result);
    return result;
  }

  try {
    for (let depth = 1; depth <= free.length; depth++) {
      const { move, value } = search(board, 1, depth, -Infinity, Infinity, free.length);
      completed = { move, value, depth, solved: depth === free.length };
    }
  } catch (error) {
    if (error !== interrupted) throw error;
  }
  return completed;
}
