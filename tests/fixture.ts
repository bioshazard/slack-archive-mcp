import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/ingest.ts";

export const TS = {
  parent: "1704067200.000001",
  reply: "1704067201.000002",
  bot: "1704067202.000003",
  removed: "1704067203.000004",
  orphan: "1704067204.000005",
  edited: "1704067300.000001",
};

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slack-archive-mcp-test-"));
  for (const [name, channel] of [
    ["data-2023", "old-general"],
    ["data-2026", "general"],
  ] as const) {
    const directory = join(root, name);
    for (const folder of [channel, "other"])
      await mkdir(join(directory, folder), { recursive: true });
    await writeJson(join(directory, "channels.json"), [
      { id: "C1", name: channel },
      { id: "C2", name: "other" },
    ]);
    await writeJson(join(directory, "users.json"), [
      { id: "U1", name: "test", profile: { display_name: "Test Reader" } },
    ]);
    const old = name === "data-2023";
    await writeJson(join(directory, channel, "2024-01-01.json"), [
      {
        type: "message",
        ts: TS.parent,
        thread_ts: TS.parent,
        user: "U1",
        text: old ? "The original lengthy obsolete plan" : "Revised plan",
        edited: { user: "U1", ts: old ? "1704067250.000001" : TS.edited },
        reactions: old ? [{ name: "thumbsup", users: ["U1"], count: 1 }] : [],
        attachments: [
          { title: "Archive handbook", text: "lexical retrieval guide" },
        ],
      },
      {
        type: "message",
        ts: TS.reply,
        thread_ts: TS.parent,
        user: "U1",
        text: "Follow-up: sqlite cache https://example.invalid/a_b?q=c++",
      },
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "B1",
        ts: TS.bot,
        text: "Automated archive status",
      },
      old
        ? {
            type: "message",
            user: "U1",
            ts: TS.removed,
            text: "Removed secret phrase",
          }
        : {
            type: "message",
            subtype: "message_deleted",
            ts: "1704067400.000001",
            deleted_ts: TS.removed,
          },
      {
        type: "message",
        user: "U1",
        ts: TS.orphan,
        thread_ts: "1704000000.000001",
        text: "Orphan reply",
      },
      {
        type: "message",
        subtype: "channel_join",
        ts: "1704067205.000001",
        text: "System event without user",
      },
      { type: "message", user: "U1", text: "Invalid record without timestamp" },
      { type: "not-a-message", ts: "1704067206.000001" },
      null,
    ]);
    await writeJson(join(directory, "other", "2024-01-01.json"), [
      {
        type: "message",
        user: "U1",
        ts: TS.parent,
        text: "Other channel distinct message",
      },
    ]);
  }
  const built = await ingest({ root, workspace: "test" });
  return { root, archiveDir: join(root, ".archive"), ...built };
}
