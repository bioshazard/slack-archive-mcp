import { Effect, Layer } from "effect";
import { errorMessage, QueryError } from "../../domain/errors.ts";
import { ArchiveReader } from "../../ports/reader.ts";
import { Archive } from "./reader.ts";

export interface ReaderLocation {
  readonly databasePath?: string;
  readonly archiveDir?: string;
}

export function sqliteReader(location: ReaderLocation) {
  return Layer.effect(
    ArchiveReader,
    Effect.gen(function* () {
      const archive = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) =>
            location.databasePath
              ? Archive.openDatabase(location.databasePath, signal)
              : Archive.open(location.archiveDir),
          catch: (cause) =>
            new QueryError({ message: errorMessage(cause), cause }),
        }),
        (archive) => Effect.sync(() => archive.close()),
      );
      const query = <A>(name: string, run: () => A) =>
        Effect.try({
          try: run,
          catch: (cause) =>
            new QueryError({ message: errorMessage(cause), cause }),
        }).pipe(Effect.withSpan(name));
      return ArchiveReader.of({
        status: query("archive.status", () => archive.status()),
        channels: (options) =>
          query("archive.channels", () => archive.channels(options)),
        search: (options) =>
          query("archive.search", () => archive.search(options)),
        message: (id, options) =>
          query("archive.message", () => archive.message(id, options)),
        thread: (id, options) =>
          query("archive.thread", () => archive.thread(id, options)),
        context: (id, options) =>
          query("archive.context", () => archive.context(id, options)),
      });
    }),
  );
}
