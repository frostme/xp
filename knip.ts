import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "https://unpkg.com/knip@6/schema.json",
  entry: [
    "scripts/fixtures/frontend/**/*.{ts,tsx,js,jsx,mjs,vue}",
    "scripts/fixtures/xp-journey/journey.test.mjs",
    "scripts/fixtures/host-package-smoke/*.{ts,tsx,mjs}",
    "src/**/__tests__/*-integration.{ts,tsx}",
    "src/**/__tests__/*-unit.{ts,tsx}",
  ],
  ignoreExportsUsedInFile: true,
  // Keep the copied registry APIs intact for future upstream updates.
  ignoreIssues: {
    // The external fixture installer copies shared app sources and generates xp/options.
    "scripts/fixtures/frontend/{vue,nuxt}/**/*": ["unresolved", "unlisted"],
    // Angular peers belong to the isolated compiler or packed application install.
    "scripts/fixtures/frontend/angular/src/**": ["unlisted", "unresolved"],
    "src/cli/termcn/**": ["exports", "types"],
    // The installed CLI creates these two modules before the packed consumer compiles.
    "scripts/fixtures/frontend/react/src/{App,main}.tsx": ["unresolved"],
  },
  tags: ["-lintignore"],
  ignoreDependencies: ["lint-staged", "@swc-node/register", "pino", "@angular/core"],
  ignoreFiles: ["dpdm.config.ts"],
};

export default config;
