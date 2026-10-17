import { resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { sqliteReader } from "./adapters/sqlite/query-layer.ts";
import { verifyStandaloneDatabase } from "./adapters/sqlite/verification.ts";
import { DEFAULT_ZIP_LIMITS } from "./adapters/storage/zip.ts";
import { errorMessage, SnapshotError } from "./domain/errors.ts";
import { ingestEffect, verifySnapshot } from "./ingest.ts";
import { ArchiveReader } from "./ports/reader.ts";

const optional = (name: string) => Flag.String(name).pipe(Flag.optional);
const root = Command.make("slack-archive-mcp").pipe(
  Command.withDescription(
    "Materialize overlapping Slack exports into a portable searchable SQLite archive",
  ),
  Command.withSharedFlags({
    root: Flag.String("root").pipe(Flag.withDefault(process.cwd())),
    archiveDir: optional("archive-dir"),
    sqlitePath: optional("sqlite-path"),
  }),
);
const location = Effect.gen(function* () {
  const flags = yield* root;
  if (Option.isSome(flags.archiveDir) && Option.isSome(flags.sqlitePath)) {
    return yield* new SnapshotError({
      message: "Choose --sqlite-path or --archive-dir",
    });
  }
  const directory = yield* Config.String("ARCHIVE_DIR").pipe(
    Config.withDefault(""),
  );
  const database = yield* Config.String("ARCHIVE_SQLITE_PATH").pipe(
    Config.withDefault(""),
  );
  const archiveDir = resolve(
    Option.getOrUndefined(flags.archiveDir) ??
      (directory || `${flags.root}/.archive`),
  );
  const databasePath =
    Option.getOrUndefined(flags.sqlitePath) ??
    (Option.isSome(flags.archiveDir) ? undefined : database || undefined);
  return { root: resolve(flags.root), archiveDir, databasePath };
});
const print = (output: unknown) => Console.log(JSON.stringify(output, null, 2));
const ingest = Command.make(
  "ingest",
  {
    sources: Argument.String("sources").pipe(Argument.variadic()),
    workspace: optional("workspace"),
    sourceS3: optional("source-s3"),
    publishS3: optional("publish-s3"),
    zipMaxArchiveBytes: Flag.Int("zip-max-archive-bytes").pipe(
      Flag.withDefault(DEFAULT_ZIP_LIMITS.maxArchiveBytes),
    ),
    zipMaxEntries: Flag.Int("zip-max-entries").pipe(
      Flag.withDefault(DEFAULT_ZIP_LIMITS.maxEntries),
    ),
    zipMaxEntryBytes: Flag.Int("zip-max-entry-bytes").pipe(
      Flag.withDefault(DEFAULT_ZIP_LIMITS.maxEntryBytes),
    ),
    zipMaxTotalBytes: Flag.Int("zip-max-json-bytes").pipe(
      Flag.withDefault(DEFAULT_ZIP_LIMITS.maxTotalBytes),
    ),
  },
  Effect.fn("cli.ingest")(function* (flags) {
    const loc = yield* location;
    const result = yield* ingestEffect({
      root: loc.root,
      archiveDir: loc.archiveDir,
      sources: flags.sources,
      workspace: Option.getOrUndefined(flags.workspace),
      sourceS3: Option.getOrUndefined(flags.sourceS3),
      publishS3: Option.getOrUndefined(flags.publishS3),
      progress: (message) => console.error(message),
      zipLimits: {
        maxArchiveBytes: flags.zipMaxArchiveBytes,
        maxEntries: flags.zipMaxEntries,
        maxEntryBytes: flags.zipMaxEntryBytes,
        maxTotalBytes: flags.zipMaxTotalBytes,
      },
    });
    yield* print({
      ...result.manifest,
      databasePath: result.databasePath,
      reused: result.reused,
    });
  }),
);
const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.variadic({ min: 1 })),
    channel: optional("channel"),
    author: optional("author"),
    after: optional("after"),
    before: optional("before"),
    mode: Flag.Literals("mode", ["all", "any", "phrase", "exact"]).pipe(
      Flag.withDefault("all"),
    ),
    sort: Flag.Literals("sort", ["relevance", "oldest", "newest"]).pipe(
      Flag.withDefault("relevance"),
    ),
    prefix: Flag.Boolean("prefix").pipe(Flag.withDefault(false)),
    limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
    offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
  },
  Effect.fn("cli.search")(function* (flags) {
    const loc = yield* location;
    const result = yield* ArchiveReader.use((reader) =>
      reader.search({
        query: flags.query.join(" "),
        channel: Option.getOrUndefined(flags.channel),
        author: Option.getOrUndefined(flags.author),
        after: Option.getOrUndefined(flags.after),
        before: Option.getOrUndefined(flags.before),
        mode: flags.mode,
        sort: flags.sort,
        prefix: flags.prefix,
        limit: flags.limit,
        offset: flags.offset,
      }),
    ).pipe(Effect.provide(sqliteReader(loc)));
    yield* print(result);
  }),
);
const status = Command.make(
  "status",
  {},
  Effect.fn("cli.status")(function* () {
    const loc = yield* location;
    yield* print(
      yield* ArchiveReader.use((reader) => reader.status).pipe(
        Effect.provide(sqliteReader(loc)),
      ),
    );
  }),
);
const verify = Command.make(
  "verify",
  {},
  Effect.fn("cli.verify")(function* () {
    const loc = yield* location;
    const manifest = yield* Effect.tryPromise({
      try: () =>
        loc.databasePath
          ? verifyStandaloneDatabase(loc.databasePath)
          : verifySnapshot(loc.archiveDir),
      catch: (cause) =>
        new SnapshotError({ message: errorMessage(cause), cause }),
    });
    yield* print({ verified: true, ...manifest });
  }),
);
const command = root.pipe(
  Command.withSubcommands([ingest, search, status, verify]),
);
export const cliEffect = (args: readonly string[]) =>
  Command.runWith(command, { version: "2.1.0" })(args).pipe(
    Effect.provide(BunServices.layer),
  );
export function main(args = process.argv.slice(2)) {
  return Effect.runPromise(cliEffect(args));
}
if (import.meta.main) {
  BunRuntime.runMain(
    cliEffect(process.argv.slice(2)).pipe(
      Effect.tapError((error) => Console.error(errorMessage(error))),
    ),
    { disableErrorReporting: true },
  );
}
