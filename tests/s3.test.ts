import { expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConfigProvider, Effect } from "effect";
import { parseS3Location } from "../src/adapters/storage/s3.ts";
import { ingestEffect } from "../src/ingest.ts";
import { fixture } from "./fixture.ts";
import { exportZip } from "./zip-fixture.ts";

test("S3 adapters paginate real HTTP requests, preserve local identities and publish the pointer last", async () => {
  const f = await fixture();
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const tokens: string[] = [];
  let rejectManifest = false;
  async function seed(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await seed(path);
      else if (entry.name.endsWith(".json"))
        objects.set(`raw/${relative(f.root, path)}`, await readFile(path));
    }
  }
  await seed(join(f.root, "data-2023"));
  await seed(join(f.root, "data-2026"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const key = decodeURIComponent(
        url.pathname.replace(/^\/test-bucket\/?/, ""),
      );
      if (!request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256"))
        return new Response("Unsigned request", { status: 403 });
      if (
        request.method === "GET" &&
        url.searchParams.get("list-type") === "2"
      ) {
        const token = url.searchParams.get("continuation-token") ?? "0";
        tokens.push(token);
        const start = Number(token);
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(url.searchParams.get("prefix") ?? ""))
          .sort();
        const keysPage = keys.slice(start, start + 2);
        const truncated = start + 2 < keys.length;
        return new Response(
          `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix>raw/</Prefix><KeyCount>${keysPage.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${keysPage.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.length}</Size><ETag>"test"</ETag><LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>`).join("")}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (request.method === "GET") {
        const bytes = objects.get(key);
        return bytes
          ? new Response(bytes, {
              headers: { "content-type": "application/octet-stream" },
            })
          : new Response("Missing", { status: 404 });
      }
      if (request.method === "PUT") {
        if (rejectManifest && key.endsWith("manifest.json"))
          return new Response("Denied", { status: 403 });
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        writes.push(key);
        return new Response(null, { headers: { etag: '"test"' } });
      }
      return new Response("Unsupported", { status: 400 });
    },
  });
  try {
    const provider = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        S3_ENDPOINT: server.url.toString(),
        AWS_ACCESS_KEY_ID: "synthetic-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret",
        AWS_REGION: "us-east-1",
      }),
    );
    const result = await Effect.runPromise(
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "s3-output"),
        sourceS3: "s3://test-bucket/raw",
        publishS3: "s3://test-bucket/published",
      }).pipe(Effect.provide(provider)),
    );
    expect(tokens.length).toBeGreaterThan(1);
    expect(result.manifest.generation).toBe(f.manifest.generation);
    expect(result.manifest.database.sha256).toBe(f.manifest.database.sha256);
    expect(writes.map((k) => k.split("/").at(-1))).toEqual([
      "archive.sqlite",
      "manifest.json",
      "current.json",
    ]);
    expect(
      objects.get(
        `published/generations/${result.manifest.generation}/archive.sqlite`,
      ),
    ).toEqual(await readFile(f.databasePath));
    const beforePointer = objects.get("published/current.json");
    const rawKey = "raw/data-2026/general/2024-01-01.json";
    const records = JSON.parse(new TextDecoder().decode(objects.get(rawKey)));
    records[1].text = "Changed S3 evidence";
    objects.set(rawKey, new TextEncoder().encode(JSON.stringify(records)));
    const refresh = () =>
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "s3-output"),
        sourceS3: "s3://test-bucket/raw",
        publishS3: "s3://test-bucket/published",
      }).pipe(Effect.provide(provider));
    rejectManifest = true;
    const failure = await Effect.runPromise(refresh().pipe(Effect.flip));
    expect(failure._tag).toBe("SnapshotError");
    expect(objects.get("published/current.json")).toEqual(beforePointer);
    const localPointer = JSON.parse(
      await readFile(join(f.root, "s3-output/current.json"), "utf8"),
    );
    expect(localPointer.generation).not.toBe(result.manifest.generation);
    rejectManifest = false;
    const retried = await Effect.runPromise(refresh());
    expect(retried.reused).toBe(true);
    expect(
      JSON.parse(
        new TextDecoder().decode(objects.get("published/current.json")),
      ).generation,
    ).toBe(localPointer.generation);
    objects.set(
      "raw/data-2026.zip",
      await exportZip(
        join(f.root, "data-2026"),
        join(f.root, "data-2026.zip"),
        "Export/",
      ),
    );
    objects.set(
      "raw/data-2023.zip",
      await exportZip(join(f.root, "data-2023"), join(f.root, "data-2023.zip")),
    );
    const pagesBefore = tokens.length;
    const direct = await Effect.runPromise(
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "direct-zip"),
        sourceS3: "s3://test-bucket/raw/data-2026.zip",
      }).pipe(Effect.provide(provider)),
    );
    expect(direct.manifest.counts.messages).toBe(7);
    expect(direct.manifest.sources[0]?.archive?.entryPrefix).toBe("Export/");
    expect(tokens.length).toBe(pagesBefore); // Direct objects need GetObject, not ListBucket.
    const selectedZip = await Effect.runPromise(
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "selected-zip"),
        sourceS3: "s3://test-bucket/raw",
        sources: ["data-2026.zip"],
      }).pipe(Effect.provide(provider)),
    );
    expect(selectedZip.manifest.generation).toBe(direct.manifest.generation);
    const mixed = await Effect.runPromise(
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "mixed-zip"),
        sources: ["data-2023", "s3://test-bucket/raw/data-2026.zip"],
      }).pipe(Effect.provide(provider)),
    );
    expect(mixed.manifest.counts).toEqual(f.manifest.counts);
    const remoteFiles = await Effect.runPromise(
      ingestEffect({
        root: f.root,
        workspace: "test",
        archiveDir: join(f.root, "remote-zips"),
        sources: [
          "s3://test-bucket/raw/data-2023.zip",
          "s3://test-bucket/raw/data-2026.zip",
        ],
      }).pipe(Effect.provide(provider)),
    );
    expect(remoteFiles.manifest.counts).toEqual(f.manifest.counts);
  } finally {
    await server.stop(true);
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);

test("S3 locations reject embedded credentials and traversal", () => {
  expect(parseS3Location("s3://bucket/raw/")).toEqual({
    bucket: "bucket",
    prefix: "raw/",
  });
  expect(() => parseS3Location("https://example.invalid/raw")).toThrow();
  expect(() => parseS3Location("s3://user:password@bucket/raw")).toThrow();
  expect(() => parseS3Location("s3://bucket/raw?token=secret")).toThrow();
  expect(() => parseS3Location("s3://bucket/raw/../other")).toThrow();
});
