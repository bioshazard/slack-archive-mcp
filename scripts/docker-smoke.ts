import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../tests/fixture.ts";
import { exportZip } from "../tests/zip-fixture.ts";

// Only a synthetic SQLite file is mounted; no exports, sidecar or credentials.
const f = await fixture();
// macOS Docker VMs commonly share the project tree but not OS temp directories.
const local = fileURLToPath(new URL("../local/", import.meta.url));
await mkdir(local, { recursive: true });
const mountDirectory = await mkdtemp(join(local, "docker-smoke-"));
const mountedDatabase = join(mountDirectory, "archive.sqlite");
const image = process.env.MCP_IMAGE ?? "slack-archive-mcp:local";
const client = new Client({ name: "docker-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "docker",
  args: [
    "run",
    "--rm",
    "-i",
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${mountedDatabase},dst=/mounted/custom.sqlite,readonly`,
    "-e",
    "ARCHIVE_SQLITE_PATH=/mounted/custom.sqlite",
    image,
  ],
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (data) => {
  stderr += String(data);
});
try {
  const input = join(mountDirectory, "input");
  const output = join(mountDirectory, "output");
  await mkdir(input);
  await mkdir(output);
  await exportZip(join(f.root, "data-2023"), join(input, "older.zip"));
  await exportZip(
    join(f.root, "data-2026"),
    join(input, "latest.zip"),
    "Wrapped/",
  );
  const ingestion = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--mount",
      `type=bind,src=${input},dst=/input,readonly`,
      "--mount",
      `type=bind,src=${output},dst=/output`,
      process.env.CLI_IMAGE ?? "slack-archive-cli:local",
      "ingest",
      "--root",
      "/input",
      "--workspace",
      "fixture",
      "older.zip",
      "latest.zip",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [ingestStdout, ingestStderr, exitCode] = await Promise.all([
    new Response(ingestion.stdout).text(),
    new Response(ingestion.stderr).text(),
    ingestion.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Container ZIP ingestion failed: ${ingestStdout} ${ingestStderr}`,
    );
  const pointer = JSON.parse(
    await readFile(join(output, "current.json"), "utf8"),
  );
  await copyFile(
    join(output, "generations", pointer.generation, "archive.sqlite"),
    mountedDatabase,
  );
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 6) throw new Error("Expected six tools");
  const search = await client.callTool({
    name: "search",
    arguments: { query: "revised plan" },
  });
  if (search.isError) throw new Error("Container search failed");
  const result = search.structuredContent as {
    generation: string;
    results: { id: string }[];
  };
  const id = result.results[0]?.id;
  if (!id || result.generation !== pointer.generation)
    throw new Error("Unexpected container results");
  for (const name of ["get_thread", "get_context", "get_message"]) {
    const expanded = await client.callTool({
      name,
      arguments: { id, generation: result.generation },
    });
    if (expanded.isError) throw new Error(`Container ${name} failed`);
  }
  if (stderr) throw new Error(`Unexpected container stderr: ${stderr}`);
  console.log(
    JSON.stringify({
      ok: true,
      image,
      transport: "stdio",
      singleMountedDatabase: true,
      containerZipIngestion: true,
      network: "none",
      readOnly: true,
    }),
  );
} catch (cause) {
  if (stderr) console.error(stderr);
  throw cause;
} finally {
  await client.close();
  await transport.close();
  await rm(f.root, { recursive: true, force: true });
  await rm(mountDirectory, { recursive: true, force: true });
}
