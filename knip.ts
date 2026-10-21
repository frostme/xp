import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "https://unpkg.com/knip@6/schema.json",
  tags: ["-lintignore"],
  ignoreDependencies: ["lint-staged", "@swc-node/register", "pino", "pg"],
  ignoreFiles: ["dpdm.config.ts"],
};

export default config;
