import { Context, Effect, Layer } from "effect";
import { SourceError } from "../../domain/errors.ts";
import { Exports, type SourceExport } from "../../ports/exports.ts";
import { type LocalExportOptions, localExports } from "./local-exports.ts";
import { s3Exports } from "./s3.ts";

// Compose independent scoped adapters without leaking transport decisions inward.
export function mixedExports(
  options: LocalExportOptions & { sources: readonly string[] },
) {
  return Layer.effect(
    Exports,
    Effect.gen(function* () {
      const adapters: Exports["Service"][] = [];
      for (const source of options.sources) {
        if (source.startsWith("s3://") && !/\.zip$/i.test(source))
          return yield* new SourceError({
            message:
              "Positional S3 sources must be ZIP objects; use --source-s3 for a prefix",
          });
        const layer = source.startsWith("s3://")
          ? s3Exports(source, undefined, options.zipLimits)
          : localExports({ ...options, sources: [source] });
        adapters.push(Context.get(yield* Layer.build(layer), Exports));
      }
      const readers = new Map<string, Exports["Service"]>();
      const inventory = Effect.fn("mixedExports.inventory")(function* () {
        const result: SourceExport[] = [];
        for (const adapter of adapters) {
          for (const source of yield* adapter.inventory) {
            for (const file of source.files) readers.set(file.locator, adapter);
            result.push({ ...source, ordinal: result.length });
          }
        }
        return result;
      });
      return Exports.of({
        inventory: inventory(),
        read: (file) => {
          const reader = readers.get(file.locator);
          return reader
            ? reader.read(file)
            : Effect.fail(
                new SourceError({ message: "Source was not inventoried" }),
              );
        },
      });
    }),
  );
}
