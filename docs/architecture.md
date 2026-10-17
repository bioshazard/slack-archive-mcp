# Archive architecture

## Goal and boundaries

Make overlapping exports useful to an agent reconstructing community history:
find evidence, expand conversation context, inspect disagreements, cite originals.
Storage preserves observations; reconciliation creates a preferred view; search
retrieves evidence; the agent performs interpretation.

One snapshot contains one explicitly named workspace. Different workspaces or
audiences use separate archive directories. Raw data is local `data-*`; SQLite
is a rebuildable materialization. No intermediate merged export is necessary.
Refresh preserves the existing workspace namespace. Output inside a source
directory is rejected to prevent modifying or recursively ingesting source data.

## Hexagonal structure and Effect composition

`src/domain` owns schemas, identity, normalization and source/query models.
`src/ports` declares Effect Context.Service interfaces. `src/application` contains
materialization orchestration and imports only ports/domain. Storage, SQLite and
MCP are adapters wired by entrypoints; the core never chooses a transport.

| Port | Interface responsibility | Implementations |
| --- | --- | --- |
| `Exports` | Inventory export files and read verified bytes | Local filesystem, S3, test memory adapter |
| `Materializer` | Turn observations into a validated local database | Bun SQLite prepared transactions + FTS5 |
| `Snapshots` | Scoped staging/lock, verified reuse and atomic local publication | Local generation store |
| `Publisher` | Optionally distribute a completed immutable artifact | Local-only completion, S3 publication |
| `ArchiveReader` | Bounded read-only archive queries | Scoped Bun SQLite reader |

The materializer always builds locally. S3 provides source bytes or receives
completed artifacts; it never hosts a live SQLite handle. Native database details
stay behind the SQLite adapter. No generic storage abstraction pretends that a
remote object PUT can replace a local SQLite transaction or atomic file rename.

Effects carry source, snapshot, materialization and query errors explicitly.
Scopes own locks, staging directories, database handles and serving runtimes.
`ManagedRuntime` integrates the official MCP SDK with the reader layer;
`BunRuntime.runMain` manages process signals. Schema validates manifests, source
paths and decoded input. See effect.md for the pinned Effect 4 conventions.

## Ingestion

1. Discover `data-*` directories and ZIP files, or accept an explicit ordered
   list of local directories/ZIPs and direct S3 ZIP objects.
2. Inventory every JSON file with relative path, SHA-256 and byte size.
3. Fingerprint source inventories, source order, workspace namespace, schema
   version and importer version, including ZIP container provenance. Reuse only
   if a completed snapshot's hash matches.
4. Import into a unique staging directory under a single-writer lock. Verify each
   source hash while reading; malformed JSON or invalid metadata aborts the build.
5. Load channel/user metadata, including historical channel aliases. Daily JSON
   files produce observations; invalid records go to `rejected_records` with their
   original JSON, position and reason. No author requirement excludes bots or
   system messages. All source-file record counts must balance.
6. Materialize canonical messages, build FTS5 and validate integrity/accounting.
7. Close SQLite, hash the completed file, write its manifest, rename the generation,
   then atomically replace `current.json`. No live database file is copied.

The database also embeds snapshot metadata excluding its own checksum and build
time. This keeps deterministic database bytes while allowing a single mounted
file to serve independently of the directory manifest. Standalone status computes
the file hash and reports the original build time as unknown.

Symlinks in exports are rejected. Original files are never modified. Non-daily
JSON is inventoried and parsed as metadata, never mistaken for message history.
Non-JSON files are outside this pipeline's inventory; retain original export
directories separately. Initial snapshot construction can be rerun from scratch.

Explicit source order is oldest to newest. Default `data-*` discovery uses natural
source-name order, **not a claimed export timestamp**. File mtimes are not used
as message revision dates. Name exports accordingly or supply explicit order.

The ZIP catalog is shared by local and S3 source adapters, behind `Exports`.
Its Effect scope owns private compressed staging files and ZIP handles. Lazy
central-directory enumeration bounds entry counts and declared JSON sizes;
streamed reads enforce actual size, CRC-32 and SHA-256. No member path is written
to disk. The inventory hashes original uncompressed JSON; optional container
metadata records ZIP bytes/hash and wrapper prefix. Repackaging changes generation
provenance while canonical message IDs remain stable. ZIPs need not be converted
to an intermediate merged export or extracted tree.

## Identity and observations

Message identity is `(workspace namespace, conversation ID, exact ts string)`.
A SHA-256 of that tuple provides a stable public message ID. The original timestamp
string is preserved; padded decimal sort keys avoid floating-point identity loss.
ISO timestamps are presentation values with millisecond precision.

Channel metadata supplies stable conversation IDs; folder names supply aliases.
Slack file-conversation folders (`FC:<file-id>:<title>`) use the stable file ID
portion, so changing a canvas title does not duplicate the conversation. Other
unmapped folders get a clearly marked inferred identity and manifest warning.
Never infer cross-channel equivalence from text, names or `client_msg_id`.

An observation preserves source export, file, zero-based record index, original
JSON and its hash. `source_files` preserves hashes of original JSON files; hashes
of raw records use the JSON serialization stored in the database, not original
whitespace. The preferred message references its selected observation.

## Reconciliation

For each identity, select a **whole observed payload**, ordered by:

1. Latest `edited.ts`, or original message `ts` if no edit timestamp exists.
   For an explicit deletion event, use the deletion event timestamp and identify
   the message via `deleted_ts`.
2. Later source-export ordinal when revision timestamps tie.
3. Source path and record index for deterministic remaining ties.

Text, blocks, reactions and attachment metadata come from that same observation.
Do not choose the longest text or union reactions across snapshots. Historical
observations remain available; preferred state means best supported by these
ordering rules, not a guarantee of Slack's present state. Export absence alone
never establishes deletion. An older explicit edit can outrank a later export
whose record lacks edit metadata; inspect observations when resolving ambiguity.

Explicit deleted messages become tombstones. Search excludes them, and ordinary
context hides their text; optional history inspection still exposes preserved
historical observations to the trusted local owner.

## Schema

| Table | Responsibility |
| --- | --- |
| `metadata` | Workspace, generation and embedded portable snapshot details |
| `source_exports` | Export identity, precedence and inventory hash |
| `source_files` | Relative file path, byte hash, size and source record count |
| `observations` | Accepted message payloads with provenance and revision order |
| `rejected_records` | Quarantined daily records, reason, position and original JSON |
| `channels`, `channel_aliases` | Preferred metadata and historic names |
| `users` | Preferred user metadata; author IDs remain source identities |
| `messages` | Canonical message view, thread links and selected observation |
| `message_fts` | External-content FTS5 over preferred searchable text |

Thread links are conversation-scoped. Missing parents remain explicit; import
does not fabricate messages or infer nested reply relationships from prose.
Canonical counts can differ from simple folder-name deduplication after renames.
`conflicts` counts identities with differing complete payloads, including changes
to reactions/profiles; it does not mean that every such message has edited text.

## Search and retrieval

Index the preferred message text plus attachment names/titles/previews. If plain
text is absent, extract text from blocks. Expand user mentions using the export's
metadata while keeping original text intact. The default Unicode tokenizer handles
terms; quoted FTS expressions are generated from input tokens, never raw SQL.
All predicates use bound parameters. Exact substring mode preserves punctuation
and scans preferred searchable text. Its non-ASCII case folding follows SQLite's
default `lower()` behavior and is not linguistically complete.

Search supports metadata filters, BM25 ranking or explicit chronology, and stable
tie-breaking. Pagination is valid within a pinned generation. Fetch threads and
nearby messages after discovery. Source citations identify export, relative file,
record index, generation, payload hash and whole-file hash.

Query-only connections enforce read access. Tool inputs validate limits. Search,
list, thread and observation-history retrieval are paginated; context is bounded.
Text/JSON windows flag truncation. There is no arbitrary SQL, filesystem, URL fetch
or mutation tool. All results are untrusted archive content.

## Operations and evolution

Ingest runs on demand. MCP uses stdio and opens the snapshot once at startup. `ARCHIVE_SQLITE_PATH` selects
a single mounted file; `ARCHIVE_DIR` selects a generation directory. Explicit CLI
flags override environment selection. The non-root Docker serving image bundles
only the server and Bun runtime, and needs neither S3 credentials nor exports.
Existing readers retain a consistent generation when a new one is published;
restart the client connection to refresh. `generation` guards reject mismatched
follow-up queries rather than silently switching snapshots.

Snapshots are self-contained: a database and manifest can move together to
`<archive-dir>/generations/<generation>/`, with a matching `current.json` pointer.
The original files need not be mounted for search; their locations and hashes
remain citation metadata. Retain originals for recovery and exact-byte inspection.
No automatic generation pruning or background daemon is required.

If materialization rules change, bump `IMPORTER_VERSION`; if the schema contract
changes incompatibly, bump `SCHEMA_VERSION`. Old snapshots remain available but
the current reader rejects unsupported schema versions. The S3 publisher ships completed generations without changing the query layer.
It writes database and manifest before the remote pointer; its writes are separate
effects so interruption cannot continue the whole publication in an abandoned
async callback. A failed remote publish retains the completed local generation
for retry. Remote prefixes require a single writer; pointer updates otherwise
follow last-writer-wins semantics. Remote source inventories are paginated and
read bytes are rehashed; ETags do not substitute for content checksums.

Embeddings, remote multi-user hosting, ACLs, attachment downloads and live Slack
incremental ingestion are separate future requirements. Validate concrete lexical
search misses before introducing semantic retrieval.
