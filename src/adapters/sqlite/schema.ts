import type { Database } from "bun:sqlite";
import { SCHEMA_VERSION } from "../../domain/model.ts";

export function createSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA user_version = ${SCHEMA_VERSION};
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE source_exports (
      name TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_files (
      id INTEGER PRIMARY KEY, export_name TEXT NOT NULL REFERENCES source_exports(name),
      path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
      kind TEXT NOT NULL, records INTEGER NOT NULL DEFAULT 0,
      UNIQUE(export_name, path)
    ) STRICT;
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE channel_aliases (
      channel_id TEXT NOT NULL REFERENCES channels(id), name TEXT NOT NULL,
      PRIMARY KEY(channel_id, name)
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY, message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id), ts TEXT NOT NULL,
      ts_order TEXT NOT NULL, version_order TEXT NOT NULL,
      thread_ts TEXT, author_id TEXT, subtype TEXT, deleted INTEGER NOT NULL,
      text TEXT NOT NULL, search_text TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
      raw_json TEXT NOT NULL, source_file_id INTEGER NOT NULL REFERENCES source_files(id),
      source_index INTEGER NOT NULL, UNIQUE(source_file_id, source_index)
    ) STRICT;
    CREATE TABLE rejected_records (
      id INTEGER PRIMARY KEY, source_file_id INTEGER NOT NULL REFERENCES source_files(id),
      source_index INTEGER NOT NULL, reason TEXT NOT NULL, raw_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL REFERENCES channels(id), ts TEXT NOT NULL,
      ts_order TEXT NOT NULL, thread_ts TEXT, author_id TEXT, subtype TEXT,
      deleted INTEGER NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES observations(id),
      UNIQUE(channel_id, ts)
    ) STRICT;
    CREATE INDEX observations_message ON observations(message_id);
    CREATE INDEX rejected_records_source ON rejected_records(source_file_id);
    CREATE INDEX messages_channel_time ON messages(channel_id, ts_order, id);
    CREATE INDEX messages_thread ON messages(channel_id, thread_ts, ts_order);
    CREATE INDEX messages_author ON messages(author_id);
    CREATE VIRTUAL TABLE message_fts USING fts5(
      search_text, content='messages', content_rowid='rowid', tokenize='unicode61'
    );
  `);
}

export function materialize(db: Database): void {
  db.exec(`
    INSERT INTO messages(id, channel_id, ts, ts_order, thread_ts, author_id,
      subtype, deleted, text, search_text, observation_id)
    SELECT message_id, channel_id, ts, ts_order, thread_ts, author_id,
      subtype, deleted, text, search_text, id FROM (
        SELECT o.*, row_number() OVER (
          PARTITION BY o.message_id
          ORDER BY o.version_order DESC, e.ordinal DESC, f.path DESC, o.source_index DESC
        ) AS preference
        FROM observations o JOIN source_files f ON f.id=o.source_file_id
        JOIN source_exports e ON e.name=f.export_name
    ) WHERE preference=1;
    INSERT INTO message_fts(rowid, search_text)
      SELECT rowid, search_text FROM messages WHERE deleted=0;
    INSERT INTO message_fts(message_fts) VALUES ('optimize');
    INSERT INTO message_fts(message_fts) VALUES ('integrity-check');
    ANALYZE;
  `);
}

export function validateDatabase(db: Database): void {
  const integrity = db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  if (db.query("PRAGMA foreign_key_check").all().length) {
    throw new Error("SQLite foreign-key check failed");
  }
  const mismatch = db
    .query<{ n: number }, []>(`
    SELECT count(*) AS n FROM source_files f WHERE f.kind='messages' AND f.records !=
      (SELECT count(*) FROM observations o WHERE o.source_file_id=f.id) +
      (SELECT count(*) FROM rejected_records r WHERE r.source_file_id=f.id)
  `)
    .get();
  if (mismatch?.n) throw new Error("Source record accounting failed");
  const canonical = db
    .query<{ n: number }, []>(`
    SELECT
      (SELECT count(*) FROM messages) !=
      (SELECT count(DISTINCT message_id) FROM observations) AS n
  `)
    .get();
  if (canonical?.n) throw new Error("Canonical message accounting failed");
  const identities = db
    .query<{ n: number }, []>(`
    SELECT count(*) AS n FROM messages m JOIN observations o ON o.id=m.observation_id
    WHERE m.id!=o.message_id OR m.channel_id!=o.channel_id OR m.ts!=o.ts
  `)
    .get();
  if (identities?.n) throw new Error("Canonical message identity mismatch");
  const search = db
    .query<{ n: number }, []>(`
    SELECT
      (SELECT count(*) FROM message_fts_docsize) !=
      (SELECT count(*) FROM messages WHERE deleted=0) AS n
  `)
    .get();
  if (search?.n) throw new Error("Full-text index accounting failed");
}
