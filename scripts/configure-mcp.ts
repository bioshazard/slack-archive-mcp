import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const configuration = {
  mcpServers: {
    "slack-archive-mcp": {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("src/mcp.ts", root)),
        "--archive-dir",
        fileURLToPath(new URL(".archive", root)),
      ],
    },
  },
};
const path = fileURLToPath(new URL(".mcp.json", root));
// Do not overwrite a user's existing local configuration.
await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(
  `Created ${path}. Copy the slack-archive-mcp server entry into your MCP client configuration.`,
);
