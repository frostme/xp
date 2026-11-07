import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const database = process.env["XP_DATABASE"] ?? "postgres";
if (!["postgres", "mysql", "mssql", "mongodb", "dynamodb"].includes(database)) {
  throw new Error(`Unsupported XP_DATABASE: ${database}`);
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "~",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    include: [`src/adaptors/data-access/${database}/__tests__/**/*-integration.ts`],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
