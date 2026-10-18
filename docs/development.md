# Development

```sh
bun install --frozen-lockfile
bun run format
bun run check
```

`check` runs TypeScript, Biome and the active test suite. `bun test` also scopes to
`tests/` via bunfig.toml. Private historical experiments are preserved in ignored local/history and excluded from active
compilation, formatting and tests. The root lockfile is authoritative.

Tests generate synthetic exports in OS temporary directories and remove them.
They need neither real data nor network credentials. Coverage includes:

- overlapping source observations and same timestamps in different channels;
- renamed conversations, shorter edits and source reaction snapshots;
- bot/system records without users, quarantine and explicit deletion;
- reproducible generation reuse, changed inputs, failed publication and corruption;
- FTS/phrase/prefix/exact search, date/author/channel filters and pagination;
- thread and context expansion, missing parents, original observations/citations;
- query-only SQLite enforcement and generation mismatches;
- CLI subprocess ingest/search/verify and genuine MCP SDK stdio round trips.
- HTTP SDK initialization, concurrent stateless clients, bearer authentication,
  host/origin validation, body limits, probes and shutdown with closed stdin;
- stored/deflated ZIPs, ZIP64, data descriptors, wrapper folders, CRC/header
  corruption, unsafe paths, duplicate entries, limits and scoped cleanup;
- local/S3 ZIP mixtures, direct S3 objects without listing, and prefix selection.

For private real-data validation:

```sh
bun run ingest --workspace community
bun run verify
bun run smoke
```

`smoke` does not print private messages. `search` deliberately prints matching
content; avoid placing its output in committed fixtures, docs or CI logs.

No original exports, databases, manifests, local reports or machine-specific MCP
configuration belong in Git. `bun run check` includes a repository hygiene test
checking tracked filenames against private/runtime artifact patterns.

## Containers and adapters

```sh
bun run docker:build
docker build -t slack-archive-cli:local .
bun run docker:smoke
```

The smoke test first ingests synthetic ZIPs using the CLI container, then mounts
the resulting single SQLite file read-only into the serving container at a
custom path, disables network access, and performs actual SDK stdio calls. It also
starts a detached HTTP container with bearer authentication, checks readiness and
performs SDK Streamable HTTP calls through a loopback-only published port. It uses
ignored `local/` for the mount because some macOS Docker VMs do not share OS temp
paths. The image context allowlist prevents exporting personal data to Docker.

S3 tests run Bun's real signed S3 client against a local synthetic S3 HTTP fixture,
including pagination, identical local/remote materialization, and publication
order. They use an injected ConfigProvider and no real credentials. Core tests
substitute an in-memory Exports layer and a failing Materializer to verify the
ports and cleanup. Architecture tests enforce inward dependencies.

The default CI runs typecheck/lint/tests and builds both images, then smoke-tests
the serving container. It requires no private exports or external accounts.

## Releases

The public repository starts with source-only history. Private historical work,
source exports and runtime artifacts must stay local and ignored.

1. Update package.json, CLI and MCP versions together. Importer/schema versions
   evolve separately according to their compatibility rules.
2. Run `bun run check`, build both images and run `bun run docker:smoke`.
3. Commit on main, wait for CI, then push a matching `vX.Y.Z` tag.
4. The Publish images workflow repeats all checks and publishes MCP and CLI
   images to GHCR for Linux AMD64/ARM64 with SBOM and build provenance.
5. Confirm anonymous pulls work and publish release notes linking the versioned
   images. Newly created GHCR packages may need their visibility set to public.

The workflow uses only the repository GITHUB_TOKEN with `packages: write` in
the publishing job; no registry password secret is required. Action versions
are pinned to commit hashes and Dependabot proposes monthly updates. Stable
release tags produce exact, minor, latest and full-commit SHA image tags.
Manual workflow dispatch reruns checks and publishes a commit SHA tag without
moving latest. Release tags must match package.json. Workflow concurrency avoids
overlapping runs for the same ref. Images contain application code only; user
databases are mounted at runtime and never published as release assets.
