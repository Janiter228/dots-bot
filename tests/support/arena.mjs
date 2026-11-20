import { pathToFileURL } from 'node:url';

export async function loadArena() {
  if (!process.env.DOTS_ENGINE) {
    throw new Error('Укажите DOTS_ENGINE=/абсолютный/путь/dots.mjs — эталонный движок арены');
  }
  return import(pathToFileURL(process.env.DOTS_ENGINE).href);
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
