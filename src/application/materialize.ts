import { Effect } from "effect";
import { MaterializationError } from "../domain/errors.ts";
import { IMPORTER_VERSION, SCHEMA_VERSION, sha256 } from "../domain/model.ts";
import { summarizeSources } from "../domain/source.ts";
import { Exports } from "../ports/exports.ts";
import { Materializer } from "../ports/materializer.ts";
import { Publisher, Snapshots } from "../ports/snapshots.ts";

export const materializeArchive = Effect.fn("archive.materialize")(function* (
  options: { workspace?: string } = {},
) {
  const exports = yield* Exports;
  const snapshots = yield* Snapshots;
  const materializer = yield* Materializer;
  const publisher = yield* Publisher;
  const previous = yield* snapshots.current;
  const workspace = options.workspace ?? previous?.workspace ?? "local";
  if (!workspace.trim())
    return yield* new MaterializationError({
      message: "Workspace must not be empty",
    });
  if (previous && previous.workspace !== workspace) {
    return yield* new MaterializationError({
      message:
        "Workspace differs from the existing archive; use a separate --archive-dir",
    });
  }
  const sources = yield* exports.inventory;
  if (!sources.length)
    return yield* new MaterializationError({
      message: "No source exports found",
    });
  if (new Set(sources.map((s) => s.name)).size !== sources.length) {
    return yield* new MaterializationError({
      message: "Source export directory names must be unique",
    });
  }
  const sourceSummary = summarizeSources(sources);
  const generation = sha256(
    JSON.stringify({
      schema: SCHEMA_VERSION,
      importer: IMPORTER_VERSION,
      workspace,
      sources: sourceSummary,
    }),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const slot = yield* snapshots.begin(generation);
      const snapshot =
        slot.existing ??
        (yield* Effect.gen(function* () {
          const built = yield* materializer.build({
            databasePath: slot.databasePath,
            generation,
            workspace,
            sources,
          });
          return yield* slot.publish({
            schemaVersion: SCHEMA_VERSION,
            importerVersion: IMPORTER_VERSION,
            generation,
            workspace,
            sources: sourceSummary,
            ...built,
          });
        }));
      // Publishing the same immutable generation is deliberately retryable.
      yield* publisher.publish(snapshot);
      return snapshot;
    }),
  );
});
