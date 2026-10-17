import { Effect, Schema } from "effect";
import { SourceError } from "./errors.ts";
import { sha256 } from "./model.ts";
export interface ExportFile {
  readonly locator: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: "messages" | "metadata";
}

export interface SourceExport {
  readonly name: string;
  readonly ordinal: number;
  readonly files: readonly ExportFile[];
  readonly sha256: string;
  readonly archive?: {
    readonly format: "zip";
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly entryPrefix: string;
  };
}

export const ExportName = Schema.String.check(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Export labels may contain spaces, but not separators/control characters.
  Schema.isPattern(/^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/),
);
export const RelativeJsonPath = Schema.String.check(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL must be rejected in source paths.
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000]+\.json$/),
);

export function sourceExport(
  name: string,
  ordinal: number,
  files: readonly ExportFile[],
): SourceExport {
  Schema.decodeUnknownSync(ExportName)(name);
  for (const file of files)
    Schema.decodeUnknownSync(RelativeJsonPath)(file.path);
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new Error(`Duplicate source paths in ${name}`);
  if (!files.some((f) => f.kind === "messages"))
    throw new Error(`No daily message files in ${name}`);
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    name,
    ordinal,
    files: sorted,
    sha256: sha256(JSON.stringify(sorted.map((f) => [f.path, f.sha256]))),
  };
}

export function summarizeSources(sources: readonly SourceExport[]) {
  return sources.map((s) => ({
    name: s.name,
    ordinal: s.ordinal,
    sha256: s.sha256,
    files: s.files.length,
    ...(s.archive ? { archive: s.archive } : {}),
  }));
}

export function fileKind(path: string): ExportFile["kind"] {
  return path.includes("/") && /(?:^|\/)\d{4}-\d{2}-\d{2}\.json$/.test(path)
    ? "messages"
    : "metadata";
}

export function verifyBytes(file: ExportFile, bytes: Uint8Array) {
  return sha256(bytes) === file.sha256
    ? Effect.succeed(bytes)
    : Effect.fail(
        new SourceError({
          message: `Source changed during import: ${file.path}`,
        }),
      );
}
