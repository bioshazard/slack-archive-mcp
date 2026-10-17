# Contributing

Contributions are licensed under MIT. Keep changes focused and include synthetic
regression tests for changed behavior.

```sh
bun install --frozen-lockfile
bun run format
bun run check
```

Read docs/architecture.md and docs/effect.md before adding an adapter. Keep domain
and application independent of concrete storage and transport. Use the same Effect
version across Effect ecosystem packages. Do not run formatter or tests against
private historical code.

Never commit exports, generated SQLite, reports, credentials or local machine
configuration. Never copy real messages into fixtures. Docker build contexts use
an allowlist; do not replace it with a broad source-tree copy.

For serving changes, build Dockerfile.mcp and run `bun run docker:smoke`. For
import/reconciliation changes, bump IMPORTER_VERSION, and verify deterministic
rebuilds, failed-publication recovery and both local/S3 adapter contracts.
