import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Smoke-test the real local snapshot without printing private archive content.
const archiveDir = resolve(process.env.ARCHIVE_DIR ?? ".archive");
const client = new Client({
  name: "slack-archive-mcp-smoke",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL("../src/mcp.ts", import.meta.url)),
    "--archive-dir",
    archiveDir,
  ],
  stderr: "inherit",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 6) throw new Error("Expected six archive tools");
  const status = await client.callTool({
    name: "archive_status",
    arguments: {},
  });
  if (status.isError) throw new Error("Status failed");
  const channels = await client.callTool({
    name: "list_channels",
    arguments: { limit: 100 },
  });
  if (channels.isError) throw new Error("Channel discovery failed");
  const result = await client.callTool({
    name: "search",
    arguments: { query: "book", limit: 1 },
  });
  if (result.isError) throw new Error("Search failed");
  const output = result.structuredContent as {
    results: { id: string }[];
    generation: string;
  };
  const first = output.results[0];
  if (!first) throw new Error("Expected a real archive search hit for 'book'");
  for (const name of ["get_message", "get_thread", "get_context"]) {
    const response = await client.callTool({
      name,
      arguments: { id: first.id, generation: output.generation },
    });
    if (response.isError) throw new Error(`${name} failed`);
  }
  console.log(
    JSON.stringify({
      ok: true,
      transport: "stdio",
      tools: tools.tools.map((t) => t.name),
      generation: output.generation,
    }),
  );
} finally {
  await client.close();
  await transport.close();
}
