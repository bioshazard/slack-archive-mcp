import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { Effect, Scope } from "effect";
import { type Entry, openPromise, type ZipFile } from "yauzl";
import { errorMessage, SourceError } from "../../domain/errors.ts";
import { sha256 } from "../../domain/model.ts";
import {
  type ExportFile,
  fileKind,
  sourceExport,
} from "../../domain/source.ts";

export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: 8 * 1024 ** 3,
  maxEntries: 100_000,
  maxEntryBytes: 256 * 1024 ** 2,
  maxTotalBytes: 8 * 1024 ** 3,
};
export interface ZipInput {
  readonly file: string;
  readonly stream: (signal: AbortSignal) => Promise<Readable>;
}
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SourceError({ message: errorMessage(cause), cause }),
  });

function validateEntry(entry: Entry) {
  const path = entry.fileName;
  const parts = path.replace(/\/$/, "").split("/");
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(path)}`);
  const type = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (type && ![0x8000, 0x4000].includes(type))
    throw new Error(`ZIP entry is a link or special file: ${path}`);
  if (entry.isEncrypted())
    throw new Error(`Encrypted ZIP entries are unsupported: ${path}`);
  const directory = path.endsWith("/") || type === 0x4000;
  return { path, directory };
}

async function readEntry(
  zip: ZipFile,
  entry: Entry,
  limit: number,
  signal: AbortSignal,
  collect: boolean,
) {
  const header = await zip.readLocalFileHeaderPromise(entry);
  if (
    !header.fileName.equals(entry.fileNameRaw) ||
    header.compressionMethod !== entry.compressionMethod ||
    header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
  )
    throw new Error(`ZIP local/central header mismatch: ${entry.fileName}`);
  if (!(entry.generalPurposeBitFlag & 8)) {
    if (header.crc32 !== entry.crc32)
      throw new Error(`ZIP local/central CRC-32 mismatch: ${entry.fileName}`);
    if (
      (header.compressedSize !== 0xffffffff &&
        header.compressedSize !== entry.compressedSize) ||
      (header.uncompressedSize !== 0xffffffff &&
        header.uncompressedSize !== entry.uncompressedSize)
    ) {
      throw new Error(`ZIP local/central size mismatch: ${entry.fileName}`);
    }
  }
  const stream = await zip.openReadStreamPromise(entry);
  const abort = () => stream.destroy(new Error("ZIP read aborted"));
  signal.addEventListener("abort", abort, { once: true });
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let checksum = 0;
  try {
    if (signal.aborted) throw new Error("ZIP read aborted");
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit)
        throw new Error(`ZIP entry exceeds byte limit: ${entry.fileName}`);
      hash.update(buffer);
      checksum = crc32(buffer, checksum);
      if (collect) chunks.push(buffer);
    }
    if (bytes !== entry.uncompressedSize)
      throw new Error(`ZIP entry size mismatch: ${entry.fileName}`);
    if (checksum !== entry.crc32)
      throw new Error(`ZIP CRC-32 mismatch: ${entry.fileName}`);
    return {
      bytes,
      sha256: hash.digest("hex"),
      data: collect ? Buffer.concat(chunks, bytes) : undefined,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    stream.destroy();
  }
}

// This catalog belongs to the source Layer's Scope. It never extracts paths.
export const makeZipCatalog = Effect.fn("zip.catalog")(function* (
  overrides: Partial<ZipLimits> = {},
) {
  const scope = yield* Effect.scope;
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      return yield* new SourceError({
        message: "ZIP limits must be positive safe integers",
      });
  }
  const entries = new Map<string, { zip: ZipFile; entry: Entry }>();
  const load = Effect.fn("zip.inventory")(
    function* (input: ZipInput, ordinal: number) {
      const temporary = yield* Effect.acquireRelease(
        attempt(() => mkdtemp(join(tmpdir(), "slack-archive-mcp-zip-"))),
        (directory) =>
          attempt(() => rm(directory, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
      );
      const staged = join(temporary, "source.zip");
      const digest = yield* attempt(async (signal) => {
        const source = await input.stream(signal);
        const hash = createHash("sha256");
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > limits.maxArchiveBytes) {
              callback(
                new Error("ZIP container exceeds compressed byte limit"),
              );
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          source,
          bounded,
          createWriteStream(staged, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        return { sha256: hash.digest("hex"), bytes };
      });
      const zip = yield* Effect.acquireRelease(
        attempt(() =>
          openPromise(staged, {
            autoClose: false,
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
          }),
        ),
        (zip) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                if (!zip.isOpen) {
                  resolve();
                  return;
                }
                zip.once("close", resolve);
                zip.close();
              }),
          ),
      );
      const selected = yield* attempt(async (signal) => {
        if (zip.entryCount > limits.maxEntries)
          throw new Error("ZIP exceeds entry count limit");
        const seen = new Set<string>();
        const json: Entry[] = [];
        let total = 0;
        let count = 0;
        for await (const entry of zip.eachEntry()) {
          if (signal.aborted) throw new Error("ZIP inventory aborted");
          if (++count > limits.maxEntries)
            throw new Error("ZIP exceeds entry count limit");
          const { path, directory } = validateEntry(entry);
          const canonical = path.replace(/\/$/, "");
          if (seen.has(canonical))
            throw new Error(`Duplicate ZIP entry path: ${path}`);
          seen.add(canonical);
          if (
            directory ||
            path.startsWith("__MACOSX/") ||
            !path.endsWith(".json")
          )
            continue;
          if (!entry.canDecodeFileData())
            throw new Error(`Unsupported ZIP compression method: ${path}`);
          if (entry.uncompressedSize > limits.maxEntryBytes)
            throw new Error(`ZIP entry exceeds byte limit: ${path}`);
          total += entry.uncompressedSize;
          if (total > limits.maxTotalBytes)
            throw new Error("ZIP exceeds total JSON byte limit");
          json.push(entry);
        }
        return json;
      });
      // Normalize one optional enclosing folder, but never guess among multiple exports.
      const first = selected[0]?.fileName.split("/")[0];
      const metadata = /^(?:channels|groups|users|dms|mpims)\.json$/;
      const entryPrefix =
        first &&
        selected.every((e) => e.fileName.startsWith(`${first}/`)) &&
        selected.some((e) => metadata.test(e.fileName.slice(first.length + 1)))
          ? `${first}/`
          : "";
      if (
        selected.some((e) => {
          const path = e.fileName.slice(entryPrefix.length);
          return (
            path.includes("/") &&
            metadata.test(path.slice(path.lastIndexOf("/") + 1))
          );
        })
      ) {
        return yield* new SourceError({
          message:
            "ZIP contains nested or multiple export roots; supply one Slack export per ZIP",
        });
      }
      const files: ExportFile[] = [];
      const token = crypto.randomUUID();
      for (const [index, entry] of selected.entries()) {
        const path = entry.fileName.slice(entryPrefix.length);
        const summary = yield* attempt((signal) =>
          readEntry(zip, entry, limits.maxEntryBytes, signal, false),
        );
        const locator = `zip:${token}:${index}`;
        entries.set(locator, { zip, entry });
        files.push({
          locator,
          path,
          sha256: summary.sha256,
          bytes: summary.bytes,
          kind: fileKind(path),
        });
      }
      return yield* Effect.try({
        try: () => ({
          ...sourceExport(
            basename(input.file).replace(/\.zip$/i, ""),
            ordinal,
            files,
          ),
          archive: {
            format: "zip" as const,
            file: basename(input.file),
            ...digest,
            entryPrefix,
          },
        }),
        catch: (cause) =>
          new SourceError({ message: errorMessage(cause), cause }),
      });
    },
    Effect.provideService(Scope.Scope, scope),
  );
  const read = Effect.fn("zip.read")(function* (file: ExportFile) {
    const selected = entries.get(file.locator);
    if (!selected)
      return yield* new SourceError({
        message: "ZIP entry is not part of this source catalog",
      });
    const result = yield* attempt((signal) =>
      readEntry(
        selected.zip,
        selected.entry,
        limits.maxEntryBytes,
        signal,
        true,
      ),
    );
    const bytes = result.data ?? Buffer.alloc(0);
    if (sha256(bytes) !== file.sha256)
      return yield* new SourceError({
        message: `ZIP entry changed: ${file.path}`,
      });
    return bytes;
  });
  return { load, read, has: (file: ExportFile) => entries.has(file.locator) };
});

export function localZipInput(path: string): ZipInput {
  return {
    file: basename(path),
    stream: async (signal) => createReadStream(path, { signal }),
  };
}
export function remoteZipInput(
  file: string,
  stream: (signal: AbortSignal) => Readable,
): ZipInput {
  return { file: basename(file), stream: async (signal) => stream(signal) };
}
