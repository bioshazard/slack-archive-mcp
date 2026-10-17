import { Context, type Effect } from "effect";
import type { SourceError } from "../domain/errors.ts";

import type { ExportFile, SourceExport } from "../domain/source.ts";

export type { ExportFile, SourceExport } from "../domain/source.ts";

export class Exports extends Context.Service<
  Exports,
  {
    readonly inventory: Effect.Effect<readonly SourceExport[], SourceError>;
    readonly read: (file: ExportFile) => Effect.Effect<Uint8Array, SourceError>;
  }
>()("slack-archive-mcp/ports/Exports") {}
