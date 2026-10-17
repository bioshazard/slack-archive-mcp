import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
test("domain and application dependencies point inward", async () => {
  for (const directory of ["domain", "application", "ports"]) {
    for (const file of await readdir(join(root, "src", directory))) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(root, "src", directory, file), "utf8");
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(
        imports.some(
          (i) =>
            i?.includes("adapters") ||
            i?.includes("bun:sqlite") ||
            i?.includes("modelcontextprotocol"),
        ),
      ).toBe(false);
      if (directory === "domain")
        expect(
          imports.some(
            (i) => i?.includes("ports") || i?.includes("application"),
          ),
        ).toBe(false);
    }
  }
});

test("Docker context is an allowlist and serving image has no data COPY or root runtime", async () => {
  const ignore = await readFile(join(root, ".dockerignore"), "utf8");
  const rules = ignore
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  expect(rules[0]).toBe("**");
  expect(rules.filter((s) => s.startsWith("!")).sort()).toEqual(
    [
      "!.dockerignore",
      "!Dockerfile",
      "!Dockerfile.mcp",
      "!bun.lock",
      "!package.json",
      "!src/",
      "!src/**",
    ].sort(),
  );
  const docker = await readFile(join(root, "Dockerfile.mcp"), "utf8");
  expect(docker).toContain("USER bun");
  expect(docker).toContain("ARCHIVE_SQLITE_PATH=/data/archive.sqlite");
  expect(docker).not.toMatch(/COPY\s+\.\s/);
});
