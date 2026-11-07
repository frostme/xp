import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
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
  const drivers = process.env.XP_SMOKE_DRIVER
    ? [process.env.XP_SMOKE_DRIVER]
    : Object.keys(manifest.peerDependencies).filter((name) => name !== "@aws-sdk/client-dynamodb");
  for (const driver of [null, ...drivers]) {
    const directory = join(temporary, driver?.replaceAll("/", "-") ?? "no-driver");
    await mkdir(directory);
    const dependencies = { xp: `file:${join(temporary, `xp-${manifest.version}.tgz`)}` };
    if (driver) dependencies[driver] = manifest.devDependencies[driver];
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
      pg: `const {Client}=await import('pg'); server(new Client());`,
      mysql2: `const mysql=await import('mysql2/promise'); const pool=mysql.createPool({}); server(pool); await pool.end();`,
      mssql: `const sql=await import('mssql'); server(new sql.default.ConnectionPool({server:'localhost'}));`,
      mongodb: `const {MongoClient}=await import('mongodb'); server(new MongoClient('mongodb://localhost'),{databaseName:'xp'});`,
      "@aws-sdk/lib-dynamodb": `const {DynamoDBClient}=await import('@aws-sdk/client-dynamodb'); const {DynamoDBDocumentClient}=await import('@aws-sdk/lib-dynamodb'); const client=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1'})); server(client,{tableName:'xp'}); client.destroy();`,
    };
    const installed = [
      driver,
      ...(driver === "@aws-sdk/lib-dynamodb" ? ["@aws-sdk/client-dynamodb"] : []),
    ];
    const absent = [...Object.keys(constructors), "@aws-sdk/client-dynamodb"].filter(
      (name) => !installed.includes(name),
    );
    await writeFile(
      join(directory, "smoke.mjs"),
      `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import server from 'xp/server'; const require=createRequire(import.meta.url); for(const name of ${JSON.stringify(absent)}) { assert.throws(()=>require.resolve(name),{code:'MODULE_NOT_FOUND'}); } ${driver ? (constructors[driver] ?? "") : "assert.throws(()=>server({}),TypeError);"}`,
    );
    execFileSync("node", ["smoke.mjs"], { cwd: directory, stdio: "pipe" });
    await writeFile(
      join(directory, "consumer.ts"),
      `import server from 'xp/server'; const xp=server({}); const result: Promise<unknown> = xp.getGroup('user','experiment'); void result;`,
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
    console.log(`Package smoke passed: ${driver ?? "no drivers"}`);
  }
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
