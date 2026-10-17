import { Context, type Effect } from "effect";
import type { MaterializationError, SourceError } from "../domain/errors.ts";
import type { Counts, Manifest } from "../domain/model.ts";
import type { Exports, SourceExport } from "./exports.ts";

export interface Materialization {
  readonly counts: Counts;
  readonly coverage: Manifest["coverage"];
  readonly warnings: string[];
}

export class Materializer extends Context.Service<
  Materializer,
  {
    readonly build: (options: {
      readonly databasePath: string;
      readonly generation: string;
      readonly workspace: string;
      readonly sources: readonly SourceExport[];
    }) => Effect.Effect<
      Materialization,
      MaterializationError | SourceError,
      Exports
    >;
  }
>()("slack-archive-mcp/ports/Materializer") {}
