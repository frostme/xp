import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("ordinary installed entries load independently of the provider and worker modules", async () => {
  const loaded = [];
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      loaded.push(result.url);
      return result;
    },
  });
  try {
    for (const entry of [
      "@frostme/xp",
      "@frostme/xp/server",
      "@frostme/xp/client",
      "@frostme/xp/server/graphql",
    ]) {
      await import(entry);
    }
  } finally {
    hook.deregister();
  }
  assert.deepEqual(
    loaded.filter((url) => /\/dist\/(?:analytics\/|adaptors\/analytics\/)/.test(url)),
    [],
  );
});
