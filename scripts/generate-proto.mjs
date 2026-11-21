import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const source = "src/proto";
const check = process.argv.includes("--check");
const output = check ? await mkdtemp(join(tmpdir(), "xp-descriptor-")) : source;
const file = "xp/v1/cohort_pb.ts";

try {
  const template = {
    version: "v2",
    plugins: [{ local: "protoc-gen-es", out: ".", opt: "target=ts" }],
  };
  execFileSync("buf", ["generate", source, "--template", JSON.stringify(template), "-o", output], {
    stdio: "inherit",
  });
  if (check) {
    assert.equal(
      await readFile(join(output, file), "utf8"),
      await readFile(join(source, file), "utf8"),
      "The installed descriptor has drifted. Run bun run generate:proto.",
    );
  }
} finally {
  if (check) await rm(output, { recursive: true, force: true });
}
