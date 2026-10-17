import { expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { sqliteMaterializer } from "../src/adapters/sqlite/materializer.ts";
import { localExports } from "../src/adapters/storage/local-exports.ts";
import {
  localPublisher,
  localSnapshots,
} from "../src/adapters/storage/local-snapshots.ts";
import { materializeArchive } from "../src/application/materialize.ts";
import { MaterializationError } from "../src/domain/errors.ts";
import { Exports } from "../src/ports/exports.ts";
import { Materializer } from "../src/ports/materializer.ts";
import { fixture } from "./fixture.ts";

test("application accepts an in-memory export adapter and produces byte-identical SQLite", async () => {
  const f = await fixture();
  try {
    const memory = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* Exports;
        const inventory = yield* source.inventory;
        const bytes = new Map<string, Uint8Array>();
        for (const exportSet of inventory)
          for (const file of exportSet.files)
            bytes.set(file.locator, yield* source.read(file));
        return Exports.of({
          inventory: Effect.succeed(inventory),
          read: (file) =>
            Effect.succeed(bytes.get(file.locator) ?? new Uint8Array()),
        });
      }).pipe(
        Effect.provide(
          localExports({ root: f.root, archiveDir: f.archiveDir }),
        ),
      ),
    );
    const result = await Effect.runPromise(
      materializeArchive({ workspace: "test" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Exports, memory),
            sqliteMaterializer,
            localSnapshots(join(f.root, "memory-output")),
            localPublisher,
          ),
        ),
      ),
    );
    expect(result.manifest.generation).toBe(f.manifest.generation);
    expect(result.manifest.database.sha256).toBe(f.manifest.database.sha256);
    expect(await readFile(result.databasePath)).toEqual(
      await readFile(f.databasePath),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("typed materializer failures finalize staging/lock and preserve the current pointer", async () => {
  const f = await fixture();
  try {
    const pointer = await readFile(join(f.archiveDir, "current.json"), "utf8");
    const failed = new MaterializationError({
      message: "Injected adapter failure",
    });
    const outcome = await Effect.runPromise(
      materializeArchive({ workspace: "test" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            localExports({
              root: f.root,
              sources: ["data-2026"],
              archiveDir: f.archiveDir,
            }),
            localSnapshots(f.archiveDir),
            localPublisher,
            Layer.succeed(
              Materializer,
              Materializer.of({ build: () => Effect.fail(failed) }),
            ),
          ),
        ),
        Effect.flip,
      ),
    );
    expect(outcome).toBe(failed);
    expect(await readFile(join(f.archiveDir, "current.json"), "utf8")).toBe(
      pointer,
    );
    expect(await readdir(f.archiveDir)).not.toContain("ingest.lock");
    expect(
      (await readdir(join(f.archiveDir, "generations"))).some((n) =>
        n.startsWith(".building"),
      ),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
