import { parse } from "@babel/parser";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import type { ProjectDetection, SetupDatabase, SetupOptions, SetupOrm } from "~/interfaces/setup";

import { DATABASES, ORMS } from "~/interfaces/setup";

import { fingerprint, projectRoot, readText, relativePath, sourceFiles } from "./filesystem";
import { ORM_PACKAGES, defaultVersion } from "./registry";

const OPTION_KEYS = [
  "orm",
  "database",
  "ormVersion",
  "config",
  "schema",
  "migrationsDir",
  "models",
  "modelsDir",
  "language",
  "moduleFormat",
  "userStorage",
  "userIdType",
  "userIdCollation",
  "userIdCharset",
  "tableName",
] as const;

export function storedOptions(value: unknown): SetupOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean: Record<string, unknown> = {};
  for (const key of OPTION_KEYS) {
    const option = (value as Record<string, unknown>)[key];
    if (
      option !== undefined &&
      (typeof option === "string" || (key === "models" && typeof option === "boolean"))
    )
      clean[key] = option;
  }
  return clean as SetupOptions;
}

// Config is parsed, never imported. Only literal data and known path operations are evaluated.
type AstNode = { type: string; [key: string]: any };
type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };
function configLiteral(
  source: string,
  file: string,
  root: string,
): { values: Record<string, Literal>; dynamic: boolean; unresolved: (keyof SetupOptions)[] } {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "decorators-legacy"],
    errorRecovery: false,
  });
  const bindings = new Map<string, AstNode>();
  const pathNames = new Set(["path"]);
  const pathFunctions = new Set<string>();
  const roots: AstNode[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const item = node as AstNode;
    if (
      item.type === "ImportDeclaration" &&
      ["path", "node:path"].includes(item["source"]?.value)
    ) {
      for (const specifier of item["specifiers"] ?? []) {
        if (specifier.type === "ImportSpecifier") pathFunctions.add(specifier.local.name);
        else pathNames.add(specifier.local.name);
      }
    }
    if (item.type === "VariableDeclarator" && item["id"]?.type === "Identifier" && item["init"])
      bindings.set(item["id"].name, item["init"]);
    if (item.type === "ExportDefaultDeclaration") roots.push(item["declaration"]);
    if (
      item.type === "AssignmentExpression" &&
      item["left"]?.type === "MemberExpression" &&
      item["left"].object?.name === "module" &&
      item["left"].property?.name === "exports"
    )
      roots.push(item["right"]);
    if (item.type === "NewExpression" && item["callee"]?.name === "DataSource") roots.push(item);
    for (const [key, child] of Object.entries(item)) {
      if (["loc", "start", "end", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast.program);
  let dynamic = false;
  const unresolved = new Set<keyof SetupOptions>();
  const affected = (keys: string[]): (keyof SetupOptions)[] => {
    const key = keys.at(-1);
    if (["dialect", "client", "type", "provider"].includes(key ?? "")) return ["database"];
    if (
      ["migrations-path", "out", "migrations"].includes(key ?? "") ||
      (keys.includes("migrations") && ["path", "pathTs", "directory"].includes(key ?? ""))
    )
      return ["migrationsDir"];
    if (["models-path", "entities", "entitiesTs"].includes(key ?? "")) return ["modelsDir"];
    if (key === "schema") return ["schema"];
    if (key === "config" && file.endsWith(".sequelizerc")) return ["config"];
    return [];
  };
  const markUnknownObject = (keys: string[]): void => {
    const specific = affected(keys);
    if (specific.length) specific.forEach((key) => unresolved.add(key));
    else if (!keys.some((key) => ["connection", "dbCredentials", "pool", "ssl"].includes(key))) {
      for (const key of ["database", "migrationsDir", "modelsDir", "schema"] as const)
        unresolved.add(key);
      if (file.endsWith(".sequelizerc")) unresolved.add("config");
    }
  };
  const evaluate = (
    node: AstNode | undefined,
    seen = new Set<string>(),
    keys: string[] = [],
  ): Literal | undefined => {
    if (!node) return undefined;
    if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node.type))
      return node["value"];
    if (node.type === "NullLiteral") return null;
    if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type))
      return evaluate(node["expression"], seen, keys);
    if (node.type === "TemplateLiteral" && node["expressions"].length === 0)
      return node["quasis"][0]?.value.cooked;
    if (node.type === "Identifier") {
      const name = node["name"] as string;
      if (name === "__dirname") return path.dirname(file);
      if (name === "__filename") return file;
      if (!seen.has(name) && bindings.has(name))
        return evaluate(bindings.get(name), new Set([...seen, name]), keys);
    }
    if (node.type === "ArrayExpression") {
      const values = (node["elements"] as AstNode[]).map((entry) => evaluate(entry, seen, keys));
      if (values.every((value): value is Literal => value !== undefined)) return values;
    }
    if (node.type === "ObjectExpression") {
      const values: Record<string, Literal> = {};
      for (const property of node["properties"] as AstNode[]) {
        if (property.type === "SpreadElement") {
          const spread = evaluate(property["argument"], seen, keys);
          if (spread && typeof spread === "object" && !Array.isArray(spread))
            Object.assign(values, spread);
          else {
            dynamic = true;
            markUnknownObject(keys);
          }
        } else if (property.type === "ObjectProperty" && !property["computed"]) {
          const key = property["key"]?.name ?? property["key"]?.value;
          const propertyKeys = typeof key === "string" ? [...keys, key] : keys;
          const value = evaluate(property["value"], seen, propertyKeys);
          if (typeof key === "string" && value !== undefined) values[key] = value;
          else affected(propertyKeys).forEach((option) => unresolved.add(option));
        } else {
          dynamic = true;
          const key = property["key"]?.name ?? property["key"]?.value;
          markUnknownObject(
            !property["computed"] && typeof key === "string" ? [...keys, key] : keys,
          );
        }
      }
      return values;
    }
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const callee = node["callee"] as AstNode;
      const args = node["arguments"] as AstNode[];
      if (["defineConfig", "DataSource"].includes(callee?.["name"]))
        return evaluate(args[0], seen, keys);
      if (
        callee?.type === "MemberExpression" &&
        callee["object"]?.name === "process" &&
        callee["property"]?.name === "cwd"
      )
        return root;
      const isMemberPath =
        callee?.type === "MemberExpression" &&
        pathNames.has(callee["object"]?.name) &&
        ["resolve", "join"].includes(callee["property"]?.name);
      const isPathFunction = callee?.type === "Identifier" && pathFunctions.has(callee["name"]);
      if (isMemberPath || isPathFunction) {
        const parts = args.map((argument) => evaluate(argument, seen));
        if (parts.every((part): part is string => typeof part === "string"))
          return path.resolve(root, ...parts);
      }
    }
    dynamic = true;
    return undefined;
  };
  const values: Record<string, Literal> = {};
  for (const entry of roots) {
    const value = evaluate(entry);
    if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(values, value);
    else markUnknownObject([]);
  }
  return { values, dynamic, unresolved: [...unresolved] };
}

function nestedObjects(value: Record<string, Literal>): Record<string, Literal>[] {
  const entries = [value];
  for (const child of Object.values(value))
    if (child && typeof child === "object" && !Array.isArray(child))
      entries.push(...nestedObjects(child));
  return entries;
}

function provider(value: unknown): SetupDatabase | undefined {
  const aliases: Record<string, SetupDatabase> = {
    postgresql: "postgres",
    pg: "postgres",
    postgres: "postgres",
    mysql2: "mysql",
    mysql: "mysql",
    mssql: "mssql",
    sqlserver: "mssql",
    mongodb: "mongodb",
    dynamodb: "dynamodb",
  };
  return typeof value === "string" ? aliases[value.toLowerCase()] : undefined;
}

function strings(value: Literal | undefined): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
}

function directoryValue(value: string): string {
  const prefix = value.split(/[*!{]/)[0] ?? value;
  return /\.[cm]?[jt]s$/.test(prefix) ? path.dirname(prefix) : prefix.replace(/[/]$/, "") || ".";
}

export async function detectProject(explicit: SetupOptions = {}): Promise<ProjectDetection> {
  explicit.signal?.throwIfAborted();
  const cwd = await projectRoot(explicit.cwd ?? process.cwd(), explicit.cwd !== undefined);
  const inputs: Record<string, string | null> = {};
  const sources: string[] = [];
  const warnings: string[] = [];
  const read = async (file: string): Promise<string | null> => {
    const content = await readText(path.resolve(cwd, file));
    inputs[relativePath(cwd, file)] = content === null ? null : fingerprint(content);
    return content;
  };
  let saved: SetupOptions = {};
  const state = await read(".xp/setup.json");
  if (state) {
    try {
      saved = storedOptions(JSON.parse(state).options);
      sources.push(".xp/setup.json");
    } catch (error) {
      throw new Error(
        "Cannot read .xp/setup.json; restore or remove the invalid setup manifest before continuing.",
        { cause: error },
      );
    }
  }
  const manifestSource = await read("package.json");
  let manifest: Record<string, any> = {};
  if (manifestSource) {
    try {
      manifest = JSON.parse(manifestSource);
      sources.push("package.json");
    } catch (error) {
      throw new Error("Cannot parse the project's package.json.", { cause: error });
    }
  }
  const dependencies = {
    ...manifest["dependencies"],
    ...manifest["devDependencies"],
    ...manifest["peerDependencies"],
  } as Record<string, string>;
  const versions: Record<string, string> = {};
  const packages = [
    ...Object.values(ORM_PACKAGES),
    "@prisma/client",
    "sequelize-cli",
    "drizzle-kit",
    "pg",
    "mysql2",
    "mssql",
    "mongodb",
    "@aws-sdk/lib-dynamodb",
    "@mikro-orm/postgresql",
    "@mikro-orm/mysql",
    "@mikro-orm/mssql",
    "@mikro-orm/mongodb",
    "@mikro-orm/migrations",
    "@mikro-orm/migrations-mongodb",
  ];
  const require = createRequire(path.join(cwd, "package.json"));
  for (const name of packages) {
    if (!dependencies[name]) continue;
    let packageFile: string | undefined;
    try {
      packageFile = require.resolve(`${name}/package.json`);
    } catch {
      // Package exports may hide metadata. Locate it beside a resolved entry without loading code.
      try {
        let directory = path.dirname(require.resolve(name));
        while (true) {
          const candidate = path.join(directory, "package.json");
          const content = await readText(candidate);
          if (content && JSON.parse(content).name === name) {
            packageFile = candidate;
            break;
          }
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      } catch {
        /* An uninstalled dependency is a prerequisite, not executable configuration. */
      }
    }
    if (packageFile) {
      const content = await read(packageFile);
      const version = content ? JSON.parse(content).version : undefined;
      if (typeof version === "string") versions[name] = version;
    }
  }
  const ormCandidates = Object.entries(ORM_PACKAGES)
    .filter(
      ([orm, name]) => dependencies[name] || (orm === "prisma" && dependencies["@prisma/client"]),
    )
    .map(([orm]) => orm as SetupOrm);
  const chosenOrm =
    explicit.orm ??
    saved.orm ??
    (ormCandidates.length === 1
      ? ormCandidates[0]
      : ormCandidates.length === 0
        ? "none"
        : undefined);
  if (chosenOrm && !ORMS.includes(chosenOrm)) throw new Error(`Unknown ORM: ${chosenOrm}`);
  const inferred: SetupOptions = {};
  if (chosenOrm) inferred.orm = chosenOrm;
  const configNames: Record<SetupOrm, string[]> = {
    sequelize: [
      ".sequelizerc",
      "sequelize.config.ts",
      "config/config.json",
      "config/config.js",
      "config/config.cjs",
    ],
    prisma: ["prisma.config.ts", "prisma.config.js"],
    drizzle: ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mts"],
    typeorm: [
      "data-source.ts",
      "data-source.js",
      "src/data-source.ts",
      "src/database/data-source.ts",
      "ormconfig.json",
    ],
    mikroorm: ["mikro-orm.config.ts", "mikro-orm.config.js", "src/mikro-orm.config.ts"],
    knex: ["knexfile.ts", "knexfile.js", "knexfile.cjs", "knexfile.mjs"],
    kysely: ["kysely.config.ts", "kysely.config.js"],
    mongoose: [],
    none: [],
  };
  const configs = explicit.config
    ? [explicit.config]
    : saved.config
      ? [saved.config]
      : chosenOrm
        ? configNames[chosenOrm]
        : [];
  const configuredProviders = new Set<SetupDatabase>();
  const configuredPaths = {
    migrationsDir: new Set<string>(),
    modelsDir: new Set<string>(),
    schema: new Set<string>(),
  };
  let dynamicConfiguration = false;
  const unresolvedConfig = new Set<keyof SetupOptions>();
  for (let index = 0; index < configs.length; index++) {
    const file = configs[index]!;
    const source = await read(file);
    if (!source) continue;
    sources.push(file);
    let values: Record<string, Literal>;
    try {
      const parsed = file.endsWith(".json")
        ? { values: JSON.parse(source), dynamic: false, unresolved: [] }
        : configLiteral(source, path.resolve(cwd, file), cwd);
      values = parsed.values;
      dynamicConfiguration ||= parsed.dynamic;
      parsed.unresolved.forEach((key) => unresolvedConfig.add(key));
    } catch {
      warnings.push(`Could not statically inspect ${file}; provide its setup values explicitly.`);
      for (const key of ["database", "migrationsDir", "modelsDir", "schema"] as const)
        unresolvedConfig.add(key);
      continue;
    }
    if (!file.endsWith(".sequelizerc")) inferred.config = relativePath(cwd, file);
    const configuredPath = values["config"];
    if (typeof configuredPath === "string" && file.endsWith(".sequelizerc")) {
      if (path.resolve(cwd, configuredPath) === path.resolve(cwd, file))
        throw new Error("The Sequelize configuration cannot point back to .sequelizerc.");
      // The rc's config path is authoritative; old default config files may target a different database.
      inferred.config = relativePath(cwd, configuredPath);
      configs.splice(index + 1, configs.length - index - 1, configuredPath);
    }
    const configBase = chosenOrm === "prisma" ? path.dirname(path.resolve(cwd, file)) : cwd;
    const objects = nestedObjects(values);
    for (const object of objects) {
      const db = provider(
        object["dialect"] ?? object["client"] ?? object["type"] ?? object["provider"],
      );
      if (db) configuredProviders.add(db);
      const migration =
        object["migrations-path"] ??
        object["out"] ??
        (object["migrations"] &&
        typeof object["migrations"] === "object" &&
        !Array.isArray(object["migrations"])
          ? (object["migrations"]["path"] ?? object["migrations"]["directory"])
          : object["migrations"]);
      for (const value of strings(migration))
        configuredPaths.migrationsDir.add(
          relativePath(cwd, path.resolve(configBase, directoryValue(value))),
        );
      for (const value of strings(
        object["models-path"] ?? object["entitiesTs"] ?? object["entities"],
      ))
        configuredPaths.modelsDir.add(relativePath(cwd, directoryValue(value)));
      for (const value of strings(object["schema"]))
        configuredPaths.schema.add(relativePath(cwd, path.resolve(configBase, value)));
    }
  }
  for (const key of ["migrationsDir", "modelsDir", "schema"] as const) {
    const values = [...configuredPaths[key]];
    if (values.length === 1) inferred[key] = values[0]!;
    else if (values.length > 1)
      warnings.push(
        `Configuration has multiple ${key} values; select the intended path explicitly.`,
      );
  }
  if (dynamicConfiguration)
    warnings.push(
      "Configuration contains dynamic expressions. Only literal setup values were detected; application code was not executed.",
    );
  const schemaPath =
    explicit.schema ??
    saved.schema ??
    inferred.schema ??
    (chosenOrm === "prisma" ? "prisma/schema.prisma" : undefined);
  if (schemaPath && chosenOrm === "prisma") {
    inferred.schema = schemaPath;
    const schemaParts: string[] = [];
    try {
      const content = await read(schemaPath);
      if (content !== null) {
        schemaParts.push(content);
        sources.push(schemaPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
      for (const file of (await sourceFiles(cwd, schemaPath)).filter((file) =>
        file.endsWith(".prisma"),
      )) {
        const content = await read(file);
        if (content !== null) {
          schemaParts.push(content);
          sources.push(file);
        }
      }
    }
    const schema = schemaParts.join("\n");
    if (schema) {
      const withoutComments = schema.replace(/\/\/[^\n]*/g, "");
      const db = provider(
        withoutComments.match(/datasource\s+\w+\s*\{[^}]*\bprovider\s*=\s*["']([^"']+)["']/s)?.[1],
      );
      if (db) configuredProviders.add(db);
      for (const model of withoutComments.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)) {
        const body = model[2]!;
        if (!(body.includes('@@map("users")') || model[1] === "users")) continue;
        const field =
          body
            .split("\n")
            .find((line) => /^\s*id\s+/.test(line) && !/@map\(["']_id["']\)/.test(line)) ??
          body.split("\n").find((line) => /@map\(["']id["']\)/.test(line));
        if (!field) {
          warnings.push(
            "The users Prisma model does not expose the physical users.id required by xp.",
          );
          continue;
        }
        const native = field.match(/@db\.(\w+)(?:\((\d+)\))?/);
        if (native) {
          const names: Record<string, string> = {
            Uuid: "UUID",
            VarChar: "VARCHAR",
            NVarChar: "NVARCHAR",
            Char: "CHAR",
            Text: "TEXT",
            Int: "INTEGER",
            BigInt: "BIGINT",
            SmallInt: "SMALLINT",
            UnsignedInt: "INT UNSIGNED",
            UniqueIdentifier: "UNIQUEIDENTIFIER",
          };
          const type = names[native[1]!];
          if (type) inferred.userIdType = type + (native[2] ? `(${native[2]})` : "");
        } else if (/\sInt\s/.test(field)) inferred.userIdType = "INTEGER";
        else if (db === "postgres" && /\sString\s/.test(field)) inferred.userIdType = "TEXT";
        else if (db === "mongodb")
          inferred.userIdType = /\s(?:Int|Float)\s/.test(field) ? "number" : "string";
      }
    }
  }
  const drivers: Record<string, SetupDatabase> = {
    pg: "postgres",
    mysql2: "mysql",
    mssql: "mssql",
    mongodb: "mongodb",
    mongoose: "mongodb",
    "@aws-sdk/lib-dynamodb": "dynamodb",
    "@mikro-orm/postgresql": "postgres",
    "@mikro-orm/mysql": "mysql",
    "@mikro-orm/mssql": "mssql",
    "@mikro-orm/mongodb": "mongodb",
  };
  const databaseCandidates = [
    ...new Set(
      configuredProviders.size
        ? configuredProviders
        : Object.entries(drivers)
            .filter(([name]) => dependencies[name])
            .map(([, db]) => db),
    ),
  ];
  if (chosenOrm === "mongoose" && !databaseCandidates.includes("mongodb"))
    databaseCandidates.push("mongodb");
  if (databaseCandidates.length === 1) inferred.database = databaseCandidates[0]!;
  const selectedProvider = explicit.database ?? saved.database;
  if (selectedProvider && configuredProviders.size && !configuredProviders.has(selectedProvider)) {
    warnings.push(
      `Selected database ${selectedProvider} differs from configuration provider ${[...configuredProviders].join(", ")}. Generated files target ${selectedProvider}; correct the configuration before running any printed migration command.`,
    );
  }
  const tsconfig = await read("tsconfig.json");
  inferred.language = tsconfig ? "typescript" : "javascript";
  inferred.moduleFormat = manifest["type"] === "module" ? "esm" : "commonjs";
  const userDirectory = explicit.modelsDir ?? saved.modelsDir ?? inferred.modelsDir ?? "models";
  const userFiles = (await sourceFiles(cwd, userDirectory, 1)).filter((file) =>
    /(?:^|[/_.-])users?(?:[/.\-_]|$)/i.test(file),
  );
  for (const file of userFiles) {
    const source = await read(file);
    if (!source) continue;
    // Only read a literal Sequelize users definition; custom fields and mappings remain unresolved.
    if (
      chosenOrm !== "sequelize" ||
      !/\btableName\s*:\s*["']users["']|\.define\(\s*["']users["']/.test(source)
    )
      continue;
    const id = source
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .match(/\bid\s*:\s*\{([^}]+)\}/)?.[1];
    if (!id || /\bfield\s*:\s*["'](?!id["'])/.test(id)) continue;
    const type = id.match(
      /\btype\s*:\s*(?:DataTypes\.|Sequelize\.)?(TEXT|UUID|INTEGER|BIGINT|STRING|CHAR)(?:\(\s*(\d+)\s*\))?(\.UNSIGNED)?/,
    );
    if (!type) continue;
    const db = explicit.database ?? saved.database ?? inferred.database;
    const name = type[1]!;
    if (name === "STRING" || name === "CHAR")
      inferred.userIdType = `${name === "STRING" ? (db === "mssql" ? "NVARCHAR" : "VARCHAR") : "CHAR"}(${type[2] ?? "255"})`;
    else
      inferred.userIdType =
        (name === "UUID" && db === "mysql"
          ? "CHAR(36)"
          : name === "UUID" && db === "mssql"
            ? "UNIQUEIDENTIFIER"
            : name) + (type[3] ? " UNSIGNED" : "");
    const collation = source.match(/\bcollate\s*:\s*["']([^"']+)["']/)?.[1];
    const charset = source.match(/\bcharset\s*:\s*["']([^"']+)["']/)?.[1];
    if (collation) inferred.userIdCollation = collation;
    if (charset) inferred.userIdCharset = charset;
    sources.push(file);
  }
  const options: SetupOptions = {
    models: false,
    modelsDir: "models",
    userStorage: "reuse",
    tableName: "xp",
    ...inferred,
    ...saved,
    ...storedOptions(explicit),
    cwd,
  };
  options.migrationsDir ??=
    options.orm === "prisma"
      ? "prisma/migrations"
      : options.orm === "drizzle"
        ? "drizzle"
        : "migrations";
  if (options.orm === "prisma") options.schema ??= "prisma/schema.prisma";
  if (options.orm === "drizzle") options.schema ??= "src/schema.ts";
  if (options.orm && options.orm !== "none") {
    const version =
      versions[ORM_PACKAGES[options.orm]] ??
      (options.database ? defaultVersion(options.orm, options.database) : undefined);
    if (version) options.ormVersion ??= version;
  }
  if (
    !options.userIdType &&
    (options.userStorage === "create" || ["mongodb", "dynamodb"].includes(options.database ?? ""))
  ) {
    const defaults: Record<SetupDatabase, string> = {
      postgres: "TEXT",
      mysql: "VARCHAR(191)",
      mssql: "NVARCHAR(255)",
      mongodb: "string",
      dynamodb: "string",
    };
    if (options.database) options.userIdType = defaults[options.database];
    if (options.userStorage === "create" && options.database === "mysql") {
      options.userIdCharset ??= "utf8mb4";
      options.userIdCollation ??= "utf8mb4_0900_bin";
    }
    if (options.userStorage === "create" && options.database === "mssql")
      options.userIdCollation ??= "Latin1_General_100_BIN2";
  }
  if (options.orm && !ORMS.includes(options.orm)) throw new Error(`Unknown ORM: ${options.orm}`);
  if (options.database && !DATABASES.includes(options.database))
    throw new Error(`Unsupported database: ${options.database}`);
  const missing: (keyof SetupOptions)[] = [];
  for (const key of ["migrationsDir", "modelsDir", "schema"] as const) {
    if (
      configuredPaths[key].size > 1 &&
      explicit[key] === undefined &&
      saved[key] === undefined &&
      (key !== "modelsDir" || options.models)
    )
      missing.push(key);
  }
  for (const key of unresolvedConfig) {
    if (explicit[key] !== undefined || saved[key] !== undefined) continue;
    if (key === "modelsDir" && !options.models) continue;
    if (key === "schema" && options.orm !== "prisma" && options.orm !== "drizzle") continue;
    if (!missing.includes(key)) missing.push(key);
  }
  if (!options.orm) missing.push("orm");
  if (!options.database) missing.push("database");
  if (!options.userIdType) missing.push("userIdType");
  if (
    options.userStorage === "reuse" &&
    options.userIdType &&
    /(?:CHAR|TEXT)/i.test(options.userIdType) &&
    ["mysql", "mssql"].includes(options.database ?? "")
  ) {
    if (!options.userIdCollation) missing.push("userIdCollation");
    if (options.database === "mysql") {
      const charset = options.userIdCollation?.split("_")[0];
      if (charset) options.userIdCharset ??= charset;
      if (!options.userIdCharset) missing.push("userIdCharset");
    }
  }
  const manager =
    typeof manifest["packageManager"] === "string"
      ? manifest["packageManager"].split("@")[0]
      : undefined;
  let packageManager: ProjectDetection["packageManager"] = ["bun", "pnpm", "npm", "yarn"].includes(
    manager ?? "",
  )
    ? (manager as ProjectDetection["packageManager"])
    : "npm";
  if (!manager) {
    for (const [lock, name] of [
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ] as const) {
      if ((await read(lock)) !== null) {
        packageManager = name;
        break;
      }
    }
  }
  explicit.signal?.throwIfAborted();
  return {
    ...(explicit.signal ? { signal: explicit.signal } : {}),
    cwd,
    options,
    ormCandidates,
    databaseCandidates,
    versions,
    packageManager,
    sources: [...new Set(sources)],
    warnings,
    missing,
    inputs,
  };
}
