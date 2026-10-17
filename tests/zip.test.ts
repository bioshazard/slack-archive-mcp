import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { strToU8 } from "fflate";
import { Archive } from "../src/adapters/sqlite/reader.ts";
import { localExports } from "../src/adapters/storage/local-exports.ts";
import { ingest } from "../src/ingest.ts";
import { Exports } from "../src/ports/exports.ts";
import { fixture, TS } from "./fixture.ts";
import {
  descriptorZip,
  exportZip,
  patchCentral,
  syntheticZip,
  zip64,
} from "./zip-fixture.ts";

test("ZIP64 containers and streamed data descriptors retain channel paths without metadata", async () => {
  const f = await fixture();
  try {
    const files = {
      "general/2024-01-01.json": strToU8(
        '[{"type":"message","ts":"1704067200.000001","text":"zip variants"}]',
      ),
    };
    for (const bytes of [zip64(syntheticZip(files)), descriptorZip(files)]) {
      const path = join(f.root, "native.zip");
      await writeFile(path, bytes);
      const result = await ingest({ root: f.root, sources: [path] });
      expect(result.manifest.counts.messages).toBe(1);
      expect(result.manifest.sources[0]?.archive?.entryPrefix).toBe("");
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("multiple stored/deflated ZIPs normalize root folders, preserve evidence and match extracted message identities", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "data-2023.zip");
    const second = join(f.root, "data-2026.ZIP");
    await exportZip(join(f.root, "data-2023"), first, "", 0);
    await exportZip(join(f.root, "data-2026"), second, "Wrapped export/");
    const rawBefore = await readFile(second);
    const result = await ingest({ root: f.root, sources: [first, second] });
    expect(result.manifest.counts).toEqual(f.manifest.counts);
    expect(result.manifest.sources.map((s) => s.sha256)).toEqual(
      f.manifest.sources.map((s) => s.sha256),
    );
    expect(result.manifest.sources[1]?.archive).toMatchObject({
      format: "zip",
      file: "data-2026.ZIP",
      entryPrefix: "Wrapped export/",
    });
    const previous = new Database(f.databasePath, { readonly: true });
    const current = new Database(result.databasePath, { readonly: true });
    try {
      const sql =
        "SELECT id,channel_id,ts,thread_ts,author_id,deleted,text FROM messages ORDER BY id";
      expect(current.query(sql).all()).toEqual(previous.query(sql).all());
    } finally {
      previous.close();
      current.close();
    }
    const archive = await Archive.open(f.archiveDir);
    try {
      const result = archive.search({ query: "Revised plan" }).results[0];
      expect(result?.citation.archive).toMatchObject({
        file: "data-2026.ZIP",
        entry: "Wrapped export/general/2024-01-01.json",
      });
      expect(result?.ts).toBe(TS.parent);
    } finally {
      archive.close();
    }
    expect(await readFile(second)).toEqual(rawBefore);
    expect(
      (await ingest({ root: f.root, sources: [first, second] })).reused,
    ).toBe(true);
    expect(await readdir(f.root)).not.toContain("Wrapped export");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("local discovery accepts native ZIP names with spaces; directory/ZIP mixtures retain explicit precedence", async () => {
  const f = await fixture();
  try {
    await exportZip(
      join(f.root, "data-2026"),
      join(f.root, "Workspace export October 2026.zip"),
    );
    const mixed = await ingest({
      root: f.root,
      sources: ["data-2023", "Workspace export October 2026.zip"],
    });
    expect(mixed.manifest.counts.messages).toBe(7);
    expect(mixed.manifest.sources[1]?.name).toBe(
      "Workspace export October 2026",
    );
    await rm(join(f.root, "data-2023"), { recursive: true });
    await rm(join(f.root, "data-2026"), { recursive: true });
    const discovered = await ingest({ root: f.root });
    expect(discovered.manifest.sources).toHaveLength(1);
    expect(discovered.manifest.counts.messages).toBe(7);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("corrupt CRC, unsafe paths, links, encryption, duplicates and malformed ZIPs leave current unchanged", async () => {
  const f = await fixture();
  const base = syntheticZip({
    "channels.json": strToU8("[]"),
    "general/2024-01-01.json": strToU8(
      '[{"type":"message","ts":"1704067200.000001","text":"test"}]',
    ),
  });
  const cases: [string, Uint8Array, RegExp][] = [
    [
      "payload",
      (() => {
        const bytes = Buffer.from(base);
        const offset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
        bytes[offset] = (bytes[offset] ?? 0) ^ 1;
        return bytes;
      })(),
      /CRC-32/,
    ],
    [
      "crc",
      patchCentral(base, (buffer, offset, index) => {
        if (index === 1) buffer.writeUInt32LE(1234, offset + 16);
      }),
      /CRC-32/,
    ],
    [
      "traversal",
      syntheticZip({ "../escape.json": strToU8("[]") }),
      /invalid relative path|Unsafe ZIP/,
    ],
    [
      "absolute",
      syntheticZip({ "/escape.json": strToU8("[]") }),
      /absolute path|Unsafe ZIP/,
    ],
    [
      "backslash",
      syntheticZip({ "folder\\file.json": strToU8("[]") }),
      /invalid characters|Unsafe ZIP/,
    ],
    [
      "symlink",
      patchCentral(base, (buffer, offset, index) => {
        if (index === 0)
          buffer.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38);
      }),
      /link or special/,
    ],
    [
      "encrypted",
      patchCentral(base, (buffer, offset) => {
        buffer.writeUInt16LE(1, offset + 8);
        buffer.writeUInt16LE(8, offset + 10);
      }),
      /Encrypted/,
    ],
    [
      "duplicate",
      patchCentral(
        syntheticZip({ "a.json": strToU8("[]"), "b.json": strToU8("[]") }),
        (buffer, offset) => {
          buffer.write("a.json", offset + 46);
        },
      ),
      /Duplicate/,
    ],
    [
      "malformed",
      strToU8("not a ZIP"),
      /end of central directory|signature|not a zip/i,
    ],
    [
      "nested",
      syntheticZip({
        "one/channels.json": strToU8("[]"),
        "two/channels.json": strToU8("[]"),
      }),
      /multiple export roots/,
    ],
  ];
  try {
    const pointer = await readFile(join(f.archiveDir, "current.json"), "utf8");
    for (const [name, bytes, pattern] of cases) {
      const path = join(f.root, `${name}.zip`);
      await writeFile(path, bytes);
      await expect(ingest({ root: f.root, sources: [path] })).rejects.toThrow(
        pattern,
      );
      expect(await readFile(join(f.archiveDir, "current.json"), "utf8")).toBe(
        pointer,
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ZIP limits are enforced before publication, with scoped temporary cleanup", async () => {
  const f = await fixture();
  const temporary = async () =>
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith("slack-archive-mcp-zip-"))
      .sort();
  const before = await temporary();
  try {
    const path = join(f.root, "data-2026.zip");
    await exportZip(join(f.root, "data-2026"), path);
    for (const limits of [
      { maxArchiveBytes: 10 },
      { maxEntries: 1 },
      { maxEntryBytes: 10 },
      { maxTotalBytes: 10 },
    ]) {
      await expect(
        ingest({ root: f.root, sources: [path], zipLimits: limits }),
      ).rejects.toThrow(/limit/);
    }
    let stagedLocator = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* Exports;
        const inventory = yield* source.inventory;
        const file = inventory[0]?.files[0];
        if (!file) throw new Error("Missing ZIP fixture entry");
        stagedLocator = file.locator;
        expect(new TextDecoder().decode(yield* source.read(file))).toContain(
          "C1",
        );
      }).pipe(
        Effect.provide(
          localExports({
            root: f.root,
            sources: [path],
            archiveDir: f.archiveDir,
          }),
        ),
      ),
    );
    expect(stagedLocator).toStartWith("zip:");
    expect(await readdir(f.archiveDir)).not.toContain("ingest.lock");
    expect(await temporary()).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
