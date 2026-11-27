export function responseLimit(value = process.env.MAX_RESPONSE_TIME_MS ?? '2000') {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647) {
    throw new RangeError('MAX_RESPONSE_TIME_MS должен быть целым от 1 до 2147483647');
  }
  return ms;
}

export function requestBudget(request, limit = responseLimit()) {
  return Math.max(0, Math.min(limit,
    Number.isFinite(request.moveTimeoutMs) ? request.moveTimeoutMs : Infinity,
    Number.isFinite(request.timeLeftMs) ? request.timeLeftMs : Infinity));
}

// Leave one event-loop turn and time for validating a dense board and writing JSON.
export function sendReserve(ms) {
  return Math.min(50, Math.ceil(ms * 0.1));
}
