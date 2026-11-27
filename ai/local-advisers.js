// Counts of live cardinal and diagonal neighbours, with an edge indicator.
// Only the board before the move is visible to either classifier.
export function features(index, width, height, at) {
  const x = index % width;
  const y = Math.floor(index / width);
  const counts = [0, 0, 0, 0, Number(x === 0 || y === 0 || x === width - 1 || y === height - 1)];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const cell = at(index + dy * width + dx);
      if (cell === 1 || cell === 2) counts[(dx && dy ? 2 : 0) + cell - 1]++;
    }
  }
  return counts;
}

export function probability(weights, values) {
  const logit = values.reduce((sum, value, i) => sum + weights[i + 1] * value, weights[0]);
  return 1 / (1 + Math.exp(-logit));
}

export function adviser(model, mode) {
  const valid = weights => Array.isArray(weights) && weights.length === 6 && weights.every(Number.isFinite);
  const policy = ['hybrid', 'strategist'].includes(mode) && valid(model?.policy);
  const risk = ['hybrid', 'critic'].includes(mode) && valid(model?.risk);
  if (!policy && !risk) return undefined;
  return (board, index, width, height) => {
    const values = features(index, width, height, i => board[i]);
    return (policy ? 12 * probability(model.policy, values) : 0)
      - (risk ? 18 * probability(model.risk, values) : 0);
  };
}
