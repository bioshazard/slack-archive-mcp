import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { Archive } from "../src/adapters/sqlite/reader.ts";
import { messageId } from "../src/domain/model.ts";
import { fixture, TS } from "./fixture.ts";

const resources: { archive: Archive; root: string }[] = [];
afterEach(async () => {
  for (const { archive, root } of resources.splice(0)) {
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  const archive = await Archive.open(f.archiveDir);
  resources.push({ archive, root: f.root });
  return archive;
}

test("lexical search, aliases, author/date filters, phrase/prefix/exact modes and source citations", async () => {
  const a = await setup();
  const result = a.search({
    query: "revised plan",
    channel: "old-general",
    author: "Test Reader",
    after: "2024-01-01",
    before: "2024-01-02",
  });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.citation).toMatchObject({
    export: "data-2026",
    file: "general/2024-01-01.json",
    index: 0,
  });
  expect(result.results[0]?.citation.uri).toBe(
    `archive://test/C1/${TS.parent}`,
  );
  expect(a.search({ query: "original obsolete" }).results).toHaveLength(0);
  expect(a.search({ query: "Removed secret phrase" }).results).toHaveLength(0);
  expect(
    a.search({ query: "lexical retrieval", mode: "phrase" }).results,
  ).toHaveLength(1);
  expect(a.search({ query: "autom", prefix: true }).results).toHaveLength(1);
  expect(a.search({ query: "a_b?q=c++", mode: "exact" }).results).toHaveLength(
    1,
  );
  expect(
    a.search({ query: "revised nonexistent", mode: "any" }).results,
  ).toHaveLength(1);
  expect(
    a.search({ query: "plan", before: "2024-01-01" }).results,
  ).toHaveLength(0);
});

test("thread/context navigation preserves channel boundaries and missing parents", async () => {
  const a = await setup();
  const parent = messageId("test", "C1", TS.parent);
  const reply = messageId("test", "C1", TS.reply);
  const thread = a.thread(reply, { limit: 1 });
  expect(thread.messages[0]?.id).toBe(parent);
  expect(thread.nextOffset).toBe(1);
  expect(a.thread(reply, { limit: 1, offset: 1 }).messages[0]?.id).toBe(reply);
  expect(a.thread(reply).messages).toHaveLength(2);
  expect(a.thread(messageId("test", "C1", TS.orphan)).parentAvailable).toBe(
    false,
  );
  const context = a.context(reply, { before: 1, after: 1 });
  expect(context.messages.map((m) => m.ts)).toEqual([
    TS.parent,
    TS.reply,
    TS.bot,
  ]);
  expect(context.messages.every((m) => m.channel.id === "C1")).toBe(true);
  expect(context.hasMoreAfter).toBe(true);
});

test("version inspection retains raw originals and deletion evidence", async () => {
  const a = await setup();
  const history = a.message(messageId("test", "C1", TS.parent), {
    versions: true,
    limit: 1,
  });
  expect(history.observations?.[0]?.selected).toBe(true);
  expect(history.observations?.[0]?.rawJson).toContain('"reactions":[]');
  expect(history.nextOffset).toBe(1);
  const deleted = a.message(messageId("test", "C1", TS.removed), {
    versions: true,
  });
  expect(deleted.message.deleted).toBe(true);
  expect(deleted.message.text).toBe("");
  expect(
    deleted.observations?.some((o) => o.text === "Removed secret phrase"),
  ).toBe(true);
});

test("pagination, discovery, generation guards, invalid input and read-only enforcement", async () => {
  const a = await setup();
  const first = a.search({ query: "archive", limit: 1 });
  expect(first.nextOffset).toBe(1);
  const second = a.search({ query: "archive", limit: 1, offset: 1 });
  expect(second.results[0]?.id).not.toBe(first.results[0]?.id);
  const channels = a.channels().channels;
  expect(channels.find((c) => c.id === "C1")?.aliases.sort()).toEqual([
    "general",
    "old-general",
  ]);
  expect(() => a.search({ query: "plan", generation: "wrong" })).toThrow(
    "Generation mismatch",
  );
  expect(() => a.search({ query: "plan", limit: -1 })).toThrow("limit");
  expect(() => a.search({ query: "plan", channel: "missing" })).toThrow(
    "Unknown channel",
  );
  expect(() => a.search({ query: "plan", after: "2024-02-30" })).toThrow(
    "Invalid date",
  );
  expect(() => a.search({ query: "   " })).toThrow("query");
  expect(() => a.search({ query: "!!!" })).toThrow("terms");
  expect(
    a.search({ query: '" OR 1=1 --', mode: "exact" }).results,
  ).toHaveLength(0);
  expect(() => a.context("missing")).toThrow("Message not found");
  expect(() => a.db.exec("DELETE FROM messages")).toThrow();
});
