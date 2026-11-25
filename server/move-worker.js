import { parentPort, workerData } from 'node:worker_threads';
import { chooseMove } from '../bot/index.js';

const { request, deadline } = workerData;
let advice;
if (['strategist', 'critic', 'hybrid'].includes(process.env.DOTS_AI_MODE)) {
  try {
    const { loadAdvice } = await import('../ai/hybrid.js');
    advice = loadAdvice(process.env.DOTS_AI_MODE);
  } catch {
    // The deployment may omit the entire ai directory.
  }
}
request.moveTimeoutMs = Math.max(0, deadline - performance.now());
const checkpoint = move => parentPort.postMessage({ move });
parentPort.postMessage({ final: true, move: chooseMove(request, { advice, checkpoint }) });
