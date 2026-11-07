import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "https://unpkg.com/knip@6/schema.json",
  entry: ["src/**/__tests__/*-integration.ts", "src/**/__tests__/*-unit.ts"],
  ignoreExportsUsedInFile: true,
  tags: ["-lintignore"],
  ignoreDependencies: ["lint-staged", "@swc-node/register", "pino"],
  ignoreFiles: ["dpdm.config.ts"],
};

export default config;
