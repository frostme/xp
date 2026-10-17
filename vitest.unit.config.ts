import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "~",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      // Match Node/Yoga's GraphQL constructor; mixed ESM/CJS instances reject scalar values.
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/__tests__/**/*-unit.ts"],
  },
});
