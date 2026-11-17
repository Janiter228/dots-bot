// Базовая стратегия: выбираем свободную клетку рядом с последним ходом.
// Если это невозможно (например, первый ход или рядом всё занято),
// ищем другую свободную клетку. Живые и мёртвые точки одинаково заняты.

const DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, -1], [1, -1], [-1, 1],
];

export function chooseMove(request) {
  const { field, points, last } = request;
  const { width, height } = field;

  const busy = new Set(
    [...points.red, ...points.blue].map(([x, y]) => `${x},${y}`)
  );

  const isFree = (x, y) =>
    x >= 0 && y >= 0 && x < width && y < height && !busy.has(`${x},${y}`);

  // Сначала пробуем поставить точку рядом с последним ходом соперника.
  if (Array.isArray(last)) {
    const [lastX, lastY] = last;
    for (const [dx, dy] of DIRECTIONS) {
      const x = lastX + dx;
      const y = lastY + dy;
      if (isFree(x, y)) return { x, y };
    }
  } else {
    // На первом ходу начинаем из центра поля.
    const center = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
    if (isFree(center.x, center.y)) return center;
  }

  // Запасной вариант: ищем любую свободную клетку.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isFree(x, y)) return { x, y };
    }
  }

  return null;
}
