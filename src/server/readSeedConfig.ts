import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSeedConfig } from "~/adaptors/validation/zod/seed";

export async function readSeedConfig(
  cwd: string | undefined,
  configPath: string | undefined,
  maxInitialCohorts?: number,
) {
  const path = resolve(cwd ?? process.cwd(), configPath ?? "xp.config.json");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (
      configPath === undefined &&
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return { allowCreate: false, experiments: [] };
    throw new Error(`Could not read xp configuration at ${path}`, { cause });
  }
  try {
    return parseSeedConfig(JSON.parse(contents), maxInitialCohorts);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid xp configuration at ${path}: ${detail}`, { cause });
  }
}
