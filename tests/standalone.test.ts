import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { sqliteReader } from "../src/adapters/sqlite/query-layer.ts";
import { Archive } from "../src/adapters/sqlite/reader.ts";
import { ArchiveReader } from "../src/ports/reader.ts";
import { fixture } from "./fixture.ts";

test("a copied database works alone without originals, manifests or current.json", async () => {
  const f = await fixture();
  const directory = await mkdtemp(
    join(tmpdir(), "slack-archive-mcp-standalone-"),
  );
  const path = join(directory, "mounted.sqlite");
  try {
    await copyFile(f.databasePath, path);
    await rm(f.root, { recursive: true, force: true });
    const archive = await Archive.openDatabase(path);
    try {
      expect(archive.manifest.generation).toBe(f.manifest.generation);
      expect(archive.search({ query: "revised plan" }).results).toHaveLength(1);
      expect(archive.manifest.counts.messages).toBe(7);
      expect(() => archive.db.exec("DELETE FROM messages")).toThrow();
    } finally {
      archive.close();
    }
    const before = await readFile(path);
    const reader = await Effect.runPromise(
      ArchiveReader.pipe(Effect.provide(sqliteReader({ databasePath: path }))),
    );
    const closed = await Effect.runPromise(
      reader.search({ query: "plan" }).pipe(Effect.flip),
    );
    expect(closed._tag).toBe("QueryError");
    expect(closed.message).toContain("closed");
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});
