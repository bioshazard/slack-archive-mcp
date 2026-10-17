import { Archive } from "./reader.ts";
import { validateDatabase } from "./schema.ts";

export async function verifyStandaloneDatabase(path: string) {
  const archive = await Archive.openDatabase(path);
  try {
    validateDatabase(archive.db);
    return archive.manifest;
  } finally {
    archive.close();
  }
}
