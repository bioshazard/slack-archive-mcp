import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Git tracks no private exports, runtime databases, reports or credentials", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const tracked = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(tracked.stdout).text();
  expect(await tracked.exited).toBe(0);
  const forbidden = output
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) =>
        /^(?:data-[^/]+|local|\.archive|node_modules)\//.test(path) ||
        (/(?:^|\/)(?:\.env(?:\..+)?|\.mcp\.json)$/.test(path) &&
          !path.endsWith(".env.example")) ||
        /\.(?:sqlite(?:-.*)?|db(?:-.*)?|csv|parquet|zip)$/i.test(path),
    );
  expect(forbidden).toEqual([]);
  const ignored = Bun.spawn(
    [
      "git",
      "check-ignore",
      "data-2099/messages.json",
      ".archive/current.json",
      "local/reports/private.md",
      ".mcp.json",
      "Native export.zip",
      "Native export.ZIP",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const paths = (await new Response(ignored.stdout).text()).trim().split("\n");
  expect(await ignored.exited).toBe(0);
  expect(paths).toHaveLength(6);
});
