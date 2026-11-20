import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      { find: "~", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Match the Node entry used by the externally loaded Yoga and Apollo hosts.
      { find: /^graphql$/, replacement: createRequire(import.meta.url).resolve("graphql") },
    ],
  },
  test: {
    include: ["src/{server,client}/**/__tests__/*-integration.{ts,tsx}"],
    testTimeout: 30000,
  },
});
