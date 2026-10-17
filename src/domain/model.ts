import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";

export const SCHEMA_VERSION = 1;
export const IMPORTER_VERSION = "2.1.0";
export type JsonObject = Record<string, unknown>;

export const object = Predicate.isObject;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function messageId(
  workspace: string,
  channel: string,
  ts: string,
): string {
  return `m_${sha256(JSON.stringify([workspace, channel, ts]))}`;
}

export function timestamp(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && /^\d{1,16}(?:\.\d{1,9})?$/.test(text)
    ? text
    : null;
}

// Decimal ordering without rounding Slack's exact timestamp identity.
export function timestampOrder(ts: string): string {
  const [seconds = "", fraction = ""] = ts.split(".");
  return `${seconds.padStart(20, "0")}.${fraction.padEnd(9, "0")}`;
}

export function timestampIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

export function searchableText(
  raw: JsonObject,
  users: Map<string, string>,
): string {
  const parts: string[] = [typeof raw.text === "string" ? raw.text : ""];
  function visit(value: unknown, depth = 0): void {
    if (depth > 30) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (object(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (
          ["text", "title", "name", "fallback", "description"].includes(key) &&
          typeof item === "string"
        ) {
          parts.push(item);
        } else if (typeof item === "object") visit(item, depth + 1);
      }
    }
  }
  visit(raw.attachments);
  visit(raw.files);
  if (!raw.text) visit(raw.blocks);
  return [...new Set(parts)]
    .join("\n")
    .replace(
      /<@([A-Z0-9]+)(?:\|[^>]+)?>/g,
      (match, id: string) => `${match} ${users.get(id) ?? id}`,
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export interface Counts {
  exports: number;
  files: number;
  observations: number;
  messages: number;
  rejected: number;
  conflicts: number;
  deleted: number;
  missingThreadParents: number;
}

export type Manifest = typeof ManifestSchema.Type;

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SnapshotDetails = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  importerVersion: Schema.NonEmptyString,
  generation: Digest,
  workspace: Schema.NonEmptyString,
  sources: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      ordinal: Count,
      sha256: Digest,
      files: Count,
      archive: Schema.optionalKey(
        Schema.Struct({
          format: Schema.Literal("zip"),
          file: Schema.NonEmptyString,
          sha256: Digest,
          bytes: Count,
          entryPrefix: Schema.String,
        }),
      ),
    }),
  ),
  counts: Schema.Struct({
    exports: Count,
    files: Count,
    observations: Count,
    messages: Count,
    rejected: Count,
    conflicts: Count,
    deleted: Count,
    missingThreadParents: Count,
  }),
  coverage: Schema.Struct({
    first: Schema.NullOr(Schema.String),
    last: Schema.NullOr(Schema.String),
  }),
  warnings: Schema.Array(Schema.String),
});
export const ManifestSchema = Schema.Struct({
  ...SnapshotDetails.fields,
  builtAt: Schema.String,
  database: Schema.Struct({
    file: Schema.Literal("archive.sqlite"),
    sha256: Digest,
    bytes: Count,
  }),
});
export const PointerSchema = Schema.Struct({ generation: Digest });
