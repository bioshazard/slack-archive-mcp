import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.ts";
import { exportZip } from "./zip-fixture.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function run(root: string, ...args: string[]) {
  const process = Bun.spawn(
    [Bun.which("bun") ?? "bun", cli, ...args, "--root", root],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI imports local sources, verifies, queries and fails cleanly without partial publication", async () => {
  const f = await fixture();
  try {
    const built = await run(f.root, "ingest", "--workspace", "test");
    expect(built.code).toBe(0);
    expect(JSON.parse(built.stdout).reused).toBe(true);
    expect(built.stderr).toContain("Inventory");
    const verified = await run(f.root, "verify");
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout).verified).toBe(true);
    const standalone = await run(
      f.root,
      "verify",
      "--sqlite-path",
      f.databasePath,
    );
    expect(standalone.code).toBe(0);
    expect(JSON.parse(standalone.stdout).generation).toBe(
      f.manifest.generation,
    );
    const searched = await run(
      f.root,
      "search",
      "revised plan",
      "--channel",
      "general",
    );
    expect(searched.code).toBe(0);
    expect(JSON.parse(searched.stdout).results).toHaveLength(1);
    const invalid = await run(f.root, "search", "plan", "--mode", "unknown");
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid value for flag --mode");
    const zipPath = join(f.root, "data-2026.zip");
    await exportZip(join(f.root, "data-2026"), zipPath);
    const zipped = await run(f.root, "ingest", zipPath);
    expect(zipped.code).toBe(0);
    expect(JSON.parse(zipped.stdout).sources[0].archive.format).toBe("zip");
    const limited = await run(
      f.root,
      "ingest",
      zipPath,
      "--zip-max-entries",
      "1",
    );
    expect(limited.code).toBe(1);
    expect(limited.stderr).toContain("entry count limit");
    await rm(zipPath);
    const pointer = await readFile(join(f.archiveDir, "current.json"), "utf8");
    await writeFile(
      join(f.root, "data-2026/general/2024-01-01.json"),
      "broken",
    );
    const failed = await run(f.root, "ingest", "--workspace", "test");
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(await readFile(join(f.archiveDir, "current.json"), "utf8")).toBe(
      pointer,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);
