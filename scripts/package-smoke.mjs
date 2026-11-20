import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "xp-package-"));
try {
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--destination", temporary], {
    cwd: root,
    stdio: "pipe",
  });
  const [tarball] = (await readdir(temporary)).filter((file) => file.endsWith(".tgz"));
  assert.ok(tarball, "bun pack produced a tarball");
  const drivers = process.env.XP_SMOKE_DRIVER
    ? [process.env.XP_SMOKE_DRIVER]
    : ["pg", "mysql2", "mssql", "mongodb", "@aws-sdk/lib-dynamodb", "sequelize"];
  for (const driver of [null, ...drivers]) {
    const directory = join(temporary, driver?.replaceAll("/", "-") ?? "no-driver");
    await mkdir(directory);
    const dependencies = { [manifest.name]: `file:${join(temporary, tarball)}` };
    if (driver) dependencies[driver] = manifest.devDependencies[driver];
    if (driver === "sequelize") dependencies.pg = manifest.devDependencies.pg;
    // AWS document client has its own SDK peer; it is part of the same provider.
    if (driver === "@aws-sdk/lib-dynamodb")
      dependencies["@aws-sdk/client-dynamodb"] =
        manifest.devDependencies["@aws-sdk/client-dynamodb"];
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", dependencies }),
    );
    execFileSync("bun", ["install", "--ignore-scripts", "--production"], {
      cwd: directory,
      stdio: "pipe",
    });
    const constructors = {
      sequelize: `const {Sequelize}=await import("sequelize"); const client=new Sequelize("postgres://localhost/xp",{logging:false}); server(client); await client.close();`,
      pg: `const {Client}=await import('pg'); server(new Client());`,
      mysql2: `const mysql=await import('mysql2/promise'); const pool=mysql.createPool({}); server(pool); await pool.end();`,
      mssql: `const sql=await import('mssql'); server(new sql.default.ConnectionPool({server:'localhost'}));`,
      mongodb: `const {MongoClient}=await import('mongodb'); server(new MongoClient('mongodb://localhost'),{databaseName:'xp'});`,
      "@aws-sdk/lib-dynamodb": `const {DynamoDBClient}=await import('@aws-sdk/client-dynamodb'); const {DynamoDBDocumentClient}=await import('@aws-sdk/lib-dynamodb'); const client=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1'})); server(client,{tableName:'xp'}); client.destroy();`,
    };
    const installed = [
      driver,
      ...(driver === "sequelize" ? ["pg"] : []),
      ...(driver === "@aws-sdk/lib-dynamodb" ? ["@aws-sdk/client-dynamodb"] : []),
    ];
    const absent = [
      ...Object.keys(constructors),
      "@aws-sdk/client-dynamodb",
      "express",
      "@types/express",
      "vue",
    ].filter((name) => !installed.includes(name));
    await writeFile(
      join(directory, "smoke.mjs"),
      `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {xpMiddleware} from '@frostme/xp'; assert.equal(typeof xpMiddleware,'function'); import server from '@frostme/xp/server'; import cli from '@frostme/xp/cli'; assert.equal(typeof cli, 'function'); const require=createRequire(import.meta.url); for(const name of ${JSON.stringify(absent)}) { assert.throws(()=>require.resolve(name),{code:'MODULE_NOT_FOUND'}); } ${driver ? (constructors[driver] ?? "") : "assert.throws(()=>server({}),TypeError);"}`,
    );
    execFileSync("node", ["smoke.mjs"], { cwd: directory, stdio: "pipe" });
    await writeFile(
      join(directory, "consumer.ts"),
      `import {xpMiddleware} from '@frostme/xp'; import {createRestLoader} from '@frostme/xp/client'; void xpMiddleware; const load: Promise<string|null> = createRestLoader()('checkout'); void load; import server from '@frostme/xp/server'; const xp=server({}); const result: Promise<unknown> = xp.getGroup('user','experiment'); void result;`,
    );
    execFileSync(
      join(root, "node_modules", ".bin", "tsc"),
      [
        "--noEmit",
        "--strict",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "esnext",
        "consumer.ts",
      ],
      { cwd: directory, stdio: "pipe" },
    );
    if (driver === null) {
      const installedRoot = join(directory, "node_modules", manifest.name);
      const published = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
      // Check the real tarball, including condition branches the plain Node loader never selects.
      async function checkTargets(target) {
        if (typeof target === "string") {
          assert(target.startsWith("./dist/"), target);
          assert((await readFile(join(installedRoot, target))).length > 0, target);
        } else {
          await Promise.all(Object.values(target).map(checkTargets));
        }
      }
      await checkTargets(published.exports);
      for (const peer of ["vue", "@angular/core", "svelte", "astro", "solid-js", "@solidjs/web"]) {
        assert.equal(published.peerDependenciesMeta[peer]?.optional, true, peer);
        assert.ok(published.peerDependencies[peer], peer);
      }
      const executable = join(directory, "node_modules", manifest.name, "dist", "cli", "bin.js");
      assert.match(
        await readFile(join(directory, "node_modules/@frostme/xp/docs/termcn.md"), "utf8"),
        /MIT License/,
      );
      // Exercise the lazy interactive graph in an isolated production install.
      await writeFile(
        join(directory, "interactive-smoke.mjs"),
        `
        import assert from 'node:assert/strict';
        import { PassThrough } from 'node:stream';
        import { createElement } from 'react';
        import { render } from 'ink';
        import cli from '@frostme/xp/cli';
        import Wizard from './node_modules/@frostme/xp/dist/cli/wizard.js';
        const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 30, isTTY: true });
        const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
        let output = ''; stdout.on('data', chunk => { output += chunk; });
        const options = { cwd: '/project', orm: 'none', database: 'postgres', migrationsDir: 'migrations', models: false,
          modelsDir: 'models', language: 'typescript', moduleFormat: 'esm', userStorage: 'create', userIdType: 'uuid', tableName: 'xp' };
        const framework = cli({
          async detectProject() { return { cwd: '/project', options, missing: [], warnings: [] }; },
          async planSetup() { return { options, files: [], warnings: [], prerequisites: [] }; },
          async applySetup() { throw new Error('must not write'); }
        });
        const app = render(createElement(Wizard, { framework, options: {}, onFinish() {} }),
          { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
        try {
          for (let i = 0; i < 100 && !output.includes('Review actions'); i++) await new Promise(resolve => setTimeout(resolve, 20));
          assert.match(output, /Review actions/);
          assert.match(output, /Generate files/);
        } finally { app.unmount(); app.cleanup(); }
      `,
      );
      execFileSync("node", ["interactive-smoke.mjs"], { cwd: directory, stdio: "pipe" });

      for (const runtime of ["node", "bun"]) {
        const help = execFileSync(runtime, [executable, "--help"], {
          cwd: directory,
          encoding: "utf8",
        });
        assert.match(help, /xp setup/);
        assert.doesNotMatch(help, /Hello, World/);
      }
      const bunHelp = execFileSync("bun", ["run", "xp", "--help"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.match(bunHelp, /xp setup/);
      const npmHelp = execFileSync("npm", ["exec", "--offline", "--", "xp", "--help"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.match(npmHelp, /xp setup/);
      for (const launcher of ["pnpm", "yarn"]) {
        try {
          execFileSync(launcher, ["--version"], { cwd: directory, stdio: "pipe" });
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        const args = ["exec", "xp", "--help"];
        assert.match(
          execFileSync(launcher, args, { cwd: directory, encoding: "utf8" }),
          /xp setup/,
        );
      }
      const args = ["setup", "--orm", "none", "--database", "postgres", "--user-storage", "create"];
      const before = (await readdir(directory)).sort();
      const preview = execFileSync("node", [executable, ...args, "--dry-run"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.match(preview, /CREATE TABLE experiments/);
      assert.deepEqual(
        (await readdir(directory)).sort(),
        before,
        "dry run must not change the consumer project",
      );
      execFileSync("node", [executable, ...args, "--yes"], { cwd: directory, stdio: "pipe" });
      const state = await readFile(join(directory, ".xp", "setup.json"), "utf8");
      const repeated = execFileSync("node", [executable, ...args, "--yes"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.match(repeated, /already generated/);
      assert.equal(await readFile(join(directory, ".xp", "setup.json"), "utf8"), state);
      console.log("CLI package smoke passed: imports, launchers, dry run, generation, rerun");
    }
    console.log(`Package smoke passed: ${driver ?? "no drivers"}`);
  }
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
