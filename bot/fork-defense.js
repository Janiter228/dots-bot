function scoreForOwn(board) {
  let score = 0;
  for (const cell of board) {
    if (cell === 4) score++;
    if (cell === 3) score--;
  }
  return score;
}

/**
 * Проверяет две или более угрозы соперника против каждого легального ответа.
 * simulate(board, index, color) возвращает доску после пересчёта захватов.
 * null означает, что доказательство не завершено в пределах бюджета.
 */
export function proveForkGain(board, attacker, closures, simulate, deadline) {
  if (closures.length < 2) return 0;
  const direction = attacker === 1 ? 1 : -1;
  const before = scoreForOwn(board);
  let damage = Infinity;
  for (let response = 0; response < board.length; response++) {
    if (board[response] !== 0) continue;
    if (performance.now() >= deadline) return null;
    const defended = simulate(board, response, 3 - attacker);
    let worst = -Infinity;
    for (const closure of closures) {
      if (defended[closure] !== 0) continue;
      if (performance.now() >= deadline) return null;
      const after = simulate(defended, closure, attacker);
      worst = Math.max(worst, direction * (scoreForOwn(after) - before));
    }
    if (worst <= 0) return 0;
    damage = Math.min(damage, worst);
  }
  return Number.isFinite(damage) ? damage : 0;
}

export function unavoidableForkLoss(board, closures, simulate, deadline) {
  return proveForkGain(board, 2, closures, simulate, deadline);
}
