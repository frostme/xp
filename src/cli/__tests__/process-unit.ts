import { tmpdir } from "node:os";
import { expect, it } from "vitest";

import { runLocal } from "~/adaptors/setup/generators/schema-utils";

it("terminates a local generator when setup is cancelled", async () => {
  const controller = new AbortController();
  const command = runLocal("-e", ["setTimeout(() => {}, 10000)"], tmpdir(), {}, controller.signal);
  const rejected = expect(command).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await rejected;
});
