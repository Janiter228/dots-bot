import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

// Выгрузка через SSH/docker exec, не публичный HTTP endpoint.
const directory = process.env.GAME_LOG_DIR;
if (!directory) {
  console.error('Задайте GAME_LOG_DIR — папку архива игр.');
  process.exitCode = 1;
} else {
  try {
    const files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
    for (const file of files) {
      await pipeline(createReadStream(path.join(directory, file)), process.stdout, { end: false });
    }
  } catch {
    console.error('Не удалось прочитать архив игр. Проверьте наличие папки и права доступа.');
    process.exitCode = 1;
  }
}
