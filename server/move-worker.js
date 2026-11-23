import { parentPort, workerData } from 'node:worker_threads';
import { chooseMove } from '../bot/index.js';

parentPort.postMessage(chooseMove(workerData));
