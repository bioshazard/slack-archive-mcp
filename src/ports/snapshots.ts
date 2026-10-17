import { Context, type Effect, type Scope } from "effect";
import type { SnapshotError } from "../domain/errors.ts";
import type { Manifest } from "../domain/model.ts";

export interface Snapshot {
  readonly manifest: Manifest;
  readonly databasePath: string;
  readonly reused: boolean;
}

export interface BuildSlot {
  readonly existing?: Snapshot;
  readonly databasePath: string;
  readonly publish: (
    details: Omit<Manifest, "database" | "builtAt">,
  ) => Effect.Effect<Snapshot, SnapshotError>;
}

export class Snapshots extends Context.Service<
  Snapshots,
  {
    readonly current: Effect.Effect<Manifest | undefined, SnapshotError>;
    readonly begin: (
      generation: string,
    ) => Effect.Effect<BuildSlot, SnapshotError, Scope.Scope>;
  }
>()("slack-archive-mcp/ports/Snapshots") {}

export class Publisher extends Context.Service<
  Publisher,
  {
    readonly publish: (
      snapshot: Snapshot,
    ) => Effect.Effect<void, SnapshotError>;
  }
>()("slack-archive-mcp/ports/Publisher") {}
