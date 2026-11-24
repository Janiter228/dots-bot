// Версия контракта входа будущей модели, независимо от версии алгоритма.
export const INPUT_VERSION = 1;
export const PLANE_NAMES = Object.freeze(['own', 'opponent', 'ownDead', 'opponentDead', 'last']);

/**
 * Конечное поле: пять плоскостей Float32, порядок [plane][y][x].
 * Индекс действия: y * width + x. Мёртвые точки также занимают клетки.
 * Токены, заголовки и идентификаторы партии в представление не входят.
 */
export function encodePosition(request) {
  const { width, height, infinite } = request.field ?? {};
  if (infinite === true || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || !Number.isSafeInteger(width * height)) {
    throw new TypeError('Модель ожидает конечное поле положительного размера');
  }
  if (request.you !== 'red' && request.you !== 'blue') {
    throw new TypeError('Цвет модели должен быть red или blue');
  }

  const size = width * height;
  const planes = new Float32Array(PLANE_NAMES.length * size);
  const legalMask = new Uint8Array(size).fill(1);
  const indexOf = (point) => {
    if (!Array.isArray(point) || point.length !== 2 ||
        !Number.isSafeInteger(point[0]) || !Number.isSafeInteger(point[1]) ||
        point[0] < 0 || point[0] >= width || point[1] < 0 || point[1] >= height) {
      throw new TypeError('Координата модели вне поля');
    }
    return point[1] * width + point[0];
  };

  const opponent = request.you === 'red' ? 'blue' : 'red';
  for (const [plane, color] of [request.you, opponent].entries()) {
    if (!Array.isArray(request.points?.[color])) {
      throw new TypeError('Для модели нужны точки обоих цветов');
    }
    for (const point of request.points[color]) {
      const index = indexOf(point);
      planes[plane * size + index] = 1;
      legalMask[index] = 0;
    }
    for (const point of request.dead?.[color] ?? []) {
      const index = indexOf(point);
      planes[(plane + 2) * size + index] = 1;
      legalMask[index] = 0;
    }
  }
  if (request.last != null) planes[4 * size + indexOf(request.last)] = 1;

  return { version: INPUT_VERSION, width, height, planes, legalMask };
}

/** Логиты/оценки [y][x], без softmax. При равенстве выбирается меньший индекс. */
export function selectLegalMove(scores, { width, height, legalMask }) {
  if ((!Array.isArray(scores) && !ArrayBuffer.isView(scores)) ||
      scores.length !== width * height) {
    throw new TypeError('Число оценок модели должно совпадать с размером поля');
  }
  let best = -1;
  for (let index = 0; index < legalMask.length; index += 1) {
    if (legalMask[index] && Number.isFinite(scores[index]) &&
        (best === -1 || scores[index] > scores[best])) best = index;
  }
  return best === -1 ? null : { x: best % width, y: Math.floor(best / width) };
}
