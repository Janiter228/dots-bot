// bot/index.js
// chooseMove(request) -> { x, y } или null (null = «не знаю», сервер поставит запасной ход)

export function chooseMove(request) {
  const { field, points, last } = request;

  // занято всё, что есть в points (живые и мёртвые точки)
  const busy = new Set(
    [...points.red, ...points.blue].map(([x, y]) => `${x},${y}`)
  );

  // v0: ставим точку рядом с последним ходом соперника
  if (last) {
    const [lx, ly] = last;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
      const x = lx + dx, y = ly + dy;
      const inside = x >= 0 && y >= 0 && x < field.width && y < field.height;
      if (inside && !busy.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}
