import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { errorMessage, SourceError } from "../../domain/errors.ts";
import { sha256 } from "../../domain/model.ts";
import { fileKind, sourceExport, verifyBytes } from "../../domain/source.ts";
import { type ExportFile, Exports } from "../../ports/exports.ts";
import { localZipInput, makeZipCatalog, type ZipLimits } from "./zip.ts";

export interface LocalExportOptions {
  readonly root: string;
  readonly zipLimits?: Partial<ZipLimits>;
  readonly sources?: readonly string[];
  readonly archiveDir: string;
  readonly progress?: (message: string) => void;
}

export function localExports(options: LocalExportOptions) {
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new SourceError({ message: errorMessage(cause), cause }),
    });
  return Layer.effect(
    Exports,
    Effect.gen(function* () {
      const zip = yield* makeZipCatalog(options.zipLimits);
      const inventory = Effect.fn("localExports.inventory")(function* () {
        const directories = options.sources?.length
          ? options.sources.map((p) => resolve(options.root, p))
          : (yield* io(() => readdir(options.root, { withFileTypes: true })))
              .filter(
                (e) =>
                  (e.isDirectory() && e.name.startsWith("data-")) ||
                  (e.isFile() && /\.zip$/i.test(e.name)),
              )
              .map((e) => join(options.root, e.name))
              .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
        if (
          directories.some(
            (p) =>
              options.archiveDir === p ||
              options.archiveDir.startsWith(`${p}/`),
          )
        ) {
          return yield* new SourceError({
            message: "Archive output must be outside source export directories",
          });
        }
        return yield* Effect.forEach(
          directories,
          Effect.fnUntraced(function* (directory, ordinal) {
            options.progress?.(`Inventory ${basename(directory)}`);
            const info = yield* io(() => lstat(directory));
            if (info.isSymbolicLink())
              return yield* new SourceError({
                message: `Symlink in export: ${directory}`,
              });
            if (info.isFile() && /\.zip$/i.test(directory))
              return yield* zip.load(localZipInput(directory), ordinal);
            if (!info.isDirectory())
              return yield* new SourceError({
                message: `Expected an export directory or .zip file: ${directory}`,
              });
            const files: ExportFile[] = [];
            const walk = Effect.fnUntraced(function* (
              current: string,
            ): Effect.fn.Return<void, SourceError> {
              const entries = yield* io(() =>
                readdir(current, { withFileTypes: true }),
              );
              for (const entry of entries) {
                const locator = join(current, entry.name);
                if (entry.isSymbolicLink())
                  return yield* new SourceError({
                    message: `Symlink in export: ${locator}`,
                  });
                if (entry.isDirectory()) yield* walk(locator);
                else if (entry.isFile() && entry.name.endsWith(".json")) {
                  const bytes = yield* io(() => readFile(locator));
                  const path = relative(directory, locator);
                  files.push({
                    locator,
                    path,
                    sha256: sha256(bytes),
                    bytes: bytes.length,
                    kind: fileKind(path),
                  });
                }
              }
            });
            yield* walk(directory);
            return yield* Effect.try({
              try: () => sourceExport(basename(directory), ordinal, files),
              catch: (cause) =>
                new SourceError({ message: errorMessage(cause), cause }),
            });
          }),
        );
      });
      const read = Effect.fn("localExports.read")(function* (file: ExportFile) {
        if (zip.has(file)) return yield* zip.read(file);
        const bytes = yield* io(() => readFile(file.locator));
        return yield* verifyBytes(file, bytes);
      });
      return Exports.of({ inventory: inventory(), read });
    }),
  );
}
