import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "./fixture.ts";

async function start(database: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/mcp.ts", import.meta.url)),
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--sqlite-path",
      database,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MCP_AUTH_TOKEN: "",
        MCP_ALLOWED_HOSTS: "",
        MCP_ALLOWED_ORIGINS: "",
        ...env,
      },
    },
  );
  let stderr = "";
  const address = Promise.withResolvers<URL>();
  const draining = (async () => {
    for await (const chunk of child.stderr) {
      stderr += new TextDecoder().decode(chunk);
      const found = stderr.match(/MCP HTTP listening at (http:\/\/\S+)/);
      if (found?.[1]) address.resolve(new URL(found[1]));
    }
  })();
  const timer = setTimeout(
    () => address.reject(new Error(`HTTP startup timeout: ${stderr}`)),
    10_000,
  );
  void child.exited.then(() =>
    address.reject(new Error(`HTTP exited before listening: ${stderr}`)),
  );
  try {
    const url = await address.promise;
    clearTimeout(timer);
    return {
      child,
      url,
      async close() {
        child.kill("SIGTERM");
        await child.exited;
        await draining;
        expect(await new Response(child.stdout).text()).toBe("");
        expect(stderr).not.toContain("HTTP request failed");
      },
    };
  } catch (error) {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    throw error;
  }
}

test("Streamable HTTP survives closed stdin, supports concurrent SDK clients and protects MCP requests", async () => {
  const f = await fixture();
  const before = await readFile(f.databasePath);
  const server = await start(f.databasePath, {
    MCP_AUTH_TOKEN: "synthetic-http-token",
    MCP_ALLOWED_ORIGINS: "https://trusted.example",
  });
  const clients: Client[] = [];
  try {
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/readyz", server.url))).status).toBe(200);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(server.url, {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(server.url, {
          headers: { Authorization: "Bearer synthetic-http-token" },
        })
      ).status,
    ).toBe(405);
    expect((await fetch(new URL("/missing", server.url))).status).toBe(404);
    expect(
      (
        await fetch(server.url, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const preflight = await fetch(server.url, {
      method: "OPTIONS",
      headers: { Origin: "https://trusted.example" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://trusted.example",
    );
    const headers = {
      Authorization: "Bearer synthetic-http-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const malformed = await fetch(server.url, {
      method: "POST",
      headers,
      body: "not json",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(server.url, {
      method: "POST",
      headers,
      body: "x".repeat(65_537),
    });
    expect(oversized.status).toBe(413);
    const outputs = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const client = new Client({
          name: `http-test-${index}`,
          version: "1.0.0",
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(server.url, {
            requestInit: {
              headers: { Authorization: "Bearer synthetic-http-token" },
            },
          }),
        );
        expect((await client.listTools()).tools).toHaveLength(6);
        const result = await client.callTool({
          name: "search",
          arguments: { query: "revised plan" },
        });
        expect(result.isError).not.toBe(true);
        const output = result.structuredContent as {
          generation: string;
          results: { id: string }[];
        };
        expect(output.generation).toBe(f.manifest.generation);
        expect(output.results).toHaveLength(1);
        for (const name of ["get_thread", "get_context", "get_message"]) {
          expect(
            (
              await client.callTool({
                name,
                arguments: {
                  id: output.results[0]?.id,
                  generation: output.generation,
                },
              })
            ).isError,
          ).not.toBe(true);
        }
        const mismatch = await client.callTool({
          name: "get_message",
          arguments: { id: output.results[0]?.id, generation: "wrong" },
        });
        expect(mismatch.isError).toBe(true);
        expect(
          (
            await client.callTool({
              name: "search",
              arguments: { query: "plan", limit: 500 },
            })
          ).isError,
        ).toBe(true);
        return output;
      }),
    );
    expect(outputs[0]).toEqual(outputs[1]);
    expect(await readFile(f.databasePath)).toEqual(before);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 20_000);

test("HTTP mode rejects unexpected hosts and browser origins by default", async () => {
  const f = await fixture();
  const server = await start(f.databasePath, {
    MCP_ALLOWED_HOSTS: "trusted.example",
  });
  try {
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(403);
    expect(
      (
        await fetch(new URL("/healthz", server.url), {
          headers: { Host: "trusted.example" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(server.url, {
          method: "POST",
          headers: { Host: "trusted.example", Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await server.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("HTTP startup fails before listening when the mounted database is missing", async () => {
  const f = await fixture();
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../src/mcp.ts", import.meta.url)),
        "--transport",
        "http",
        "--port",
        "0",
        "--sqlite-path",
        `${f.root}/missing.sqlite`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("MCP HTTP listening");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
