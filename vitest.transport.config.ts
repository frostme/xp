import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/{server,client}/**/__tests__/*-integration.{ts,tsx}"],
    testTimeout: 30000,
  },
});
