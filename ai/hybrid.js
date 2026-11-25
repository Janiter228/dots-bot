// Direct entry point for the paired match runner. HTTP workers use the same advisers.
import { readFileSync } from 'node:fs';
import { chooseMove as search } from '../bot/index.js';
import { adviser } from './local-advisers.js';

export function loadAdvice(mode) {
  if (!['hybrid', 'strategist', 'critic'].includes(mode)) return undefined;
  try {
    return adviser(JSON.parse(readFileSync(new URL('./weights.json', import.meta.url))), mode);
  } catch {
    return undefined;
  }
}
let matchAdvice;
export function chooseMove(request) {
  matchAdvice ??= loadAdvice('hybrid');
  return search(request, { advice: matchAdvice });
}
