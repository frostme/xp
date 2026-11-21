import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "https://unpkg.com/knip@6/schema.json",
  entry: [
    "src/client/astro/index.d.mts",
    "scripts/fixtures/frontend/**/*.{ts,tsx,js,jsx,mjs,vue}",
    "tools/svelte/svelte.config.js",
    "scripts/toolchains/solid-v*/vite.config.mjs",
    "src/client/solid/{index.tsx,lifecycle.ts,v1/lifecycle.ts}",
    "scripts/fixtures/protocol-browser/*.{ts,tsx,mjs}",
    "scripts/fixtures/soap/*.{ts,js,mjs}",
    "scripts/fixtures/xp-journey/*.test.mjs",
    "scripts/fixtures/analytics-journey/{*.test.mjs,worker.mjs}",
    "scripts/fixtures/xp-journey/protocol-page.mjs",
    "scripts/fixtures/host-package-smoke/*.{ts,tsx,mjs}",
    "src/**/__tests__/*-integration.{ts,tsx}",
    "src/**/__tests__/*-unit.{ts,tsx}",
  ],
  ignoreExportsUsedInFile: true,
  // Keep the copied registry APIs intact for future upstream updates.
  ignoreIssues: {
    // Island fixture dependencies and shared imports resolve in the packed installation.
    "scripts/fixtures/frontend/astro-*/**": ["unlisted", "unresolved"],
    // Astro fixture dependencies and generated modules resolve in the packed installation.
    "scripts/fixtures/frontend/astro/**": ["unresolved", "unlisted"],
    // The external fixture installer copies shared app sources and generates xp/options.
    "scripts/fixtures/frontend/{vue,nuxt}/**/*": ["unresolved", "unlisted"],
    // These fixtures are copied to isolated apps before Vite and the installed CLI resolve their imports.
    "scripts/fixtures/frontend/{solid-v1,solid-v2,solidstart,shared/solid}/**": [
      "unlisted",
      "unresolved",
    ],
    "scripts/toolchains/solid-v*/vite.config.mjs": ["unlisted"],
    // Native tooling and packed Svelte fixtures install their own pinned dependencies.
    "tools/svelte/svelte.config.js": ["unlisted"],
    "scripts/fixtures/frontend/{svelte,sveltekit}/**": ["unlisted", "unresolved"],
    // Angular peers belong to the isolated compiler or packed application install.
    "scripts/fixtures/frontend/angular/src/**": ["unlisted", "unresolved"],
    "src/proto/**/*_pb.ts": ["exports", "types"],
    "src/cli/termcn/**": ["exports", "types"],
    // The installed CLI creates these two modules before the packed consumer compiles.
    "scripts/fixtures/frontend/react/src/{App,main}.tsx": ["unresolved"],
  },
  tags: ["-lintignore"],
  ignoreDependencies: [
    "astro",
    "lint-staged",
    "@swc-node/register",
    "@bufbuild/protoc-gen-es",
    "pino",
    "@angular/core",
    "svelte",
    "solid-js",
    "@solidjs/web",
  ],
  ignoreFiles: ["dpdm.config.ts"],
};

export default config;
