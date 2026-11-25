import { Worker } from 'node:worker_threads';
import { requestBudget, sendReserve } from '../bot/time-budget.js';

export function computeMove(request, signal, started = performance.now()) {
  if (signal.aborted) return Promise.reject(signal.reason);
  const budget = requestBudget(request);
  const deadline = started + budget - sendReserve(budget);
  const remaining = () => deadline - performance.now();
  if (remaining() <= 0) return Promise.reject(new Error('Исчерпан бюджет запроса'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./move-worker.js', import.meta.url), { workerData: { request, deadline } });
    let settled = false;
    let timer;
    const finish = (error, move) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      void worker.terminate();
      if (error) reject(error);
      else resolve(move);
    };
    const cancel = () => finish(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let candidate;
    timer = setTimeout(() => candidate ? finish(null, candidate) : finish(new Error('Превышен лимит расчёта хода')), Math.max(1, remaining()));
    worker.on('message', message => {
      if (message.final) finish(null, message.move);
      else candidate = message.move;
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`Поток расчёта завершился без ответа (${code})`)));
  });
}
