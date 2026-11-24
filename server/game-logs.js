import { appendFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_PENDING = 1024;
const COLORS = ['red', 'blue'];

// Явный список игровых полей: исходный запрос и заголовки не сериализуются.
export function trainingRecord({ request, mode, move, fallback, receivedAt, durationMs, status }, runId, botVersion) {
  if (status !== 200 || !request || !move) return null;
  const { width, height } = request.field;
  const coordinates = (points) => Array.isArray(points) ? points.filter((point) =>
    Array.isArray(point) && point.length === 2 && point.every(Number.isSafeInteger) &&
    point[0] >= 0 && point[0] < width && point[1] >= 0 && point[1] < height)
    .map(([x, y]) => [x, y]) : [];
  const points = Object.fromEntries(COLORS.map((color) => [color, coordinates(request.points[color])]));
  const dead = Object.fromEntries(COLORS.map((color) => [color, coordinates(request.dead?.[color])]));
  return {
    schemaVersion: 1,
    // Все позиции этой группы держать в одном split при обучении.
    episodeId: createHash('sha256').update(`${runId}\0${request.gameId}`).digest('hex'),
    runId, gameId: request.gameId, moveNo: request.moveNo, receivedAt,
    position: { you: request.you, field: { width, height }, points, dead,
      last: request.last == null ? null : coordinates([request.last])[0] ?? null },
    target: { action: move.y * width + move.x, outcome: null },
    source: { kind: 'teacher', botVersion,
      mode: ['check', 'practice', 'round'].includes(mode) ? mode : 'unknown', fallback: Boolean(fallback) },
    response: { x: move.x, y: move.y }, durationMs,
  };
}

/** Запись после HTTP-ответа; ошибки диска не ломают выбор хода. */
export function createGameLogs({ directory, botVersion, maxPending = MAX_PENDING } = {}) {
  const runId = randomUUID();
  let pending = 0;
  let written = 0;
  let errors = 0;
  let dropped = 0;
  let tail = Promise.resolve();
  return {
    record(event) {
      if (!directory) return;
      if (pending >= maxPending) { dropped += 1; return; }
      const record = trainingRecord(event, runId, botVersion);
      if (!record) return;
      const day = new Date(record.receivedAt).toISOString().slice(0, 10);
      const line = JSON.stringify(record) + '\n';
      pending += 1;
      tail = tail.then(async () => {
        await mkdir(directory, { recursive: true });
        await appendFile(path.join(directory, `${day}.jsonl`), line, { encoding: 'utf8', mode: 0o600 });
        written += 1;
      }).catch(() => {
        errors += 1;
      }).finally(() => { pending -= 1; });
    },
    flush() { return tail; },
    status() { return { enabled: Boolean(directory), pending, written, errors, dropped }; },
  };
}
