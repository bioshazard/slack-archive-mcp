# Working on slack-archive-mcp

MIT-licensed Slack archive materialization and stdio/Streamable HTTP MCP. Bun 1.4+, Effect 4.0.5,
SQLite FTS5. Read README.md, docs/architecture.md and docs/effect.md first.

- Follow the official Effect 4 LLMS.md and installed types, not Effect 3 examples.
  Use Context.Service ports, Layer composition, Effect.fn for traced use cases,
  typed errors, Schema validation and scoped acquireRelease for resources.
- Dependencies point inward: domain imports no ports/adapters; application imports
  ports/domain only. Keep source selection and SDK protocol wiring at entrypoints.
- Native Bun SQLite batching/FTS belongs inside its adapter. Do not leak database
  handles into ports. ManagedRuntime bridges Effect services to MCP SDK callbacks.
- `bun install --frozen-lockfile`; `bun run check`. `bun run format` applies fixes.
  Docker checks: `bun run docker:build`, `docker build -t slack-archive-cli:local .`,
  then `bun run docker:smoke`.
- Tests generate synthetic exports under OS temporary directories. Never copy
  private messages, original data, reports or credentials into tests or docs.
- Never deduplicate by text. Identity includes workspace, conversation ID and exact
  timestamp. Preserve every observation and its source evidence.
- Change reconciliation explicitly and bump IMPORTER_VERSION. Bump SCHEMA_VERSION
  for incompatible schema changes. Publish closed SQLite artifacts atomically.
- The serving image must work with one read-only mounted SQLite file at
  ARCHIVE_SQLITE_PATH. It must not need S3 access or original export files.
- Only MCP protocol frames go to stdout. Diagnostics use stderr. Scope database,
  runtime and transport lifetimes; do not hand-roll signal cleanup.
- HTTP uses one stateless SDK transport/server per request over a shared reader.
  Keep bearer checks, Origin rejection, bounded request bodies and probe behavior.
- Preserve bounded retrieval, citations, generation guards and truncation flags.
- ZIP input belongs behind Exports. Never extract members; scope compressed
  staging/handles, bound reads, validate CRC and preserve container provenance.
  No arbitrary SQL, filesystem, URL fetching or mutation tools.
- `local/`, `data-*/`, `.archive/`, credentials and local MCP config are private.
  Docker uses a context allowlist. Historical private work is in local/history.
- Do not publish, push, rewrite Git history or alter global settings unless asked.
