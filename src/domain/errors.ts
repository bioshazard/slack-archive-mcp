import { Schema } from "effect";

export class SourceError extends Schema.TaggedError<SourceError>()(
  "SourceError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class SnapshotError extends Schema.TaggedError<SnapshotError>()(
  "SnapshotError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class MaterializationError extends Schema.TaggedError<MaterializationError>()(
  "MaterializationError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
