import { Worker } from 'node:worker_threads';

export function computeMove(request, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./move-worker.js', import.meta.url), { workerData: request });
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
    const budget = Number.isFinite(request.moveTimeoutMs) ? request.moveTimeoutMs : 5000;
    timer = setTimeout(() => finish(new Error('Превышен лимит расчёта хода')), Math.max(1, Math.min(budget, 5000)));
    worker.once('message', move => finish(null, move));
    worker.once('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`Поток расчёта завершился без ответа (${code})`)));
  });
}
