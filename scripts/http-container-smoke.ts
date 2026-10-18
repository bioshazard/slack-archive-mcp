import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`Docker ${args[0]} failed: ${err}`);
  return out.trim();
}

export async function smokeHttpContainer(
  image: string,
  database: string,
  generation: string,
) {
  const container = await docker([
    "run",
    "--detach",
    "--rm",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--publish",
    "127.0.0.1::3000",
    "--mount",
    `type=bind,src=${database},dst=/data/archive.sqlite,readonly`,
    "-e",
    "MCP_TRANSPORT=http",
    "-e",
    "MCP_HOST=0.0.0.0",
    "-e",
    "MCP_AUTH_TOKEN=synthetic-container-token",
    image,
  ]);
  const client = new Client({ name: "http-container-smoke", version: "1.0.0" });
  try {
    const address = await docker(["port", container, "3000/tcp"]);
    const url = new URL(`http://${address}/mcp`);
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      ready = await fetch(new URL("/readyz", url), {
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready)
      throw new Error(
        `HTTP container failed readiness: ${await docker(["logs", container])}`,
      );
    if ((await fetch(url, { method: "POST" })).status !== 401)
      throw new Error("HTTP container did not enforce authentication");
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { Authorization: "Bearer synthetic-container-token" },
        },
      }),
    );
    if ((await client.listTools()).tools.length !== 6)
      throw new Error("HTTP container tool discovery failed");
    const result = await client.callTool({
      name: "search",
      arguments: { query: "revised plan" },
    });
    const output = result.structuredContent as {
      generation: string;
      results: { id: string }[];
    };
    if (
      result.isError ||
      output.generation !== generation ||
      !output.results[0]?.id
    )
      throw new Error("HTTP container search failed");
    for (const name of ["get_message", "get_thread", "get_context"]) {
      if (
        (
          await client.callTool({
            name,
            arguments: { id: output.results[0].id, generation },
          })
        ).isError
      )
        throw new Error(`HTTP container ${name} failed`);
    }
  } finally {
    await client.close();
    await docker(["stop", "--time", "5", container]);
  }
}
