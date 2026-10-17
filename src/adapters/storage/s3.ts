import { basename } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "bun";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import {
  errorMessage,
  SnapshotError,
  SourceError,
} from "../../domain/errors.ts";
import { sha256 } from "../../domain/model.ts";
import {
  fileKind,
  RelativeJsonPath,
  sourceExport,
  verifyBytes,
} from "../../domain/source.ts";
import { type ExportFile, Exports } from "../../ports/exports.ts";
import { Publisher, type Snapshot } from "../../ports/snapshots.ts";
import { makeZipCatalog, remoteZipInput, type ZipLimits } from "./zip.ts";

export function parseS3Location(location: string) {
  const url = new URL(location);
  if (
    url.protocol !== "s3:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Expected s3://bucket/prefix");
  const rawPath = location
    .slice(location.indexOf("://") + 3)
    .replace(/^[^/]+\/?/, "");
  const prefix = decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, "");
  if (prefix.split("/").some((p) => p === ".." || p === "."))
    throw new Error("Invalid S3 prefix");
  return { bucket: url.hostname, prefix: prefix ? `${prefix}/` : "" };
}

const settings = Config.all({
  endpoint: Config.String("S3_ENDPOINT").pipe(Config.withDefault("")),
  region: Config.String("AWS_REGION").pipe(Config.withDefault("us-east-1")),
  accessKeyId: Config.Redacted("AWS_ACCESS_KEY_ID").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  sessionToken: Config.Redacted("AWS_SESSION_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
});

const clientFor = Effect.fn("s3.client")(function* (location: string) {
  const target = yield* Effect.try({
    try: () => parseS3Location(location),
    catch: (cause) => new SourceError({ message: errorMessage(cause), cause }),
  });
  const config = yield* settings;
  const client = new S3Client({
    bucket: target.bucket,
    endpoint: config.endpoint || undefined,
    region: config.region,
    accessKeyId: Redacted.value(config.accessKeyId) || undefined,
    secretAccessKey: Redacted.value(config.secretAccessKey) || undefined,
    sessionToken: Redacted.value(config.sessionToken) || undefined,
  });
  return { client, ...target };
});

export function s3Exports(
  location: string,
  selected?: readonly string[],
  zipLimits?: Partial<ZipLimits>,
) {
  return Layer.effect(
    Exports,
    Effect.gen(function* () {
      const { client, prefix } = yield* clientFor(location);
      const zip = yield* makeZipCatalog(zipLimits);
      const request = <A>(operation: () => Promise<A>) =>
        Effect.tryPromise({
          try: operation,
          catch: (cause) =>
            new SourceError({
              message: `S3 source request failed: ${errorMessage(cause)}`,
              cause,
            }),
        });
      const inventory = Effect.fn("s3Exports.inventory")(function* () {
        const directZip = /\.zip$/i.test(location);
        if (directZip && selected?.length)
          return yield* new SourceError({
            message: "A direct S3 ZIP does not accept export-name selectors",
          });
        const keys: string[] = [];
        if (directZip) keys.push(prefix.slice(0, -1));
        else {
          let continuationToken: string | undefined;
          const seen = new Set<string>();
          do {
            const response = yield* request(() =>
              client.list({ prefix, continuationToken, maxKeys: 1000 }),
            );
            for (const item of response.contents ?? [])
              if (item.key.startsWith(prefix)) keys.push(item.key);
            continuationToken = response.isTruncated
              ? response.nextContinuationToken
              : undefined;
            if (
              response.isTruncated &&
              (!continuationToken || seen.has(continuationToken))
            )
              return yield* new SourceError({
                message: "S3 pagination did not advance",
              });
            if (continuationToken) seen.add(continuationToken);
          } while (continuationToken);
        }
        const groups = new Map<string, string[]>();
        const archives = new Map<string, string>();
        for (const key of keys) {
          const relative = directZip ? basename(key) : key.slice(prefix.length);
          if (
            /\.zip$/i.test(relative) &&
            (directZip ||
              !relative.includes("/") ||
              selected?.includes(relative))
          ) {
            if (!selected?.length || selected.includes(relative))
              archives.set(relative, key);
            continue;
          }
          const slash = relative.indexOf("/");
          if (slash < 1 || !relative.endsWith(".json")) continue;
          const name = relative.slice(0, slash);
          if (
            selected?.length
              ? !selected.includes(name)
              : !name.startsWith("data-")
          )
            continue;
          const group = groups.get(name) ?? [];
          group.push(key);
          groups.set(name, group);
        }
        const names = selected?.length
          ? [...selected]
          : [...groups.keys(), ...archives.keys()].sort((a, b) =>
              a.localeCompare(b, "en", { numeric: true }),
            );
        return yield* Effect.forEach(
          names,
          Effect.fnUntraced(function* (name, ordinal) {
            const archiveKey = archives.get(name);
            if (archiveKey)
              return yield* zip.load(
                remoteZipInput(archiveKey, (signal) =>
                  Readable.fromWeb(client.file(archiveKey).stream(), {
                    signal,
                  }),
                ),
                ordinal,
              );
            const files: ExportFile[] = [];
            for (const key of groups.get(name) ?? []) {
              const path = key.slice(prefix.length + name.length + 1);
              yield* Schema.decodeUnknownEffect(RelativeJsonPath)(path).pipe(
                Effect.mapError(
                  (cause) =>
                    new SourceError({
                      message: "Invalid S3 export key",
                      cause,
                    }),
                ),
              );
              const bytes = new Uint8Array(
                yield* request(() => client.file(key).arrayBuffer()),
              );
              files.push({
                locator: key,
                path,
                sha256: sha256(bytes),
                bytes: bytes.length,
                kind: fileKind(path),
              });
            }
            return yield* Effect.try({
              try: () => sourceExport(name, ordinal, files),
              catch: (cause) =>
                new SourceError({ message: errorMessage(cause), cause }),
            });
          }),
        );
      });
      const read = Effect.fn("s3Exports.read")(function* (file: ExportFile) {
        if (zip.has(file)) return yield* zip.read(file);
        const bytes = new Uint8Array(
          yield* request(() => client.file(file.locator).arrayBuffer()),
        );
        return yield* verifyBytes(file, bytes);
      });
      return Exports.of({ inventory: inventory(), read });
    }),
  );
}

export function s3Publisher(location: string) {
  return Layer.effect(
    Publisher,
    Effect.gen(function* () {
      const { client, prefix } = yield* clientFor(location);
      const publish = Effect.fn("s3Publisher.publish")(function* (
        snapshot: Snapshot,
      ) {
        const root = `${prefix}generations/${snapshot.manifest.generation}/`;
        const request = (write: () => Promise<unknown>) =>
          Effect.tryPromise({
            try: write,
            catch: (cause) =>
              new SnapshotError({
                message: `S3 publication failed: ${errorMessage(cause)}`,
                cause,
              }),
          });
        // Separate effects prevent interrupted uploads from continuing to publish
        // the pointer in an abandoned async callback.
        yield* request(() =>
          client.write(
            `${root}archive.sqlite`,
            Bun.file(snapshot.databasePath),
          ),
        );
        yield* request(() =>
          client.write(
            `${root}manifest.json`,
            JSON.stringify(snapshot.manifest),
          ),
        );
        yield* request(() =>
          client.write(
            `${prefix}current.json`,
            JSON.stringify({ generation: snapshot.manifest.generation }),
          ),
        );
      });
      return Publisher.of({ publish });
    }),
  );
}
