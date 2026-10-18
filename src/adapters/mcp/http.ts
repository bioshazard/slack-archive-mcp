import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Effect, Redacted } from "effect";
import { errorMessage, QueryError } from "../../domain/errors.ts";

export interface HttpOptions {
  readonly hostname: string;
  readonly port: number;
  readonly token: Redacted.Redacted<string>;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly createServer: () => McpServer;
  readonly ready: () => Promise<unknown>;
}

const maxBodyBytes = 64 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest();
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new QueryError({ message: errorMessage(cause), cause }),
  });

// One transport/server per POST; only the read-only reader runtime is shared.
export const httpServer = Effect.fn("mcp.http")(function* (
  options: HttpOptions,
) {
  const token = Redacted.value(options.token);
  const expected = hash(`Bearer ${token}`);
  const origins = new Set(options.allowedOrigins);
  const hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: options.hostname,
          port: options.port,
          maxRequestBodySize: maxBodyBytes,
          idleTimeout: 30,
          async fetch(request) {
            const path = new URL(request.url).pathname;
            const origin = request.headers.get("origin");
            const finish = (response: Response) => {
              response.headers.set("Cache-Control", "no-store");
              if (origin && origins.has(origin)) {
                response.headers.set("Access-Control-Allow-Origin", origin);
                response.headers.set("Vary", "Origin");
              }
              return response;
            };
            const reply = (
              status: number,
              message: string,
              headers?: Record<string, string>,
            ) => finish(Response.json({ error: message }, { status, headers }));
            if (
              hosts.size &&
              !hosts.has(request.headers.get("host")?.toLowerCase() ?? "")
            )
              return reply(403, "Host not allowed");
            // Deny browser origins unless explicitly trusted; do not trust forwarded headers.
            if (origin && !origins.has(origin))
              return reply(403, "Origin not allowed");
            if (
              request.method === "GET" &&
              (path === "/healthz" || path === "/readyz")
            ) {
              try {
                if (path === "/readyz") await options.ready();
                return finish(Response.json({ ok: true }));
              } catch {
                return reply(503, "Archive unavailable");
              }
            }
            if (path !== "/mcp") return reply(404, "Not found");
            if (request.method === "OPTIONS" && origin && origins.has(origin)) {
              return finish(
                new Response(null, {
                  status: 204,
                  headers: {
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers":
                      "Authorization, Content-Type, MCP-Protocol-Version, Accept",
                    "Access-Control-Max-Age": "600",
                  },
                }),
              );
            }
            if (
              token &&
              !timingSafeEqual(
                expected,
                hash(request.headers.get("authorization") ?? ""),
              )
            ) {
              return reply(401, "Unauthorized", {
                "WWW-Authenticate": "Bearer",
              });
            }
            if (request.method !== "POST")
              return reply(405, "Method not allowed", { Allow: "POST" });
            try {
              const response = await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function* () {
                    const transport = yield* Effect.acquireRelease(
                      Effect.sync(
                        () =>
                          new WebStandardStreamableHTTPServerTransport({
                            sessionIdGenerator: undefined,
                            enableJsonResponse: true,
                            maxRequestBodySize: maxBodyBytes,
                          }),
                      ),
                      (transport) => Effect.promise(() => transport.close()),
                    );
                    const mcp = yield* Effect.acquireRelease(
                      Effect.sync(options.createServer),
                      (mcp) => Effect.promise(() => mcp.close()),
                    );
                    yield* attempt(() => mcp.connect(transport));
                    return yield* attempt(() =>
                      transport.handleRequest(request),
                    );
                  }),
                ),
                { signal: request.signal },
              );
              return finish(response);
            } catch {
              console.error("MCP HTTP request failed");
              return reply(500, "Internal server error");
            }
          },
          error() {
            return Response.json(
              { error: "Internal server error" },
              { status: 500 },
            );
          },
        }),
      catch: (cause) => new QueryError({ message: errorMessage(cause), cause }),
    }),
    (server) => Effect.promise(() => server.stop()),
  );
  return server;
});
