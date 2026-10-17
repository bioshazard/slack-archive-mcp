import { Context, type Effect } from "effect";
import type { QueryError } from "../domain/errors.ts";
import type {
  ArchiveStatus,
  ChannelsResult,
  ContextOptions,
  ContextResult,
  HistoryResult,
  Page,
  SearchOptions,
  SearchResult,
  ThreadResult,
} from "../domain/queries.ts";

export class ArchiveReader extends Context.Service<
  ArchiveReader,
  {
    readonly status: Effect.Effect<ArchiveStatus, QueryError>;
    readonly channels: (
      options: Page,
    ) => Effect.Effect<ChannelsResult, QueryError>;
    readonly search: (
      options: SearchOptions,
    ) => Effect.Effect<SearchResult, QueryError>;
    readonly message: (
      id: string,
      options: Page & { versions?: boolean },
    ) => Effect.Effect<HistoryResult, QueryError>;
    readonly thread: (
      id: string,
      options: Page,
    ) => Effect.Effect<ThreadResult, QueryError>;
    readonly context: (
      id: string,
      options: ContextOptions,
    ) => Effect.Effect<ContextResult, QueryError>;
  }
>()("slack-archive-mcp/ports/ArchiveReader") {}
