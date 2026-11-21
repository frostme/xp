import { defineConfig } from "dpdm";

export default defineConfig({
  files: [
    "./src/index.ts",
    "./src/cli/index.ts",
    "./src/cli/bin.ts",
    "./src/client/index.ts",
    "./src/client/react/index.ts",
    "./src/client/vue/index.ts",
    "./src/server/index.ts",
    "./src/server/express/index.ts",
    "./src/server/fastify/index.ts",
    "./src/server/graphql/index.ts",
    "./src/server/nestjs/index.ts",
  ],
  exitCode: "circular:1",
  transform: true,
  warning: false,
  tree: false,
});
