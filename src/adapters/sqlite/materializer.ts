import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { Effect, Layer, Schema } from "effect";
import {
  errorMessage,
  MaterializationError,
  SourceError,
} from "../../domain/errors.ts";
import {
  IMPORTER_VERSION,
  object,
  SCHEMA_VERSION,
  timestampIso,
} from "../../domain/model.ts";
import { normalizeObservation } from "../../domain/normalize.ts";
import { summarizeSources } from "../../domain/source.ts";
import {
  type ExportFile,
  Exports,
  type SourceExport,
} from "../../ports/exports.ts";
import { Materializer } from "../../ports/materializer.ts";
import { createSchema, materialize, validateDatabase } from "./schema.ts";

const readVerified = Effect.fnUntraced(function* (
  exports: Exports["Service"],
  file: ExportFile,
) {
  const bytes = yield* exports.read(file);
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(
      (cause) =>
        new SourceError({ message: `Malformed JSON: ${file.path}`, cause }),
    ),
  );
});
function rows(value: unknown, _description: string): unknown[] {
  return Schema.decodeUnknownSync(Schema.Array(Schema.Unknown), {
    errors: "all",
  })(value).slice();
}
const importSource = Effect.fn("sqlite.importSource")(function* (
  db: Database,
  source: SourceExport,
  workspace: string,
  warnings: Set<string>,
) {
  const exports = yield* Exports;
  const channels = new Map<string, string>();
  const users = new Map<string, string>();
  const channelInsert = db.query(`INSERT INTO channels VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, raw_json=excluded.raw_json`);
  const aliasInsert = db.query(
    "INSERT OR IGNORE INTO channel_aliases VALUES (?, ?)",
  );
  const userInsert = db.query(`INSERT INTO users VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, raw_json=excluded.raw_json`);
  for (const file of source.files.filter((f) =>
    /^(channels|groups|dms|mpims|users)\.json$/.test(f.path),
  )) {
    for (const row of rows(yield* readVerified(exports, file), file.path)) {
      if (!object(row) || typeof row.id !== "string")
        throw new Error(
          `Invalid metadata record in ${source.name}/${file.path}`,
        );
      if (file.path === "users.json") {
        const profile = object(row.profile) ? row.profile : {};
        const name = [
          profile.display_name,
          profile.real_name,
          row.real_name,
          row.name,
          row.id,
        ].find((v) => typeof v === "string" && v.length) as string;
        users.set(row.id, name);
        userInsert.run(row.id, name, JSON.stringify(row));
      } else {
        const name = typeof row.name === "string" ? row.name : row.id;
        channels.set(name, row.id);
        channels.set(row.id, row.id);
        channelInsert.run(row.id, name, JSON.stringify(row));
        aliasInsert.run(row.id, name);
      }
    }
  }
  const fileInsert = db.query(
    "INSERT INTO source_files(export_name,path,sha256,bytes,kind,records) VALUES (?,?,?,?,?,?) RETURNING id",
  );
  const observationInsert = db.query(`INSERT INTO observations(
    message_id,channel_id,ts,ts_order,version_order,thread_ts,author_id,subtype,deleted,
    text,search_text,payload_sha256,raw_json,source_file_id,source_index)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rejectedInsert = db.query(
    "INSERT INTO rejected_records(source_file_id,source_index,reason,raw_json) VALUES (?,?,?,?)",
  );
  for (const file of source.files) {
    const value = yield* readVerified(exports, file);
    const records = file.kind === "messages" ? rows(value, file.path) : [];
    const fileRow = fileInsert.get(
      source.name,
      file.path,
      file.sha256,
      file.bytes,
      file.kind,
      records.length,
    ) as { id: number };
    if (file.kind !== "messages") continue;
    const folder = dirname(file.path);
    let channel = channels.get(folder);
    if (!channel) {
      // Slack file-conversation folders embed a stable file ID before the title.
      channel = /^FC:[^:]+:/.test(folder)
        ? folder.split(":").slice(0, 2).join(":")
        : `unmapped:${folder}`;
      warnings.add(
        `Conversation metadata unavailable: ${source.name}/${folder}; identity=${channel}`,
      );
      channelInsert.run(
        channel,
        folder,
        JSON.stringify({ id: channel, name: folder, inferred: true }),
      );
      aliasInsert.run(channel, folder);
      channels.set(folder, channel);
    }
    db.transaction(() => {
      for (const [index, record] of records.entries()) {
        const observation = normalizeObservation(
          record,
          workspace,
          channel,
          users,
        );
        if (observation._tag === "Rejected") {
          rejectedInsert.run(
            fileRow.id,
            index,
            observation.reason,
            observation.rawJson,
          );
          continue;
        }
        observationInsert.run(
          observation.id,
          observation.channel,
          observation.ts,
          observation.tsOrder,
          observation.versionOrder,
          observation.threadTs,
          observation.author,
          observation.subtype,
          observation.deleted,
          observation.text,
          observation.searchText,
          observation.payloadSha256,
          observation.rawJson,
          fileRow.id,
          index,
        );
      }
    })();
  }
});

export const sqliteMaterializer = Layer.succeed(
  Materializer,
  Materializer.of({
    build: Effect.fn("sqlite.materialize")(
      function* (options) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const db = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  new Database(options.databasePath, {
                    create: true,
                    strict: true,
                  }),
                catch: (cause) =>
                  new MaterializationError({
                    message: errorMessage(cause),
                    cause,
                  }),
              }),
              (db) => Effect.sync(() => db.close(true)),
            );
            createSchema(db);
            db.exec("BEGIN IMMEDIATE");
            db.query("INSERT INTO metadata VALUES ('generation', ?)").run(
              options.generation,
            );
            db.query("INSERT INTO metadata VALUES ('workspace', ?)").run(
              options.workspace,
            );
            const warnings = new Set<string>();
            for (const source of options.sources) {
              db.query("INSERT INTO source_exports VALUES (?, ?, ?)").run(
                source.name,
                source.ordinal,
                source.sha256,
              );
              yield* importSource(db, source, options.workspace, warnings);
            }
            materialize(db);
            validateDatabase(db);
            db.exec("COMMIT");
            const count = (sql: string) =>
              db.query<{ n: number }, []>(sql).get()?.n ?? 0;
            const range = db
              .query<{ first: string | null; last: string | null }, []>(`SELECT
        (SELECT ts FROM messages ORDER BY ts_order,id LIMIT 1) AS first,
        (SELECT ts FROM messages ORDER BY ts_order DESC,id LIMIT 1) AS last`)
              .get();
            const counts = {
              exports: options.sources.length,
              files: options.sources.reduce((n, s) => n + s.files.length, 0),
              observations: count("SELECT count(*) AS n FROM observations"),
              messages: count("SELECT count(*) AS n FROM messages"),
              rejected: count("SELECT count(*) AS n FROM rejected_records"),
              conflicts: count(
                "SELECT count(*) AS n FROM (SELECT message_id FROM observations GROUP BY message_id HAVING count(DISTINCT payload_sha256)>1)",
              ),
              deleted: count(
                "SELECT count(*) AS n FROM messages WHERE deleted=1",
              ),
              missingThreadParents: count(
                "SELECT count(*) AS n FROM messages m WHERE m.thread_ts IS NOT NULL AND m.thread_ts!=m.ts AND NOT EXISTS(SELECT 1 FROM messages p WHERE p.channel_id=m.channel_id AND p.ts=m.thread_ts)",
              ),
            };
            if (!counts.messages)
              return yield* new MaterializationError({
                message: "Import produced no valid messages",
              });
            if (counts.rejected)
              warnings.add(
                `${counts.rejected} records quarantined in rejected_records`,
              );
            if (counts.missingThreadParents)
              warnings.add(
                `${counts.missingThreadParents} messages reference an unavailable thread parent`,
              );
            const built = {
              counts,
              coverage: {
                first: range?.first ? timestampIso(range.first) : null,
                last: range?.last ? timestampIso(range.last) : null,
              },
              warnings: [...warnings].sort(),
            };
            // Portable metadata excludes the database hash to avoid self-reference.
            db.query("INSERT INTO metadata VALUES ('snapshot', ?)").run(
              JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                importerVersion: IMPORTER_VERSION,
                generation: options.generation,
                workspace: options.workspace,
                sources: summarizeSources(options.sources),
                ...built,
              }),
            );
            return built;
          }),
        );
      },
      Effect.catchDefect(
        (cause) =>
          new MaterializationError({ message: errorMessage(cause), cause }),
      ),
    ),
  }),
);
