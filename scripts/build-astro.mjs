import { copyFile, mkdir } from "node:fs/promises";
import { URL } from "node:url";

const source = new URL("../src/client/astro/", import.meta.url);
const output = new URL("../dist/client/astro/", import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ["index.mjs", "index.d.mts", "Experiment.astro", "Cohort.astro"]) {
  await copyFile(new URL(file, source), new URL(file, output));
}
