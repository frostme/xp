export const ORMS = [
  "sequelize",
  "typeorm",
  "mikroorm",
  "prisma",
  "drizzle",
  "kysely",
  "knex",
  "mongoose",
  "none",
] as const;
export const DATABASES = ["postgres", "mysql", "mssql", "mongodb", "dynamodb"] as const;
export type SetupOrm = (typeof ORMS)[number];
export type SetupDatabase = (typeof DATABASES)[number];
export type SetupLanguage = "typescript" | "javascript";
export type SetupModuleFormat = "esm" | "commonjs";

/** Paths are relative to cwd; setup never contains connection credentials. */
export interface SetupOptions {
  /** Cancels inspection/local generation; never persisted as a setup choice. */
  signal?: AbortSignal;
  cwd?: string;
  orm?: SetupOrm;
  database?: SetupDatabase;
  ormVersion?: string;
  config?: string;
  schema?: string;
  migrationsDir?: string;
  models?: boolean;
  modelsDir?: string;
  language?: SetupLanguage;
  moduleFormat?: SetupModuleFormat;
  userStorage?: "reuse" | "create";
  /** Exact SQL type (including length/unsignedness), or string/number for MongoDB. */
  userIdType?: string;
  userIdCollation?: string;
  userIdCharset?: string;
  tableName?: string;
}

export interface ResolvedSetup extends SetupOptions {
  cwd: string;
  orm: SetupOrm;
  database: SetupDatabase;
  migrationsDir: string;
  models: boolean;
  modelsDir: string;
  language: SetupLanguage;
  moduleFormat: SetupModuleFormat;
  userStorage: "reuse" | "create";
  userIdType: string;
  tableName: string;
}

export interface ProjectDetection {
  signal?: AbortSignal;
  cwd: string;
  options: SetupOptions;
  ormCandidates: SetupOrm[];
  databaseCandidates: SetupDatabase[];
  /** Installed package versions, keyed by package name. */
  versions: Record<string, string>;
  packageManager: "bun" | "pnpm" | "npm" | "yarn";
  sources: string[];
  warnings: string[];
  missing: (keyof SetupOptions)[];
  /** Relative paths and SHA-256 hashes; null means absent. */
  inputs: Record<string, string | null>;
}

export interface GeneratedFile {
  path: string;
  content: string;
  purpose: string;
  /** Allows a reviewed, precise modification to an existing schema/config file. */
  merge?: boolean;
}

export interface GeneratedArtifacts {
  files: GeneratedFile[];
  warnings: string[];
  prerequisites: string[];
  nextSteps: string[];
}

export interface FileChange extends GeneratedFile {
  action: "create" | "update" | "unchanged";
  before: string | null;
  beforeHash: string | null;
}

export interface SetupPlan extends GeneratedArtifacts {
  schemaVersion: number;
  options: ResolvedSetup;
  files: FileChange[];
  inputs: Record<string, string | null>;
  status: "ready" | "manual-steps-required";
}

export interface SetupResult {
  status: "complete" | "manual-steps-required" | "unchanged";
  files: string[];
  prerequisites: string[];
  nextSteps: string[];
  warnings: string[];
}

export interface ISetupGenerator {
  generate(options: ResolvedSetup, project: ProjectDetection): Promise<GeneratedArtifacts>;
}

export interface IProjectManager {
  detectProject(options?: SetupOptions): Promise<ProjectDetection>;
  planSetup(options?: SetupOptions): Promise<SetupPlan>;
  applySetup(plan: SetupPlan): Promise<SetupResult>;
}
