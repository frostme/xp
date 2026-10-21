import { defineConfig } from "dpdm";

export default defineConfig({
  files: ["./src/index.ts", "./src/cli/index.ts", "./src/client/index.ts", "./src/server/index.ts"],
  exitCode: "circular:1",
  transform: true,
  warning: false,
  tree: false,
});
