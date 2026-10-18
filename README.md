# slack-archive-mcp

Turn overlapping Slack exports into portable community memory: a versioned SQLite
archive with full-text search and read-only MCP tools. Built with **Effect 4 on
Bun**. MIT licensed. No embeddings or external services required.

```text
local exports ─┐
               ├─ Exports port → materialize → local SQLite snapshot
S3 exports ────┘                                  ├─ local generation store
                                                  └─ optional S3 publication

mounted SQLite → ArchiveReader port → stdio MCP → agent
```

The MCP server needs only its database. It does not need exports, S3 credentials,
an object store connection, or a writable filesystem.

## Quick start

Requires Bun 1.4.0+; dependencies are pinned by bun.lock. All tests use synthetic
exports. Put exports in ignored root `data-*` directories or native `.zip` files.

```sh
bun install --frozen-lockfile
bun run check
bun run ingest --workspace community
bun run verify
bun run search "book club" --channel bookclub --limit 5
bun run smoke
```

Default discovery naturally sorts export names oldest to newest. Explicit source
arguments preserve the order supplied:

```sh
bun run ingest ./data-2023 ./data-2025 ./data-2026 --workspace community
# Native ZIPs, extracted directories, or both; one export per ZIP:
bun run ingest ./older.zip ./data-2025 ./latest.zip --workspace community
```

Use one workspace per archive directory. Refresh preserves its namespace if
`--workspace` is omitted. Use `--archive-dir PATH` for a separate archive.
Originals stay untouched; reconciliation happens inside SQLite.

## Containerized MCP

Pull the published serving image and mount **one completed SQLite file**:

```sh
docker pull ghcr.io/bioshazard/slack-archive-mcp:2.1.0
docker run --rm -i --read-only --network none \
  --mount type=bind,src=/absolute/path/archive.sqlite,dst=/data/archive.sqlite,readonly \
  ghcr.io/bioshazard/slack-archive-mcp:2.1.0
```

This is stdio MCP: an MCP client launches the command and speaks JSON-RPC over
stdin/stdout. There is no HTTP port to expose. Keep `-i`; do not allocate a TTY.

`ARCHIVE_SQLITE_PATH` overrides the mounted file location:

```sh
docker run --rm -i --read-only --network none \
  -e ARCHIVE_SQLITE_PATH=/mounted/custom.sqlite \
  --mount type=bind,src=/absolute/path/archive.sqlite,dst=/mounted/custom.sqlite,readonly \
  ghcr.io/bioshazard/slack-archive-mcp:2.1.0
```

The image runs as the unprivileged `bun` user and contains only the bundled server
and Bun runtime. The Docker context uses an allowlist, excluding all data and Git
history. Build both images, then run `bun run docker:smoke`. It ingests synthetic
ZIPs in the CLI container and exercises MCP SDK round trips against the resulting
database mounted read-only. For local builds, run
`docker build -f Dockerfile.mcp -t slack-archive-mcp:local .` and use that image name.

Published images support Linux AMD64 and ARM64. Releases provide version tags
(`2.1.0`, `2.1`), `latest` for stable releases, and `sha-<full-commit>` tags.
Prefer an exact version or image digest for repeatable deployments. The ingest
CLI is also available as `ghcr.io/bioshazard/slack-archive-cli:2.1.0`.

Configure your MCP client using [mcp.docker.example.json](mcp.docker.example.json).
For a local Bun process, `bun run configure:mcp` generates ignored `.mcp.json`
with absolute paths; copy that entry into your client configuration. No global
client settings are modified.

## Local serving and configuration

```sh
bun run mcp --sqlite-path /absolute/path/archive.sqlite
# Or follow a local generation pointer at startup:
bun run mcp --archive-dir /absolute/path/.archive
```

| Setting | Meaning |
| --- | --- |
| `ARCHIVE_SQLITE_PATH` | Single self-contained SQLite file; ideal for containers |
| `ARCHIVE_DIR` | Local generation store, default `<repo>/.archive` for MCP |
| `--sqlite-path` / `--archive-dir` | Explicit flags override environment selection |
| `S3_ENDPOINT` | Optional S3-compatible endpoint for ingestion/publication |
| `AWS_REGION` | S3 region, default `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | S3 credentials, used only by ingestion/publication |

With no file setting, local MCP follows `current.json` once at startup. Readers
pin a generation until restarted. A standalone database embeds its snapshot
metadata; its original build timestamp is not embedded and is reported as unknown.
Never mount an actively changing SQLite database.

## S3 adapters

S3 is optional and never on the MCP query path. Input accepts native ZIP objects
or extracted JSON under `<prefix>/<export-name>/...`. Prefix discovery selects
`data-*` directories and immediate `.zip` objects. Selectors specify directory
names or ZIP filenames; their order defines precedence.

```sh
# Configure credentials in the environment or ignored .env; see .env.example.
bun run ingest --source-s3 s3://my-bucket/raw --workspace community
bun run ingest data-2023 data-2026 --source-s3 s3://my-bucket/raw
bun run ingest older.zip latest.zip --source-s3 s3://my-bucket/raw
# A direct object needs no bucket listing permission:
bun run ingest --source-s3 s3://my-bucket/raw/latest.zip
# Mix local sources and direct S3 ZIP URIs in oldest-to-newest order:
bun run ingest ./older.zip ./data-2025 s3://my-bucket/raw/latest.zip

# Publish a locally built generation to an S3-compatible store:
bun run ingest --publish-s3 s3://my-bucket/archive
```

Publication uploads SQLite, then manifest, then the current-generation pointer.
Failed remote publication leaves the completed local generation available for
retry. A failure before the pointer update leaves the remote pointer unchanged.
Use one publisher per target prefix; remote pointer updates are last-writer-wins.
Keys use SHA-256 fingerprints; S3 ETags are not treated as content hashes.

### Recommended bucket layout

Give each workspace its own prefix; keep original exports separate from derived
artifacts. For example, in a bucket named `archive-bucket`:

```text
slack/<workspace>/
  raw/
    exports/
      2024-01-01.zip
      2024-06-01.zip
      2025-01-01.zip
  archive/
    current.json
    generations/<fingerprint>/
      archive.sqlite
      manifest.json
```

Upload one original export per ZIP without repackaging. Treat those objects as
immutable: use a new filename for different bytes, even if the export date is the
same. ISO-date names sort oldest to newest; explicit source arguments can override
precedence. Prefixes organize objects; no empty folder objects are required.

```sh
bun run ingest --workspace community \
  --archive-dir .archive \
  --source-s3 s3://archive-bucket/slack/community/raw/exports \
  --publish-s3 s3://archive-bucket/slack/community/archive
```

Replace `community` with your workspace namespace in both paths and the flag.
The command reads remote ZIPs, builds and validates SQLite locally, then publishes
the completed generation and updates the remote pointer last. Keep old generations
for rollback. MCP serves a local copy of the selected completed SQLite file.

Download a completed generation's `archive.sqlite` through your preferred S3
client and mount it for MCP. Automatic cache synchronization and live Slack API
ingestion are outside this release.

ZIP input is staged as a private compressed file in the OS temporary directory,
then removed when ingestion ends. Members are never extracted. Stored/deflated
entries, ZIP64, data descriptors, and one optional enclosing export folder are
supported. JSON bytes receive CRC-32 and SHA-256 checks; citations include the
ZIP filename, container SHA-256 and original member path. Retain the source ZIP
for exact-byte evidence. Encrypted archives, links, unsafe/duplicate paths and
bundles containing multiple export roots are rejected.

Default ZIP limits: 8 GiB compressed, 100,000 entries, 256 MiB per JSON file,
8 GiB total JSON. Override with `--zip-max-archive-bytes`, `--zip-max-entries`,
`--zip-max-entry-bytes`, and `--zip-max-json-bytes`. Non-JSON members are not
decompressed or indexed. Staging requires temporary disk space for each ZIP;
JSON is read one bounded entry at a time.

The separate [Dockerfile](Dockerfile) builds the ingest/query CLI. Mount raw
exports read-only, use `--root` for their location, and mount a writable output
directory at `/output`; use `--user` when host ownership requires it. Mount only
necessary paths and pass credentials only to this ingestion container.

## Tools and retrieval

| MCP tool | Purpose |
| --- | --- |
| `archive_status` | Generation, source inventory, coverage and import warnings |
| `list_channels` | IDs, names, historical aliases and observed date ranges |
| `search` | BM25 search with channel, author, date and chronology filters |
| `get_message` | Preferred message plus optional original observations |
| `get_thread` | Conversation-scoped parent and replies |
| `get_context` | Nearby chronological messages, including unthreaded discussion |

Search supports `all`, `any`, `phrase`, and `exact` substring modes. Use `exact`
for URLs, punctuation and code; it scans text rather than using FTS. Prefix
matching applies in all/any modes. Dates are UTC `YYYY-MM-DD` or timezone-qualified
ISO timestamps: `after` inclusive, `before` exclusive.

```sh
bun run search "chapter schedule" --mode any --after 2024-01-01
bun run search "https://example.com/a_b" --mode exact
bun run search "retriev" --prefix --sort oldest --limit 10
```

Search returns stable message IDs, generation IDs and source citations. Expand
hits with thread/context tools before interpreting them. `archive://` citation
URIs identify evidence; they are not web links. Follow-up tools accept a generation
guard. Pages return `nextOffset`; context indicates whether more messages exist.
Text and raw-JSON truncation are explicitly flagged.

## Preservation and operations

- Identity includes workspace, stable conversation ID and exact timestamp string.
- All observations and their original JSON survive reconciliation. Preferred text,
  blocks, reactions and attachments come from one complete observed version.
- Explicit edits determine revision precedence; export order breaks ties. Absence
  does not prove deletion. Explicit tombstones are excluded from search.
- Invalid records are quarantined with original JSON and reasons. Builds balance
  source counts and validate SQLite, foreign keys, canonical identities and FTS.
- Completed generations are atomically published. Failed builds preserve current;
  unchanged input reuses its verified generation. Restart MCP to refresh.
- Attachment metadata/previews are searchable; linked attachment bytes are not
  downloaded. Gaps in export coverage are not filled or interpreted as activity.

Generated files live under ignored `.archive/generations/<fingerprint>/` with a
manifest and database. `bun run verify` checks the current generation's SHA-256,
SQLite integrity and accounting. Old generations are retained. After a hard kill,
remove `ingest.lock` only after confirming no importer is running.
For a standalone mount, `bun run verify --sqlite-path PATH` validates its embedded
metadata and SQLite/accounting integrity and computes its digest; verifying it
against an earlier artifact still requires that artifact's trusted manifest hash.

Anyone with the database can read its entire contents, including historical
observations. Keep audience-specific archives separate. Archived text is untrusted
source material, never agent instructions. Remote multi-user auth/ACLs are not
implemented.

## Development

[Architecture](docs/architecture.md) · [Effect conventions](docs/effect.md) ·
[Development](docs/development.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

```text
src/domain/             Schemas, identities, source/query models and errors
src/ports/              Effect service interfaces
src/application/        Materialization use case; no storage imports
src/adapters/storage/   Local and S3 export/publication implementations
src/adapters/sqlite/    Native Bun SQLite materializer and read-only query layer
src/cli.ts              Effect CLI and BunRuntime composition
src/mcp.ts              MCP SDK adapter, ManagedRuntime and scoped serving
scripts/                Smoke checks and local client configuration
tests/                 Synthetic integration and architecture checks
```

Source exports, generated databases, local reports, credentials and `.mcp.json`
are ignored. Earlier private experiments/research remain under ignored
`local/history/`; they are excluded from the public source and Docker context.
No data or credentials are supplied with this project.
