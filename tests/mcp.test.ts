import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.ts";

test("real stdio MCP initializes, discovers tools, searches, expands evidence and rejects invalid requests", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/mcp.ts", import.meta.url)),
      "--archive-dir",
      f.archiveDir,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "archive-test", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const before = await readFile(f.databasePath);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "archive_status",
      "get_context",
      "get_message",
      "get_thread",
      "list_channels",
      "search",
    ]);
    expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const status = await client.callTool({
      name: "archive_status",
      arguments: {},
    });
    expect(
      (status.structuredContent as Record<string, unknown>)?.generation,
    ).toBe(f.manifest.generation);
    const result = await client.callTool({
      name: "search",
      arguments: { query: "revised plan" },
    });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      generation: string;
      results: { id: string }[];
    };
    expect(output.results).toHaveLength(1);
    const id = output.results[0]?.id;
    for (const name of ["get_thread", "get_context", "get_message"]) {
      const expanded = await client.callTool({
        name,
        arguments: { id, generation: output.generation },
      });
      expect(expanded.isError).not.toBe(true);
      expect(
        (expanded.structuredContent as Record<string, unknown>)?.generation,
      ).toBe(output.generation);
    }
    const channels = await client.callTool({
      name: "list_channels",
      arguments: { limit: 1 },
    });
    expect(
      (channels.structuredContent as Record<string, unknown>)?.nextOffset,
    ).toBe(1);
    const invalid = await client.callTool({
      name: "search",
      arguments: { query: "plan", limit: 500 },
    });
    expect(invalid.isError).toBe(true);
    const mismatch = await client.callTool({
      name: "get_thread",
      arguments: { id, generation: "wrong" },
    });
    expect(mismatch.isError).toBe(true);
    expect(await readFile(f.databasePath)).toEqual(before);
    expect(stderr).toBe("");
  } finally {
    await client.close();
    await transport.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);
