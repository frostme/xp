import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { chromium as playwright } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, "scripts/fixtures/frontend");
const exists = (file) =>
  stat(file).then(
    () => true,
    (e) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    },
  );

export async function loadProfiles() {
  const profiles = JSON.parse(await readFile(path.join(fixtures, "profiles.json"), "utf8"));
  assert.ok(Array.isArray(profiles) && profiles.length, "No frontend profiles declared");
  const ids = new Set();
  for (const p of profiles) {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(p.id), `Duplicate fixture: ${p.id}`);
    ids.add(p.id);
    assert.ok(
      p.compiler && p.frontend && p.cases?.length && new Set(p.cases).size === p.cases.length,
      `Missing compiler, profile or unique cases: ${p.id}`,
    );
    assert.ok(Object.keys(p.dependencies).length, `No dependencies for ${p.id}`);
    for (const [name, version] of Object.entries(p.dependencies))
      assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `Pin ${p.id} dependency ${name}`);
    assert.equal(path.basename(p.entry), p.entry);
    assert.ok(await exists(path.join(fixtures, p.id, p.entry)), `Missing ${p.id}/${p.entry}`);
  }
  for (const p of profiles)
    if (p.extends)
      assert.ok(ids.has(p.extends) && p.extends !== p.id, `Invalid fixture base for ${p.id}`);
  return profiles;
}

export async function withTarball(test) {
  if (process.env.XP_TARBALL) return test(path.resolve(process.env.XP_TARBALL));
  const temp = await mkdtemp(path.join(tmpdir(), "xp-frontend-pack-"));
  try {
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--destination", temp], {
      cwd: root,
      stdio: "pipe",
    });
    const packed = (await readdir(temp)).filter((f) => f.endsWith(".tgz"));
    assert.equal(packed.length, 1);
    return await test(path.join(temp, packed[0]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function runProfile(
  profile,
  {
    tarball,
    journey,
    journeyCases,
    transport = "rest",
    endpoint = transport === "rest" ? "/xp" : "/graphql",
  },
) {
  const cwd = await mkdtemp(path.join(tmpdir(), `xp-frontend-${profile.id}-`));
  const artifacts = process.env.XP_TRACE_DIR && path.resolve(process.env.XP_TRACE_DIR, profile.id);
  const browsers = new Set();
  let traceIndex = 0;
  const chromium = {
    async launch(options) {
      const browser = await playwright.launch({
        ...(process.env.XP_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.XP_CHROMIUM_EXECUTABLE }
          : {}),
        ...options,
      });
      browsers.add(browser);
      if (artifacts) {
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await newContext(...args);
          await context.tracing.start({ screenshots: true, snapshots: true });
          const file = path.join(artifacts, `trace-${++traceIndex}.zip`);
          const close = context.close.bind(context);
          context.close = async (...closeArgs) => {
            if (await exists(artifacts)) await context.tracing.stop({ path: file }).catch(() => {});
            return close(...closeArgs);
          };
          return context;
        };
        const close = browser.close.bind(browser);
        browser.close = async (...args) => {
          for (const context of browser.contexts()) await context.close();
          await close(...args);
        };
      }
      return browser;
    },
  };
  let passed = false;
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true });
    if (profile.extends) await cp(path.join(fixtures, profile.extends), cwd, { recursive: true });
    await cp(path.join(fixtures, profile.id), cwd, { recursive: true });
    if (await exists(path.join(fixtures, "shared")))
      await cp(path.join(fixtures, "shared"), path.join(cwd, "fixture-shared"), {
        recursive: true,
      });
    const packageFile = path.join(cwd, "package.json");
    const app = (await exists(packageFile))
      ? JSON.parse(await readFile(packageFile, "utf8"))
      : { private: true, type: "module" };
    app.dependencies = {
      ...app.dependencies,
      ...profile.dependencies,
      "@frostme/xp": `file:${tarball}`,
    };
    await writeFile(packageFile, JSON.stringify(app, null, 2));
    const run = (command, args, options = {}) =>
      execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: 300000,
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 32 * 1024 * 1024,
        ...options,
      });
    run("bun", ["install"]);
    const setup = (extra = []) =>
      run(path.join(cwd, "node_modules/.bin/xp"), [
        "setup",
        "--cwd",
        cwd,
        "--scope",
        "frontend",
        "--frontend",
        profile.frontend,
        ...(profile.island ? ["--island", profile.island] : []),
        "--transport",
        transport,
        "--endpoint",
        endpoint,
        "--non-interactive",
        ...extra,
      ]);
    const preview = setup(["--dry-run"]);
    assert.match(preview, /\.xp\/frontend\.json/);
    assert.equal(await exists(path.join(cwd, ".xp/frontend.json")), false);
    setup(["--yes"]);
    assert.match(setup(["--yes"]), /already generated/);
    const { default: test } = await import(pathToFileURL(path.join(cwd, profile.entry)));
    const cases = await test({
      cwd,
      chromium,
      run,
      profile,
      setup,
      journey: journey && ((origin) => journey(origin, chromium)),
    });
    assert.ok(Array.isArray(cases) && cases.length, `Zero cases ran for ${profile.id}`);
    assert.deepEqual(
      [...cases].sort(),
      [...(journeyCases ?? profile.cases)].sort(),
      `Case coverage: ${profile.id}`,
    );
    process.stdout.write(`${profile.id}: ${cases.join(", ")}\n`);
    passed = true;
  } catch (cause) {
    throw new Error(`Packed frontend failed: ${profile.id}`, { cause });
  } finally {
    for (const browser of browsers) if (browser.isConnected()) await browser.close();
    if (passed && artifacts) await rm(artifacts, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profiles = await loadProfiles();
  if (process.argv.includes("--matrix"))
    process.stdout.write(JSON.stringify(profiles.map((p) => p.id)));
  else {
    const selected = profiles.filter(
      (p) => !process.env.XP_PROFILE || process.env.XP_PROFILE === p.id,
    );
    assert.ok(selected.length, `Unknown XP_PROFILE: ${process.env.XP_PROFILE}`);
    await withTarball(async (tarball) => {
      for (const p of selected) await runProfile(p, { tarball });
    });
  }
}
