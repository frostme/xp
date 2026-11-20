import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "https://unpkg.com/knip@6/schema.json",
  entry: [
    "scripts/fixtures/xp-journey/journey.test.mjs",
    "scripts/fixtures/host-package-smoke/*.{ts,tsx,mjs}",
    "src/**/__tests__/*-integration.{ts,tsx}",
    "src/**/__tests__/*-unit.{ts,tsx}",
  ],
  ignoreExportsUsedInFile: true,
  // Keep the copied registry APIs intact for future upstream updates.
  ignoreIssues: { "src/cli/termcn/**": ["exports", "types"] },
  tags: ["-lintignore"],
  ignoreDependencies: ["lint-staged", "@swc-node/register", "pino"],
  ignoreFiles: ["dpdm.config.ts"],
};

export default config;
