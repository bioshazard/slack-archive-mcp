import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { errorMessage, SnapshotError } from "../../domain/errors.ts";
import {
  type Manifest,
  ManifestSchema,
  object,
  PointerSchema,
} from "../../domain/model.ts";
import {
  type BuildSlot,
  Publisher,
  type Snapshot,
  Snapshots,
} from "../../ports/snapshots.ts";
import { validateDatabase } from "../sqlite/schema.ts";
import { fileDigest } from "./file-digest.ts";

const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SnapshotError({ message: errorMessage(cause), cause }),
  });

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (object(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function publishPointer(directory: string, generation: string) {
  const temporary = join(directory, `.current-${crypto.randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify({ generation })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, join(directory, "current.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function localSnapshots(directory: string) {
  const current = io(async () =>
    (await exists(join(directory, "current.json")))
      ? (await resolveSnapshot(directory)).manifest
      : undefined,
  );
  const begin = Effect.fn("localSnapshots.begin")(function* (
    generation: string,
  ) {
    const generations = join(directory, "generations");
    yield* io(() => mkdir(generations, { recursive: true, mode: 0o700 }));
    const lock = join(directory, "ingest.lock");
    yield* Effect.acquireRelease(
      io(() => mkdir(lock)).pipe(
        Effect.mapError(
          (cause) =>
            new SnapshotError({
              message: `Another import holds ${lock}. Remove it only after confirming no importer is running.`,
              cause,
            }),
        ),
      ),
      () =>
        io(() => rm(lock, { recursive: true, force: true })).pipe(Effect.orDie),
    );
    const destination = join(generations, generation);
    const databasePath = join(destination, "archive.sqlite");
    if (yield* io(() => exists(destination))) {
      const manifest = yield* io(() => readManifest(destination));
      const digest = yield* io((signal) => fileDigest(databasePath, signal));
      if (
        manifest.generation !== generation ||
        digest !== manifest.database.sha256
      ) {
        return yield* new SnapshotError({
          message: "Existing generation checksum mismatch",
        });
      }
      yield* io(() => publishPointer(directory, generation));
      const existing: Snapshot = { manifest, databasePath, reused: true };
      return {
        existing,
        databasePath,
        publish: () => Effect.succeed(existing),
      } satisfies BuildSlot;
    }
    const staging = join(generations, `.building-${crypto.randomUUID()}`);
    yield* Effect.acquireRelease(
      io(() => mkdir(staging, { mode: 0o700 })),
      () =>
        io(() => rm(staging, { recursive: true, force: true })).pipe(
          Effect.orDie,
        ),
    );
    const stagedDatabase = join(staging, "archive.sqlite");
    const publish = Effect.fn("localSnapshots.publish")(function* (
      details: Omit<Manifest, "database" | "builtAt">,
    ) {
      const digest = yield* io((signal) => fileDigest(stagedDatabase, signal));
      const bytes = yield* io(() => stat(stagedDatabase));
      const manifest: Manifest = {
        ...details,
        builtAt: new Date().toISOString(),
        database: {
          file: "archive.sqlite",
          sha256: digest,
          bytes: bytes.size,
        },
      };
      yield* io(() =>
        writeFile(
          join(staging, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        ),
      );
      yield* io(() => rename(staging, destination));
      yield* io(() => publishPointer(directory, generation));
      return { manifest, databasePath, reused: false };
    });
    return { databasePath: stagedDatabase, publish } satisfies BuildSlot;
  });
  return Layer.succeed(Snapshots, Snapshots.of({ current, begin }));
}

export const localPublisher = Layer.succeed(
  Publisher,
  Publisher.of({ publish: () => Effect.void }),
);

export async function readManifest(directory: string): Promise<Manifest> {
  return Schema.decodeUnknownSync(Schema.fromJsonString(ManifestSchema))(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
}

export async function resolveSnapshot(
  directory: string,
): Promise<{ databasePath: string; manifest: Manifest }> {
  const pointer = Schema.decodeUnknownSync(
    Schema.fromJsonString(PointerSchema),
  )(await readFile(join(directory, "current.json"), "utf8"));
  const path = join(directory, "generations", pointer.generation);
  const manifest = await readManifest(path);
  if (manifest.generation !== pointer.generation)
    throw new Error("Snapshot generation mismatch");
  const databasePath = join(path, "archive.sqlite");
  if ((await stat(databasePath)).size !== manifest.database.bytes)
    throw new Error("Database size does not match manifest");
  return { databasePath, manifest };
}

export async function verifySnapshot(directory: string): Promise<Manifest> {
  const { databasePath, manifest } = await resolveSnapshot(directory);
  if ((await fileDigest(databasePath)) !== manifest.database.sha256)
    throw new Error("Database checksum does not match manifest");
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    validateDatabase(db);
  } finally {
    db.close(true);
  }
  return manifest;
}
