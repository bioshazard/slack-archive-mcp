import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Zip, ZipDeflate, type Zippable, zipSync } from "fflate";

export async function exportZip(
  directory: string,
  path: string,
  prefix = "",
  level: 0 | 6 = 6,
) {
  const files: Record<string, Uint8Array> = {};
  async function walk(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        files[`${prefix}${relative(directory, path)}`] = await readFile(path);
    }
  }
  await walk(directory);
  const bytes = zipSync(files, {
    level,
    mtime: new Date("2024-01-01T00:00:00Z"),
  });
  await writeFile(path, bytes);
  return bytes;
}

export function syntheticZip(files: Zippable) {
  return zipSync(files, { level: 0, mtime: new Date("2024-01-01T00:00:00Z") });
}

export function descriptorZip(files: Record<string, Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const writer = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of Object.entries(files)) {
    const file = new ZipDeflate(name, { level: 6 });
    file.mtime = new Date("2024-01-01T00:00:00Z");
    writer.add(file);
    file.push(bytes, true);
  }
  writer.end();
  return Buffer.concat(chunks);
}

export function zip64(bytes: Uint8Array) {
  const source = Buffer.from(bytes);
  const end = source.length - 22;
  const extended = Buffer.alloc(56);
  extended.writeUInt32LE(0x06064b50, 0);
  extended.writeBigUInt64LE(44n, 4);
  extended.writeUInt16LE(45, 12);
  extended.writeUInt16LE(45, 14);
  const count = BigInt(source.readUInt16LE(end + 10));
  extended.writeBigUInt64LE(count, 24);
  extended.writeBigUInt64LE(count, 32);
  extended.writeBigUInt64LE(BigInt(source.readUInt32LE(end + 12)), 40);
  extended.writeBigUInt64LE(BigInt(source.readUInt32LE(end + 16)), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  const sentinel = Buffer.from(source.subarray(end));
  sentinel.writeUInt16LE(0xffff, 8);
  sentinel.writeUInt16LE(0xffff, 10);
  sentinel.writeUInt32LE(0xffffffff, 12);
  sentinel.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([source.subarray(0, end), extended, locator, sentinel]);
}

// Change central-directory names/flags/attributes without the fixture writer's
// validation preventing deliberately malformed input.
export function patchCentral(
  bytes: Uint8Array,
  patch: (buffer: Buffer, offset: number, index: number) => void,
) {
  const buffer = Buffer.from(bytes);
  let count = 0;
  for (let offset = 0; offset + 46 <= buffer.length; offset++) {
    if (buffer.readUInt32LE(offset) === 0x02014b50) {
      patch(buffer, offset, count++);
    }
  }
  return buffer;
}
