const FINITE_PROFILES = ['tiny', 'small', 'standard'];

export function fieldProfile(field, free = Infinity, override) {
  if (field.infinite === true) return 'infinite';
  if (FINITE_PROFILES.includes(override)) return override;
  const largestSide = Math.max(field.width, field.height);
  if (largestSide <= 8 || free <= 60) return 'tiny';
  return largestSide <= 25 ? 'small' : 'standard';
}

// На самой верхней занятой строке свободная клетка всегда соединена с внешней областью.
export function infiniteFallback(points) {
  let top = Infinity;
  let row = new Set();
  for (const color of ['red', 'blue']) {
    for (const [x, y] of points[color]) {
      if (y < top) {
        top = y;
        row = new Set();
      }
      if (y === top) row.add(x);
    }
  }
  if (row.size === 0) return { x: 0, y: 0 };
  let x = 0;
  while (row.has(x)) x++;
  return { x, y: top };
}
