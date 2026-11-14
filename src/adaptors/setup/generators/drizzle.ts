import { parse } from "@babel/parser";
import { glob, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { renderSql, STORAGE_VERSION, userIdSql } from "../storage";
import { shellQuote } from "./common";
import { command, localPackage, projectPath, readInput, runLocal } from "./schema-utils";

interface SchemaSource {
  path: string;
  content: string;
}
interface UserExport {
  path: string;
  export: string;
  field: string;
}

function moduleReference(from: string, to: string): string {
  const relative = path
    .relative(path.dirname(from), to)
    .replaceAll(path.sep, "/")
    .replace(/\.(ts|mts|cts)$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function renderSchema(options: ResolvedSetup, output: string, user: UserExport | null): string {
  const pg = options.database === "postgres";
  const cjs = options.moduleFormat === "commonjs" && options.language === "javascript";
  const dialect = pg ? "pg" : "mysql";
  const table = pg ? "pgTable" : "mysqlTable";
  const id = pg ? 'serial("id").notNull()' : 'int("id").autoincrement().notNull()';
  const integer = pg ? "integer" : "int";
  const percentage = pg ? "doublePrecision" : "double";
  const json = pg
    ? "jsonb(\"value\").notNull().default(sql`'null'::jsonb`)"
    : 'json("value").notNull()';
  const imports = `${table}, ${pg ? "serial, integer, doublePrecision, jsonb" : "int, double, json, varchar"}, text, unique, index, check, foreignKey, primaryKey, customType`;
  const preamble = cjs
    ? `const { ${imports} } = require("drizzle-orm/${dialect}-core");\nconst { sql } = require("drizzle-orm");\n`
    : `import { ${imports} } from "drizzle-orm/${dialect}-core";\nimport { sql } from "drizzle-orm";\n`;
  const userType = userIdSql(options);
  const type = /^(?:tinyint|smallint|mediumint|integer|int)\b/i.test(userType)
    ? "number"
    : "string";
  const custom = options.language === "typescript" ? `<{ data: ${type} }>` : "";
  let source = `// xp storage schema v${STORAGE_VERSION}. Migrations preserve the database contract.\n${preamble}`;
  if (user)
    source += cjs
      ? `const { ${user.export}: xpApplicationUsers } = require(${JSON.stringify(moduleReference(output, user.path))});\n`
      : `import { ${user.export} as xpApplicationUsers } from ${JSON.stringify(moduleReference(output, user.path))};\n`;
  source += `\nconst xpUserKey = customType${custom}({ dataType() { return ${JSON.stringify(userType)}; } });\n`;
  if (!pg)
    source += `const xpSlug = customType${options.language === "typescript" ? "<{ data: string }>" : ""}({ dataType() { return "varchar(191) COLLATE utf8mb4_0900_bin"; } });\n`;
  const exp = cjs ? "const" : "export const";
  const userReference = user ? `xpApplicationUsers.${user.field}` : "xpUsers.id";
  if (!user)
    source += `${exp} xpUsers = ${table}("users", { id: xpUserKey("id").notNull() }, (table) => [primaryKey({columns: [table.id], name: "users_pkey"})]);\n`;
  const slug = (name: string) => (pg ? `text("${name}")` : `xpSlug("${name}")`);
  const enumType = pg ? 'text("type")' : 'varchar("type", { length: 32 })';
  source += `\n${exp} xpExperiments = ${table}("experiments", {\n  id: ${id},\n  name: text("name").notNull(),\n  slug: ${slug("slug")}.notNull().unique("experiments_slug_key"),\n  type: ${enumType}.notNull(),\n  description: text("description").notNull(),\n  winner: ${slug("winner")},\n}, (table) => [\n  primaryKey({columns: [table.id], name: "experiments_pkey"}),\n  check("experiments_type_check", sql\`\${table.type} in ('flag', 'simple', 'multivariate', 'dynamic')\`),\n]);\n\n${exp} xpCohorts = ${table}("cohorts", {\n  id: ${id},\n  experimentId: ${integer}("experiment_id").notNull(),\n  slug: ${slug("slug")}.notNull().unique("cohorts_slug_key"),\n  type: ${enumType}.notNull(),\n  description: text("description").notNull(),\n  percentage: ${percentage}("percentage").notNull(),\n  value: ${json},\n}, (table) => [\n  primaryKey({columns: [table.id], name: "cohorts_pkey"}),\n  foreignKey({name: "cohorts_experiment_id_fkey", columns: [table.experimentId], foreignColumns: [xpExperiments.id]}).onDelete("no action").onUpdate("no action"),\n  unique("cohorts_id_experiment_id_key").on(table.id, table.experimentId),\n  index("cohorts_experiment_id_idx").on(table.experimentId),\n  check("cohorts_type_check", sql\`\${table.type} in ('control', 'treatment')\`),\n  check("cohorts_percentage_check", sql\`\${table.percentage} >= 0 and \${table.percentage} <= 100\`),\n]);\n\n${exp} xpUserCohorts = ${table}("user_cohorts", {\n  id: ${id},\n  userId: xpUserKey("user_id").notNull(),\n  experimentId: ${integer}("experiment_id").notNull(),\n  cohortId: ${integer}("cohort_id").notNull(),\n}, (table) => [\n  primaryKey({columns: [table.id], name: "user_cohorts_pkey"}),\n  foreignKey({name: "user_cohorts_user_id_fkey", columns: [table.userId], foreignColumns: [${userReference}]}).onDelete("no action").onUpdate("no action"),\n  foreignKey({name: "user_cohorts_experiment_id_fkey", columns: [table.experimentId], foreignColumns: [xpExperiments.id]}).onDelete("no action").onUpdate("no action"),\n  unique("user_cohorts_user_id_experiment_id_key").on(table.userId, table.experimentId),\n  foreignKey({name: "user_cohorts_cohort_id_experiment_id_fkey", columns: [table.cohortId, table.experimentId], foreignColumns: [xpCohorts.id, xpCohorts.experimentId]}).onDelete("no action").onUpdate("no action"),\n  index("user_cohorts_experiment_id_idx").on(table.experimentId),\n  index("user_cohorts_cohort_id_idx").on(table.cohortId),\n]);\n`;
  if (cjs)
    source += `\nmodule.exports = {${user ? "" : "xpUsers, "}xpExperiments, xpCohorts, xpUserCohorts};\n`;
  return source;
}

const builderMethods = new Set([
  "primaryKey",
  "notNull",
  "default",
  "defaultNow",
  "defaultRandom",
  "unique",
  "references",
  "on",
  "onDelete",
  "onUpdate",
  "autoincrement",
  "$type",
  "array",
  "generatedAlwaysAsIdentity",
  "generatedByDefaultAsIdentity",
  "desc",
  "asc",
  "nullsFirst",
  "nullsLast",
  "where",
  "using",
]);

/** Deliberately accepts declarative schema modules only; never imports the application to detect its schema. */
function inspectSource(source: SchemaSource): {
  imports: string[];
  users: UserExport[];
  tables: string[];
} {
  const ast = parse(source.content, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
  const imported = new Set<string>();
  const tableFactories = new Set<string>();
  const imports: string[] = [];
  const users: UserExport[] = [];
  const tables: string[] = [];
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") continue;
      const name = node.source.value;
      if (!(name === "drizzle-orm" || name.startsWith("drizzle-orm/")) && !name.startsWith("."))
        throw new Error(
          `Schema ${source.path} imports ${name}; isolate schema declarations from application startup before automatic generation.`,
        );
      imports.push(name);
      for (const specifier of node.specifiers) {
        imported.add(specifier.local.name);
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          ["pgTable", "mysqlTable"].includes(specifier.imported.name)
        )
          tableFactories.add(specifier.local.name);
      }
    } else if (
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration" &&
      node.type !== "VariableDeclaration" &&
      node.type !== "TSInterfaceDeclaration" &&
      node.type !== "TSTypeAliasDeclaration" &&
      node.type !== "EmptyStatement"
    ) {
      throw new Error(
        `Schema ${source.path} contains executable top-level code. Run generation manually after isolating its declarations.`,
      );
    }
    if (
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      const reference = node.source!.value;
      if (
        !reference.startsWith(".") &&
        reference !== "drizzle-orm" &&
        !reference.startsWith("drizzle-orm/")
      )
        throw new Error(
          `Schema ${source.path} re-exports application code; run generation manually.`,
        );
      imports.push(reference);
    }
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (
        item.id.type !== "Identifier" ||
        item.init?.type !== "CallExpression" ||
        item.init.arguments[0]?.type !== "StringLiteral"
      )
        continue;
      const physical = item.init.arguments[0].value;
      if (item.init.callee.type !== "Identifier" || !tableFactories.has(item.init.callee.name))
        continue;
      tables.push(physical);
      if (physical !== "users" || node.type !== "ExportNamedDeclaration") continue;
      const fields = item.init.arguments[1];
      if (fields?.type !== "ObjectExpression") continue;
      for (const property of fields.properties) {
        if (
          property.type !== "ObjectProperty" ||
          property.computed ||
          (property.key.type !== "Identifier" && property.key.type !== "StringLiteral")
        )
          continue;
        let value: any = property.value;
        while (value.type === "CallExpression" && value.callee.type === "MemberExpression")
          value = value.callee.object;
        if (value.type !== "CallExpression") continue;
        const fieldName =
          property.key.type === "Identifier" ? property.key.name : property.key.value;
        const physicalName =
          value.arguments[0]?.type === "StringLiteral"
            ? value.arguments[0].value
            : value.arguments.length === 0
              ? fieldName
              : undefined;
        if (physicalName !== "id") continue;
        users.push({
          path: source.path,
          export: item.id.name,
          field: property.key.type === "Identifier" ? property.key.name : property.key.value,
        });
      }
    }
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const value = node as Record<string, any>;
    const type = value["type"] as string | undefined;
    if (
      [
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
        "TSTypeAssertion",
      ].includes(type ?? "")
    ) {
      walk(value["expression"]);
      return;
    }
    if (type?.startsWith("TS") || type === "ImportDeclaration") return;
    if (
      [
        "NewExpression",
        "AssignmentExpression",
        "UpdateExpression",
        "AwaitExpression",
        "ImportExpression",
      ].includes(type ?? "")
    )
      throw new Error(
        `Schema ${source.path} has executable expressions that require manual generation.`,
      );
    if (
      type === "Identifier" &&
      ["process", "global", "globalThis", "eval", "require", "fetch"].includes(value["name"])
    )
      throw new Error(`Schema ${source.path} is not an isolated declarative schema.`);
    if (type === "CallExpression") {
      const callee = value["callee"];
      if (callee.type !== "Identifier" && callee.type !== "MemberExpression")
        throw new Error(`Schema ${source.path} contains a dynamic call; run generation manually.`);
      if (callee.type === "Identifier" && !imported.has(callee.name))
        throw new Error(
          `Schema ${source.path} calls ${callee.name}; automatic setup only loads declarative schema modules.`,
        );
      if (
        callee.type === "MemberExpression" &&
        (callee.computed ||
          callee.property.type !== "Identifier" ||
          !builderMethods.has(callee.property.name))
      )
        throw new Error(
          `Schema ${source.path} calls a non-schema method; run generation manually.`,
        );
    }
    for (const [key, child] of Object.entries(value))
      if (!["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) walk(child);
  };
  walk(ast.program);
  return { imports, users, tables };
}

async function resolveImport(
  options: ResolvedSetup,
  from: string,
  reference: string,
  project: ProjectDetection,
): Promise<SchemaSource> {
  const base = path.join(path.dirname(from), reference);
  const alternatives = [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
  for (const candidate of alternatives) {
    const content = await readInput(options, project, candidate);
    if (content !== null) return { path: candidate, content };
  }
  throw new Error(`Cannot statically resolve schema import ${reference} in ${from}.`);
}

async function collectSources(
  options: ResolvedSetup,
  project: ProjectDetection,
): Promise<{ roots: SchemaSource[]; sources: SchemaSource[]; users: UserExport[] }> {
  const pattern = options.schema ?? "src/db/schema.ts";
  const roots: SchemaSource[] = [];
  if (/[*?{}]/.test(pattern)) {
    for await (const file of glob(pattern, { cwd: options.cwd })) {
      const content = await readInput(options, project, file);
      if (content !== null) roots.push({ path: file, content });
    }
  } else {
    const content = await readInput(options, project, pattern);
    if (content !== null) roots.push({ path: pattern, content });
  }
  const sources = new Map<string, SchemaSource>();
  const users: UserExport[] = [];
  const visit = async (source: SchemaSource): Promise<void> => {
    if (sources.has(source.path)) return;
    sources.set(source.path, source);
    const inspected = inspectSource(source);
    if (
      inspected.tables.some((table) => ["experiments", "cohorts", "user_cohorts"].includes(table))
    )
      throw new Error(
        `Schema ${source.path} already contains xp tables; initial setup cannot migrate an existing xp installation.`,
      );
    users.push(...inspected.users);
    for (const reference of inspected.imports) {
      if (!reference.startsWith(".")) continue;
      await visit(await resolveImport(options, source.path, reference, project));
    }
  };
  for (const root of roots) await visit(root);
  return { roots, sources: [...sources.values()], users };
}

async function tree(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Drizzle migration history must not contain symbolic links.");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        result.set(child, await readFile(path.join(directory, child), "utf8"));
    }
  };
  await visit("");
  return result;
}

async function writeStage(root: string, file: string, content: string): Promise<void> {
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function sameTree(left: Map<string, string>, right: Map<string, string>): boolean {
  return (
    left.size === right.size && [...left].every(([file, content]) => right.get(file) === content)
  );
}

function validateDelta(sql: string, createUsers: boolean): void {
  const allowed = new Set([
    "experiments",
    "cohorts",
    "user_cohorts",
    ...(createUsers ? ["users"] : []),
  ]);
  if (/(?:^|;|\n)\s*(?:DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(sql))
    throw new Error(
      "Drizzle generated destructive or unrelated data changes; resolve existing schema differences first.",
    );
  const targets = [
    ...sql.matchAll(
      /(?:CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX\s+[^;]+?\s+ON)\s+(?:"public"\.)?["`]?([\w]+)["`]?/gi,
    ),
  ];
  if (targets.some((match) => !allowed.has(match[1]!)))
    throw new Error(
      "Drizzle generated changes to application tables; resolve pending schema changes before xp setup.",
    );
  for (const table of allowed) {
    if (
      !new RegExp(`CREATE\\s+TABLE\\s+(?:"public"\\.)?["\x60]?${table}["\x60]?\\s*\\(`, "i").test(
        sql,
      )
    )
      throw new Error(`Drizzle did not generate the expected ${table} table.`);
  }
}

export async function generateDrizzle(
  options: ResolvedSetup,
  project: ProjectDetection,
): Promise<GeneratedArtifacts> {
  if (options.database !== "postgres" && options.database !== "mysql")
    throw new Error(
      "Stable Drizzle setup supports PostgreSQL and MySQL. Select native output for SQL Server.",
    );
  const artifacts: GeneratedArtifacts = {
    files: [],
    prerequisites: [],
    warnings: [],
    nextSteps: [],
  };
  const ext =
    options.language === "typescript"
      ? ".ts"
      : options.moduleFormat === "commonjs"
        ? ".cjs"
        : ".mjs";
  let roots: SchemaSource[] = [];
  let sources: SchemaSource[] = [];
  let user: UserExport | null = null;
  let inspectionError: string | undefined;
  try {
    const collected = await collectSources(options, project);
    roots = collected.roots;
    sources = collected.sources;
    if (collected.users.length > 1)
      throw new Error(
        "Multiple exported users tables were found; select an unambiguous schema entrypoint.",
      );
    user = collected.users[0] ?? null;
    if (user && options.userStorage === "create")
      throw new Error("An existing users table was found; select user-storage=reuse.");
    if (!user && options.userStorage === "reuse")
      throw new Error(
        "Export a users table with its physical id column from the selected schema, then run xp setup again.",
      );
  } catch (error) {
    inspectionError = error instanceof Error ? error.message : String(error);
  }
  const selected = options.schema ?? `src/db/schema${ext}`;
  let output = roots.length
    ? path.join(path.dirname(roots[0]!.path), `xp-schema${ext}`)
    : /[*?{}]/.test(selected)
      ? path.join(options.modelsDir, `xp-schema${ext}`)
      : selected;
  if (
    inspectionError &&
    !/[*?{}]/.test(selected) &&
    (await readInput(options, project, selected)) !== null
  )
    output = path.join(path.dirname(selected), `xp-schema${ext}`);
  const beforeOutput = await readInput(options, project, output);
  if (beforeOutput !== null)
    throw new Error(
      `Refusing to replace existing Drizzle schema ${output}. Choose a separate schema file or resolve the existing xp setup.`,
    );
  if (inspectionError) {
    // A standalone contribution uses a clearly named import placeholder; it is never reported as ready.
    const placeholder =
      options.userStorage === "reuse"
        ? {
            path: path.join(path.dirname(output), "application-users.ts"),
            export: "users",
            field: "id",
          }
        : null;
    artifacts.files.push({
      path: output,
      content: renderSchema(options, output, user ?? placeholder),
      purpose: "Drizzle schema contribution requiring manual integration",
    });
    artifacts.prerequisites.push(
      inspectionError,
      `Integrate ${output} into your Drizzle schema exports, fix its user-table import if needed, then run ${command(project, "drizzle-kit", `generate --name=xp_setup${options.config ? ` --config ${shellQuote(options.config)}` : ""}`)}. Review the generated SQL against the xp storage contract before applying it.`,
    );
    return artifacts;
  }
  const schema = renderSchema(options, output, user);
  artifacts.files.push({ path: output, content: schema, purpose: "Drizzle xp table declarations" });
  if (roots.length) {
    const entry = roots[0]!;
    const reference = moduleReference(entry.path, output);
    const exportLine =
      options.moduleFormat === "commonjs" && /\.(?:cjs|js)$/.test(entry.path)
        ? `Object.assign(module.exports, require(${JSON.stringify(reference)}));`
        : `export * from ${JSON.stringify(reference)};`;
    artifacts.files.push({
      path: entry.path,
      content: entry.content + `\n// xp setup schema\n${exportLine}\n`,
      purpose: "Register xp tables in the existing Drizzle schema",
      merge: true,
    });
  } else {
    const config = options.config ?? "drizzle.config.ts";
    const before = await readInput(options, project, config);
    if (before === null)
      artifacts.files.push({
        path: config,
        content: `export default {dialect: ${JSON.stringify(options.database === "postgres" ? "postgresql" : "mysql")}, schema: ${JSON.stringify(output)}, out: ${JSON.stringify(options.migrationsDir)}};\n`,
        purpose: "Drizzle schema and migration paths",
      });
    else
      artifacts.prerequisites.push(
        `Ensure ${config} includes schema ${output} and migration output ${options.migrationsDir}.`,
      );
  }
  const kit = await localPackage(options, project, "drizzle-kit");
  const orm = await localPackage(options, project, "drizzle-orm");
  if (!roots.length)
    artifacts.nextSteps.push(
      `Add your application database connection configuration to ${options.config ?? "drizzle.config.ts"} before running migrations.`,
    );
  if (!kit || !orm) {
    artifacts.prerequisites.push(
      `Install the supported drizzle-orm and drizzle-kit packages, then run ${command(project, "drizzle-kit", `generate --name=xp_setup${options.config ? ` --config ${shellQuote(options.config)}` : ""}`)}. No migration metadata was fabricated.`,
    );
    return artifacts;
  }
  if (!/^0\.31\.\d+$/.test(kit.version) || !/^0\.45\.\d+$/.test(orm.version))
    throw new Error(
      "Automatic Drizzle generation requires stable drizzle-kit 0.31.x and drizzle-orm 0.45.x.",
    );
  const historyPath = projectPath(options, options.migrationsDir);
  const history = await tree(historyPath);
  for (const file of history.keys())
    await readInput(options, project, path.join(options.migrationsDir, file));
  const stage = await mkdtemp(path.join(tmpdir(), "xp-drizzle-"));
  try {
    await mkdir(path.join(stage, "node_modules"));
    await symlink(orm.directory, path.join(stage, "node_modules", "drizzle-orm"), "dir");
    await writeFile(path.join(stage, "package.json"), '{"type":"module"}\n');
    for (const source of sources) await writeStage(stage, source.path, source.content);
    for (const [file, content] of history)
      await writeStage(stage, path.join("history", file), content);
    const config = path.join(stage, "xp-drizzle.config.cjs");
    const configure = async (schemaPaths: string[]): Promise<void> => {
      await writeFile(
        config,
        `module.exports = ${JSON.stringify({ dialect: options.database === "postgres" ? "postgresql" : "mysql", schema: schemaPaths.map((file) => path.join(stage, file)), out: "./history", breakpoints: true, strict: true })};\n`,
      );
    };
    if (roots.length) {
      await configure(roots.map((source) => source.path));
      await runLocal(
        kit.bin,
        ["generate", "--config", config, "--name=xp_baseline"],
        stage,
        {},
        project.signal,
      );
      if (!sameTree(history, await tree(path.join(stage, "history"))))
        throw new Error(
          "Drizzle has pending application schema changes or lacks baseline migration history. Generate and review those migrations before running xp setup.",
        );
    } else if (history.size)
      throw new Error(
        "Drizzle migration history exists without a resolvable schema; select the complete existing schema.",
      );
    await writeStage(stage, output, schema);
    await configure([...roots.map((source) => source.path), output]);
    const generationOutput = await runLocal(
      kit.bin,
      ["generate", "--config", config, "--name=xp_setup"],
      stage,
      {},
      project.signal,
    );
    const generated = await tree(path.join(stage, "history"));
    for (const [file, content] of history)
      if (generated.get(file) !== content && file !== path.join("meta", "_journal.json"))
        throw new Error(
          `Drizzle modified historical migration artifact ${file}; generation was rejected.`,
        );
    const sqlFiles = [...generated.keys()].filter(
      (file) => file.endsWith(".sql") && !history.has(file),
    );
    if (sqlFiles.length !== 1)
      throw new Error(
        `Drizzle did not produce exactly one new xp migration; generation requires manual review. ${generationOutput.slice(-1200)}`,
      );
    validateDelta(generated.get(sqlFiles[0]!)!, options.userStorage === "create");
    if (user) {
      const snapshotFile = [...generated.keys()].find(
        (file) => file.endsWith("_snapshot.json") && !history.has(file),
      );
      if (!snapshotFile)
        throw new Error(
          "Drizzle did not produce a schema snapshot to verify the existing user key.",
        );
      const snapshot = JSON.parse(generated.get(snapshotFile)!) as {
        tables: Record<string, { name: string; columns: Record<string, { type: string }> }>;
      };
      const tables = Object.values(snapshot.tables);
      const users = tables.find((table) => table.name === "users");
      const assignments = tables.find((table) => table.name === "user_cohorts");
      const normalize = (type: string | undefined): string =>
        (type ?? "")
          .toLowerCase()
          .replace(/\s+(?:collate|character set)\s+.*/i, "")
          .replace(/\s+/g, "")
          .replace(/^serial$/, "integer")
          .replace(/^bigserial$/, "bigint")
          .replace(/^int$/, "integer");
      if (
        !users ||
        !assignments ||
        normalize(users.columns["id"]?.type) !== normalize(assignments.columns["user_id"]?.type)
      )
        throw new Error(
          "The selected user ID type differs from the existing Drizzle users.id column. Supply its exact database type before generating the migration.",
        );
    }
    generated.set(
      sqlFiles[0]!,
      `-- xp storage schema v${STORAGE_VERSION}\n${renderSql(options).up.join("\n--> statement-breakpoint\n")}\n`,
    );
    for (const [file, content] of generated)
      if (history.get(file) !== content)
        artifacts.files.push({
          path: path.join(options.migrationsDir, file),
          content,
          purpose: file.endsWith(".sql")
            ? "Drizzle SQL migration"
            : "Drizzle-generated migration metadata",
          merge: history.has(file),
        });
    artifacts.nextSteps.push(
      command(
        project,
        "drizzle-kit",
        `migrate${options.config ? ` --config ${shellQuote(options.config)}` : ""}`,
      ),
    );
    artifacts.warnings.push(
      "Retain the generated SQL's explicit collations and CHECK constraints. Drizzle owns the accompanying snapshot and journal.",
    );
  } catch (error) {
    project.signal?.throwIfAborted();
    artifacts.prerequisites.push(
      error instanceof Error ? error.message : String(error),
      `Run ${command(project, "drizzle-kit", `generate --name=xp_setup${options.config ? ` --config ${shellQuote(options.config)}` : ""}`)} after resolving the schema/history issue. No migration or metadata changes have been included.`,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  artifacts.nextSteps.push(
    "Use a native pg or mysql2 client with xp/server; generated Drizzle schemas do not enable server(drizzleClient).",
  );
  return artifacts;
}
