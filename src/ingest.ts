import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { sqliteMaterializer } from "./adapters/sqlite/materializer.ts";
import { localExports } from "./adapters/storage/local-exports.ts";
import {
  localPublisher,
  localSnapshots,
} from "./adapters/storage/local-snapshots.ts";
import { mixedExports } from "./adapters/storage/mixed-exports.ts";
import { s3Exports, s3Publisher } from "./adapters/storage/s3.ts";
import type { ZipLimits } from "./adapters/storage/zip.ts";
import { materializeArchive } from "./application/materialize.ts";

export {
  resolveSnapshot,
  verifySnapshot,
} from "./adapters/storage/local-snapshots.ts";
export interface IngestOptions {
  root?: string;
  sources?: readonly string[];
  archiveDir?: string;
  workspace?: string;
  sourceS3?: string;
  publishS3?: string;
  progress?: (message: string) => void;
  zipLimits?: Partial<ZipLimits>;
}

export function ingestEffect(options: IngestOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const archiveDir = resolve(options.archiveDir ?? join(root, ".archive"));
  const exports = options.sourceS3
    ? s3Exports(options.sourceS3, options.sources, options.zipLimits)
    : (options.sources?.some((s) => s.startsWith("s3://"))
        ? mixedExports
        : localExports)({
        root,
        sources: options.sources ?? [],
        archiveDir,
        progress: options.progress,
        zipLimits: options.zipLimits,
      });
  const publisher = options.publishS3
    ? s3Publisher(options.publishS3)
    : localPublisher;
  return materializeArchive({ workspace: options.workspace }).pipe(
    Effect.provide(
      Layer.mergeAll(
        exports,
        localSnapshots(archiveDir),
        sqliteMaterializer,
        publisher,
      ),
    ),
  );
}

// Promise interoperability for non-Effect callers; application logic stays in Effect.
export function ingest(options: IngestOptions = {}) {
  return Effect.runPromise(ingestEffect(options));
}
