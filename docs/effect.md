# Effect 4 conventions

Pinned: `effect` and `@effect/platform-bun` **4.0.5**, running on Bun 1.4.0.
Primary agent reference: [official LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md).
The [v4 documentation index](https://effect.website/docs/v4/llms.txt) and installed
package declarations provide the current interface. Main-branch examples can move;
check against the pinned release before adopting a new API.

- Services use `Context.Service`; implementations are supplied as `Layer`s.
- `Effect.fn` names use cases and adapter operations for tracing. Local generator
  composition uses `Effect.gen`; pure identity/reconciliation helpers stay pure.
- Expected failures are `Schema.TaggedError`s. Source, snapshot, materialization
  and query failures are distinct. Schema validates persisted manifests and source
  descriptors. Preserve original source JSON independently of decoded views.
- `Effect.acquireRelease` owns writer locks, staging directories, databases,
  ManagedRuntime and MCP transport cleanup. `BunRuntime.runMain` handles signals.
- `Config` reads settings; credentials use `Config.Redacted`. Tests inject a
  `ConfigProvider`, rather than modifying the process environment.
- The official MCP SDK remains the protocol adapter. A single `ManagedRuntime`
  bridges SDK callbacks into the scoped `ArchiveReader` layer. Zod describes that
  SDK edge only; it is not the domain model.

Native `bun:sqlite` prepared transactions and FTS operations remain internal to the
SQLite adapter. This avoids introducing a second database abstraction into its
existing bulk-import and search implementation. Resource ownership and failures
are managed by Effect. Neither SQL nor a native handle appears in a port.

The CLI uses `effect/cli` and Bun platform services. The core use case depends on
ports, not local filesystem, S3, SQLite or MCP packages. Tests replace those ports
without changing application logic.
