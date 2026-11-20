import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ScopedSetupOptions } from "~/interfaces/setup";

import cli from "~/cli";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stock = `import { createRoot as root } from 'react-dom/client';
import { StrictMode } from 'react';
import './index.css';
root(document.getElementById("root")).render(<StrictMode>{/* keep comment */}<App /></StrictMode>);
`;
const versions = { react: "19.3.1", "react-dom": "19.3.1" };
async function app(ext = "tsx", dependencies: Record<string, string> = versions, code = stock) {
  const root = await mkdtemp(path.join(tmpdir(), "frontend-setup-"));
  cleanup.push(root);
  const cwd = path.join(root, "packages", "app");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies }));
  await writeFile(path.join(cwd, "src", `main.${ext}`), code);
  for (const [name, version] of Object.entries(versions)) {
    await mkdir(path.join(root, "node_modules", name), { recursive: true });
    await writeFile(
      path.join(root, "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  return { cwd, setup: cli() };
}
const storage: ScopedSetupOptions = { orm: "none", database: "postgres", userStorage: "create" };
describe("scoped frontend setup", () => {
  it.each(["tsx", "jsx"])(
    "previews, registers and preserves unrelated %s host edits",
    async (ext) => {
      const { cwd, setup } = await app(ext);
      const options = { cwd, frontend: "react" as const };
      const proposed = await setup.planScoped(options);
      expect(proposed.files.map((file) => file.path)).not.toContain(".xp/setup.json");
      const entry = proposed.files.find((file) => file.path === `src/main.${ext}`)!;
      expect(entry.before).toBe(stock);
      expect(entry.content).toContain(
        "<AppXp><StrictMode>{/* keep comment */}<App /></StrictMode></AppXp>",
      );
      expect(await readFile(path.join(cwd, entry.path), "utf8")).toBe(stock);
      await setup.applyScoped(proposed);
      await writeFile(path.join(cwd, entry.path), "// host edit\n" + entry.content);
      expect((await setup.planScoped(options)).files.every((f) => f.action === "unchanged")).toBe(
        true,
      );
      const helper = `src/xp/provider.${ext}`;
      await writeFile(path.join(cwd, helper), "// owned module customized");
      expect((await setup.planScoped(options)).files.every((f) => f.action === "unchanged")).toBe(
        true,
      );
      await expect(setup.planScoped({ ...options, endpoint: "/api/xp" })).rejects.toThrow(
        "File conflict",
      );
    },
  );

  it("suggests a host only for the selected app's declared packages, including hoisted dependencies", async () => {
    const { cwd, setup } = await app();
    expect((await setup.detectScoped({ cwd }, true)).options.scope).toBe("frontend");
    expect((await setup.detectScoped({ cwd })).missing).toContain("database");
    const noHost = await app("jsx", {});
    expect((await setup.detectScoped({ cwd: noHost.cwd }, true)).missing).toEqual(["scope"]);
    await expect(setup.planScoped({ cwd: noHost.cwd, frontend: "react" })).rejects.toThrow(
      "Install and declare",
    );
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { ...versions, pg: "8" } }),
    );
    expect((await setup.detectScoped({ cwd }, true)).options.scope).toBe("both");
  });
  it("preserves ambiguous hydration trees and emits both manual insertions", async () => {
    const code = 'import {hydrateRoot} from "react-dom/client"; hydrateRoot(node, <App />);';
    const { cwd, setup } = await app("jsx", versions, code);
    const plan = await setup.planScoped({ cwd, scope: "frontend" });
    expect(plan.prerequisites.join(" ")).toContain("server tree and hydrateRoot");
    expect(plan.files.some((file) => file.path === "src/main.jsx")).toBe(false);
    expect(plan.files.some((file) => file.path.endsWith("CheckoutBanner.jsx"))).toBe(true);
  });
  it("validates flags, endpoints, versions and persists the configured public endpoint", async () => {
    const { cwd, setup } = await app();
    await expect(setup.planScoped({ cwd, frontend: "react", ...storage })).rejects.toThrow(
      "--scope both",
    );
    const options = { cwd, frontend: "react" as const };
    for (const endpoint of [
      "//example.org",
      "/path?token=secret",
      "https://u:p@host.test/x",
      "ftp://host.test/x",
      "/back\\slash",
    ])
      await expect(setup.planScoped({ ...options, endpoint })).rejects.toThrow();
    const plan = await setup.planScoped({ ...options, transport: "graphql" });
    expect(plan.files.find((f) => f.path.endsWith("provider.tsx"))?.content).toContain(
      'createGraphQLLoader({ endpoint: "/graphql" })',
    );
    await setup.applyScoped(plan);
    expect((await setup.planScoped({ cwd, scope: "frontend" })).options.endpoint).toBe("/graphql");
    await writeFile(
      path.resolve(cwd, "../../node_modules/react/package.json"),
      JSON.stringify({ name: "react", version: "18.3.1" }),
    );
    await expect(setup.planScoped(options)).rejects.toThrow("18.3.1");
  });
  it("aborts a combined transaction when the host changed since preview", async () => {
    const { cwd, setup } = await app();
    const plan = await setup.planScoped({ cwd, ...storage, scope: "both" });
    expect(plan.files.map((file) => file.path)).toContain(".xp/setup.json");
    expect(plan.files.map((file) => file.path)).toContain(".xp/frontend.json");
    await writeFile(path.join(cwd, "src/main.tsx"), stock + "// concurrent edit");
    await expect(setup.applyScoped(plan)).rejects.toThrow("changed since preview");
    await expect(readFile(path.join(cwd, ".xp/setup.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["storage", "frontend"] as const)(
    "supports %s-first setup followed by both",
    async (first) => {
      const { cwd, setup } = await app();
      await setup.applyScoped(
        await setup.planScoped(
          first === "frontend" ? { cwd, scope: first } : { cwd, scope: first, ...storage },
        ),
      );
      const combined = await setup.planScoped({ cwd, ...storage, scope: "both" });
      await setup.applyScoped(combined);
      expect(
        (await setup.planScoped({ cwd, ...storage, scope: "both" })).files.every(
          (f) => f.action === "unchanged",
        ),
      ).toBe(true);
    },
  );
});
