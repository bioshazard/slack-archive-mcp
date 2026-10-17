import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Archive } from "../src/adapters/sqlite/reader.ts";
import { messageId } from "../src/domain/model.ts";
import { ingest, verifySnapshot } from "../src/ingest.ts";
import { fixture, TS, writeJson } from "./fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const f = await fixture();
  roots.push(f.root);
  return f;
}

describe("materialization", () => {
  test("preserves workspace identity on refresh and prevents writing into sources", async () => {
    const f = await setup();
    expect((await ingest({ root: f.root })).manifest.workspace).toBe("test");
    await expect(
      ingest({ root: f.root, workspace: "another" }),
    ).rejects.toThrow("Workspace differs");
    await expect(
      ingest({ root: f.root, archiveDir: join(f.root, "data-2026/output") }),
    ).rejects.toThrow("outside source");
  });

  test("builds portable, deterministic snapshots and pins existing readers across refresh", async () => {
    const f = await setup();
    const copy = await ingest({
      root: f.root,
      workspace: "test",
      archiveDir: join(f.root, "copy"),
    });
    expect(copy.manifest.generation).toBe(f.manifest.generation);
    expect(copy.manifest.database.sha256).toBe(f.manifest.database.sha256);
    const reader = await Archive.open(f.archiveDir);
    try {
      const path = join(f.root, "data-2026/general/2024-01-01.json");
      const records = JSON.parse(await readFile(path, "utf8"));
      records[1].text = "newly indexed vocabulary";
      await writeJson(path, records);
      const updated = await ingest({ root: f.root });
      expect(updated.manifest.generation).not.toBe(reader.manifest.generation);
      expect(reader.search({ query: "vocabulary" }).results).toHaveLength(0);
      const fresh = await Archive.open(f.archiveDir);
      try {
        expect(fresh.search({ query: "vocabulary" }).results).toHaveLength(1);
      } finally {
        fresh.close();
      }
    } finally {
      reader.close();
    }
  });

  test("coalesces renamed file conversations by stable file ID and records aliases/warnings", async () => {
    const f = await setup();
    for (const [source, name] of [
      ["data-2023", "FC:F123:Untitled"],
      ["data-2026", "FC:F123:Canvas"],
    ] as const) {
      const folder = join(f.root, source, name);
      await mkdir(folder);
      await writeJson(join(folder, "2024-01-01.json"), [
        { type: "message", ts: TS.parent, text: "Canvas discussion" },
      ]);
    }
    const updated = await ingest({ root: f.root });
    expect(updated.manifest.counts.messages).toBe(8);
    expect(updated.manifest.warnings.some((w) => w.includes("FC:F123"))).toBe(
      true,
    );
    const a = await Archive.open(f.archiveDir);
    try {
      expect(
        a.search({ query: "Canvas", channel: "FC:F123" }).results,
      ).toHaveLength(1);
      expect(
        a
          .channels()
          .channels.find((c) => c.id === "FC:F123")
          ?.aliases.sort(),
      ).toEqual(["FC:F123:Canvas", "FC:F123:Untitled"]);
    } finally {
      a.close();
    }
  });

  test("refuses symlinks, concurrent import locks and invalid source sets", async () => {
    const f = await setup();
    await mkdir(join(f.archiveDir, "ingest.lock"));
    await expect(ingest({ root: f.root })).rejects.toThrow("Another import");
    await rm(join(f.archiveDir, "ingest.lock"), { recursive: true });
    const link = join(f.root, "data-2026/link.json");
    await symlink(join(f.root, "data-2026/channels.json"), link);
    await expect(ingest({ root: f.root })).rejects.toThrow("Symlink");
    await rm(link);
    await expect(
      ingest({ root: f.root, sources: ["data-2026", "data-2026"] }),
    ).rejects.toThrow("unique");
  });

  test("preserves observations, channel identity, shorter edits, tombstones and bot/system records", async () => {
    const f = await setup();
    expect(f.manifest.counts).toMatchObject({
      exports: 2,
      observations: 14,
      messages: 7,
      rejected: 6,
      deleted: 1,
      missingThreadParents: 1,
    });
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const row = db
        .query("SELECT * FROM messages WHERE id=?")
        .get(messageId("test", "C1", TS.parent)) as Record<string, unknown>;
      expect(row.text).toBe("Revised plan");
      expect(
        db.query("SELECT count(*) n FROM messages WHERE ts=?").get(TS.parent),
      ).toEqual({ n: 2 });
      const winner = db
        .query("SELECT raw_json FROM observations WHERE id=?")
        .get(row.observation_id as number) as { raw_json: string };
      expect(JSON.parse(winner.raw_json).reactions).toEqual([]);
      expect(
        db
          .query("SELECT count(*) n FROM source_files WHERE kind='messages'")
          .get(),
      ).toEqual({ n: 4 });
      expect(
        db
          .query(
            "SELECT count(*) n FROM rejected_records WHERE raw_json='null'",
          )
          .get(),
      ).toEqual({ n: 2 });
    } finally {
      db.close();
    }
    expect((await verifySnapshot(f.archiveDir)).generation).toBe(
      f.manifest.generation,
    );
  });

  test("reuses identical sources and publishes a new generation for changed input", async () => {
    const f = await setup();
    const again = await ingest({ root: f.root, workspace: "test" });
    expect(again.reused).toBe(true);
    expect(again.manifest).toEqual(f.manifest);
    const path = join(f.root, "data-2026/general/2024-01-01.json");
    const records = JSON.parse(await readFile(path, "utf8"));
    records[1].text = "A newly changed reply";
    await writeFile(path, JSON.stringify(records));
    const changed = await ingest({ root: f.root, workspace: "test" });
    expect(changed.reused).toBe(false);
    expect(changed.manifest.generation).not.toBe(f.manifest.generation);
    expect(await readdir(join(f.archiveDir, "generations"))).toHaveLength(2);
    const active = await Archive.open(f.archiveDir);
    try {
      expect(active.manifest.generation).toBe(changed.manifest.generation);
    } finally {
      active.close();
    }
  });

  test("malformed imports preserve current generation and clean staging/lock", async () => {
    const f = await setup();
    await writeFile(join(f.root, "data-2026/general/2024-01-01.json"), "{");
    await expect(ingest({ root: f.root, workspace: "test" })).rejects.toThrow(
      "Malformed JSON",
    );
    const active = await Archive.open(f.archiveDir);
    try {
      expect(active.manifest.generation).toBe(f.manifest.generation);
    } finally {
      active.close();
    }
    expect(await readdir(f.archiveDir)).not.toContain("ingest.lock");
    expect(await readdir(join(f.archiveDir, "generations"))).toEqual([
      f.manifest.generation,
    ]);
  });

  test("detects snapshot corruption instead of reusing it", async () => {
    const f = await setup();
    const bytes = await readFile(f.databasePath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await writeFile(f.databasePath, bytes);
    await expect(verifySnapshot(f.archiveDir)).rejects.toThrow("checksum");
    await expect(ingest({ root: f.root, workspace: "test" })).rejects.toThrow(
      "checksum",
    );
  });
});
