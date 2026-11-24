import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.js', import.meta.url));
let child;
let stopping = false;

function start() {
  child = fork(entry, { env: { ...process.env, DOTS_SUPERVISED: '1' } });
  child.once('error', error => {
    console.error('Не удалось запустить бота:', error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (!stopping && code === 75) start();
    else if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

start();
