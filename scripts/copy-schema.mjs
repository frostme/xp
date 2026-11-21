import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

for (const schema of process.argv.slice(2)) {
  const destination = join("dist", schema);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join("src", schema), destination);
}
