import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

const compress = promisify(deflateRaw);
const ZIP_LIMIT_BYTES = 100 * 1024 * 1024;
const UTF8 = 0x0800;
const DEFLATE = 8;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

export class ZipLimitError extends Error {}

export function gameFilename(id, used) {
  const stem = Array.from(id.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '_')).slice(0, 100).join('') || 'партия';
  let name = stem + '.json';
  for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${stem}_${suffix}.json`;
  used.add(name.toLowerCase());
  return name;
}

export async function createZip(entries, maxBytes = ZIP_LIMIT_BYTES) {
  const local = [];
  const directory = [];
  let uncompressed = 0;
  let offset = 0;
  let directorySize = 0;
  const count = entries.length;
  if (count > 0xffff) throw new ZipLimitError();

  for (const { name, document } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const json = JSON.stringify(document, null, 2);
    uncompressed += Buffer.byteLength(json);
    if (uncompressed > maxBytes || filename.length > 0xffff) throw new ZipLimitError();
    const body = Buffer.from(json);
    const packed = await compress(body);
    const checksum = crc32(body);

    // Локальный заголовок и соответствующая запись центрального каталога ZIP.
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(0x21, 12); // 1 января 1980, минимальная дата DOS.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    local.push(header, filename, packed);
    directory.push(central, filename);
    offset += header.length + filename.length + packed.length;
    directorySize += central.length + filename.length;
    if (offset + directorySize + 22 > maxBytes) throw new ZipLimitError();
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return { chunks: [...local, ...directory, end], length: offset + directorySize + end.length };
}
