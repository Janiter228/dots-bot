import { chooseMove } from '../bot/index.js';
import { encodePosition, selectLegalMove } from './position.js';

/**
 * Не подключён к production: будущая точка интеграции модели.
 * predict(input) -> Promise<Array|Float32Array> или синхронный массив логитов.
 * Контроль времени должен оставаться снаружи, на уровне worker.
 */
export function createModelStrategy({ predict, fallback = chooseMove } = {}) {
  if (predict !== undefined && typeof predict !== 'function') {
    throw new TypeError('predict должен быть функцией');
  }
  if (typeof fallback !== 'function') throw new TypeError('fallback должен быть функцией');

  return async function chooseModelMove(request) {
    if (!predict) return fallback(request);
    let input;
    let move;
    try {
      input = encodePosition(request);
      if (!input.legalMask.includes(1)) return null;
      // Модель получает только представление поля, а не HTTP-запрос.
      // Отдельная маска защищает проверку результата от изменений адаптером.
      const validation = { ...input, legalMask: input.legalMask.slice() };
      move = selectLegalMove(await predict(input), validation);
    } catch {
      return fallback(request);
    }
    return move ?? fallback(request);
  };
}
