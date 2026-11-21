import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  FileChange,
  IProjectManager,
  ISetupGenerator,
  ProjectDetection,
  ResolvedSetup,
  ScopedSetupOptions,
  ScopedSetupPlan,
  SetupOptions,
  SetupPlan,
  SetupResult,
} from "~/interfaces/setup";

import { ANALYTICS_VERSION } from "./analyticsStorage";
import { detectProject, storedOptions } from "./discovery";
import { checkOutputPath, fingerprint, readText, relativePath, resolveOutput } from "./filesystem";
import { detectScoped, frontendPlan, requestedScope } from "./frontend/plan";
import { addAnalytics } from "./generators/analytics";
import { generateUpgrade } from "./generators/upgrade";
import { validateProfile } from "./registry";
import { STORAGE_VERSION } from "./storage";
const MANIFEST = ".xp/setup.json";
interface SetupManifest {
  schemaVersion: number;
  extensions?: Record<string, number>;
  options: SetupOptions;
  files: { path: string; hash: string; purpose: string }[];
  warnings: string[];
  prerequisites: string[];
  profilePrerequisites?: string[];
  nextSteps: string[];
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
function equivalent(settings: SetupOptions, manifest: SetupManifest): boolean {
  const saved = storedOptions(manifest.options);
  // A first run can generate the conventional config itself. Discovery will find
  // that same path on every later run, although the original options omitted it.
  if (
    !saved.config &&
    settings.config &&
    manifest.files.some(
      (entry) =>
        entry.path === settings.config &&
        (entry.purpose === "Drizzle schema and migration paths" ||
          entry.purpose === "Prisma schema/migration paths and environment-based connection"),
    )
  )
    saved.config = settings.config;
  const current = storedOptions(settings);
  delete current.analytics;
  delete saved.analytics;
  return JSON.stringify(current) === JSON.stringify(storedOptions(saved));
}
/** These host-owned files are retained verbatim or receive a targeted schema edit. */
function canUpgradeEditedFile(
  manifest: SetupManifest,
  entry: SetupManifest["files"][number],
  current: string,
): boolean {
  if (
    [
      "Drizzle schema and migration paths",
      "Register xp tables in the existing Drizzle schema",
      "Integrated Prisma xp schema",
      "Align Prisma schema and migration paths",
      "Prisma schema/migration paths and environment-based connection",
    ].includes(entry.purpose)
  )
    return true;
  if (
    entry.purpose !== "Drizzle-generated migration metadata" ||
    !entry.path.endsWith("/meta/_journal.json")
  )
    return false;
  // Drizzle appends to the journal for the host's own migrations. Verify the
  // original bytes as a prefix of its entries before accepting an extension.
  const journal = JSON.parse(current);
  if (!Array.isArray(journal?.entries)) return false;
  const migration = manifest.files.findLast((file) => file.purpose === "Drizzle SQL migration");
  if (!migration) return false;
  const tag = path.basename(migration.path, ".sql");
  const index = journal.entries.findIndex((item: { tag: string }) => item?.tag === tag);
  return (
    index >= 0 &&
    fingerprint(
      JSON.stringify(
        {
          ...journal,
          entries: journal.entries.slice(0, index + 1),
        },
        null,
        2,
      ),
    ) === entry.hash
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
/** Re-evaluate dependency-only guidance without regenerating files or assuming manual work is done. */
function pendingPrerequisites(manifest: SetupManifest, project: ProjectDetection): string[] {
  const profile = new Set(strings(manifest.profilePrerequisites));
  const installed = (name: string) => Boolean(project.versions[name]);
  return strings(manifest.prerequisites).flatMap((message) => {
    if (profile.has(message)) return [];
    // Older manifests did not keep profile requirements separate.
    const packageRequirement = message.match(
      /^Install (?:compatible )?((?:@[\w.-]+\/)?[\w.-]+)@[^ ]+ (?:in the application before using its generated files|before using the generated files)\.$/,
    );
    if (packageRequirement && installed(packageRequirement[1]!)) return [];
    if (
      message === "Install sequelize-cli v6 to run the generated migration." &&
      installed("sequelize-cli")
    )
      return [];
    if (
      /^Install the mongodb native driver before running the bootstrap or using (?:@frostme\/)?xp\/server\.$/.test(
        message,
      ) &&
      installed("mongodb")
    )
      return [];
    if (
      message.startsWith("Install @mikro-orm/migrations-mongodb v7 and ") &&
      installed("@mikro-orm/migrations-mongodb")
    )
      return ["Register the MongoDB Migrator extension in your MikroORM configuration."];
    if (
      message.startsWith("Install @mikro-orm/migrations v7 and ") &&
      installed("@mikro-orm/migrations")
    )
      return ["Register the Migrator extension in your MikroORM configuration."];
    if (message.startsWith("Install the supported Prisma CLI and ") && installed("prisma"))
      return [message.replace("Install the supported Prisma CLI and run", "Run")];
    if (
      message.startsWith("Install the supported drizzle-orm and drizzle-kit packages, then ") &&
      installed("drizzle-orm") &&
      installed("drizzle-kit")
    )
      return [
        message.replace(
          "Install the supported drizzle-orm and drizzle-kit packages, then run",
          "Run",
        ),
      ];
    return [message];
  });
}

function isMigration(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    /\.(?:sql|[cm]?[jt]s)$/.test(file)
  );
}

function resolved(project: ProjectDetection): ResolvedSetup {
  if (project.missing.length) {
    const flags = project.missing
      .map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
      .join(", ");
    throw new Error(`Setup needs ${flags}. Run interactively or provide these arguments.`);
  }
  const options = project.options as ResolvedSetup;
  if (!["typescript", "javascript"].includes(options.language))
    throw new Error("--language must be typescript or javascript.");
  if (!["esm", "commonjs"].includes(options.moduleFormat))
    throw new Error("--module-format must be esm or commonjs.");
  if (!["reuse", "create"].includes(options.userStorage))
    throw new Error("--user-storage must be reuse or create.");
  if (typeof options.models !== "boolean") throw new Error("--models must be a boolean.");
  if (!options.userIdType.trim() || /[;'"`\n\r]|--|\/\*/.test(options.userIdType))
    throw new Error(
      "--user-id-type must be a database type declaration, without SQL statements or quotes.",
    );
  for (const key of ["userIdCollation", "userIdCharset"] as const) {
    if (options[key] && !/^[a-zA-Z][\w]*$/.test(options[key]!))
      throw new Error(`Invalid ${key}; use a database identifier.`);
  }
  if (options.database === "mongodb" && !["string", "number"].includes(options.userIdType))
    throw new Error("MongoDB --user-id-type must be string or number.");
  if (options.database === "dynamodb" && !/^[\w.-]{3,255}$/.test(options.tableName))
    throw new Error(
      "DynamoDB --table-name must be 3–255 letters, numbers, underscores, hyphens, or dots.",
    );
  for (const key of ["config", "schema", "migrationsDir", "modelsDir"] as const) {
    const value = options[key];
    if (value) {
      if (
        (key === "migrationsDir" || key === "modelsDir") &&
        path.resolve(options.cwd, value) === options.cwd
      )
        options[key] = ".";
      else options[key] = relativePath(options.cwd, resolveOutput(options.cwd, value));
    }
  }
  return options;
}

function result(plan: ScopedSetupPlan, files: string[]): SetupResult {
  return {
    ...(plan.options.scope ? { scope: plan.options.scope } : {}),
    status: !files.length
      ? "unchanged"
      : plan.prerequisites.length
        ? "manual-steps-required"
        : "complete",
    files,
    warnings: plan.warnings,
    prerequisites: plan.prerequisites,
    nextSteps: plan.nextSteps,
  };
}

/** Coordinates project adaptors; it never connects to a database or runs migrations. */
export default class ProjectManager implements IProjectManager {
  constructor(private readonly generator: ISetupGenerator) {}

  detectProject(options: SetupOptions = {}): Promise<ProjectDetection> {
    return detectProject(options);
  }

  async planSetup(options: SetupOptions = {}): Promise<SetupPlan> {
    const project = await this.detectProject(options);
    const settings = resolved(project);
    const profilePrerequisites = validateProfile(settings, project.versions);
    const state = await readText(path.join(project.cwd, MANIFEST));
    const previous: SetupManifest | null = state ? JSON.parse(state) : null;
    if (
      previous?.extensions?.["analytics"] !== undefined &&
      previous.extensions["analytics"] !== ANALYTICS_VERSION
    )
      throw new Error("The analytics storage extension has an unsupported version.");
    const installed = previous?.extensions?.["analytics"] === ANALYTICS_VERSION;
    if (installed) settings.analytics = true;
    const installAnalytics = settings.analytics === true && !installed;
    const existingFiles: FileChange[] = [];
    if (state && previous) {
      if (![1, STORAGE_VERSION].includes(previous.schemaVersion) || !Array.isArray(previous.files))
        throw new Error(
          "The existing setup manifest belongs to an unsupported schema version. Upgrade through an explicit migration.",
        );
      if (!equivalent(settings, previous))
        throw new Error(
          "This project already has an xp setup with different options. Existing migrations will not be rewritten; make an explicit follow-up migration or use a fresh project.",
        );
      const files = existingFiles;
      const seen = new Set<string>();
      for (const entry of previous.files) {
        const target = await checkOutputPath(project.cwd, entry.path);
        const file = relativePath(project.cwd, target);
        if (seen.has(file) || file === MANIFEST || !/^[a-f0-9]{64}$/.test(entry.hash))
          throw new Error("Invalid generated-file entry in .xp/setup.json.");
        seen.add(file);
        const content = await readText(target);
        const currentHash = content === null ? null : fingerprint(content);
        if (
          content === null ||
          currentHash === null ||
          (currentHash !== entry.hash &&
            ((previous.schemaVersion !== 1 && !installAnalytics) ||
              !canUpgradeEditedFile(previous, entry, content)))
        )
          throw new Error(
            `Previously generated file changed or is missing: ${file}. Restore it before rerunning initial setup; xp will not overwrite your edits.`,
          );
        files.push({
          path: file,
          content,
          purpose: entry.purpose,
          before: content,
          beforeHash: currentHash,
          action: "unchanged",
        });
        if (project.inputs[file] !== undefined && project.inputs[file] !== currentHash)
          throw new Error(`Project changed during generation: ${file}. Run setup again.`);
        project.inputs[file] = currentHash;
      }
      if (previous.schemaVersion === STORAGE_VERSION && !installAnalytics) {
        files.push({
          path: MANIFEST,
          content: state,
          purpose: "Approved xp setup settings and generated-file fingerprints",
          action: "unchanged",
          before: state,
          beforeHash: fingerprint(state),
        });
        const prerequisites = [
          ...new Set([...pendingPrerequisites(previous, project), ...profilePrerequisites]),
        ];
        return {
          schemaVersion: STORAGE_VERSION,
          options: settings,
          files,
          inputs: project.inputs,
          prerequisites,
          warnings: [...new Set([...strings(previous.warnings), ...project.warnings])],
          nextSteps: strings(previous.nextSteps),
          status: prerequisites.length ? "manual-steps-required" : "ready",
        };
      }
    }
    const generated = !previous
      ? await this.generator.generate(settings, project)
      : previous.schemaVersion === 1 || settings.orm === "drizzle"
        ? await generateUpgrade(settings, project, existingFiles, previous.schemaVersion)
        : { files: [], warnings: [], prerequisites: [], nextSteps: strings(previous.nextSteps) };
    if (installAnalytics)
      await addAnalytics(settings, project, generated, previous ? existingFiles : undefined);
    const files: FileChange[] = [];
    const seen = new Set<string>();
    for (const entry of generated.files) {
      const target = await checkOutputPath(project.cwd, entry.path);
      const file = relativePath(project.cwd, target);
      if (file === MANIFEST || file.startsWith(".xp/.setup-") || seen.has(file))
        throw new Error(`Generator produced a reserved or duplicate file: ${file}`);
      seen.add(file);
      const before = await readText(target);
      if (before !== null && before !== entry.content) {
        if (!entry.merge || isMigration(file, settings.migrationsDir))
          throw new Error(
            `File conflict: ${file} already exists. xp will not overwrite files or historical migrations.`,
          );
      }
      const beforeHash = before === null ? null : fingerprint(before);
      const observed = project.inputs[file];
      if (observed !== undefined && observed !== beforeHash)
        throw new Error(`Project changed during generation: ${file}. Run setup again.`);
      project.inputs[file] = beforeHash;
      files.push({
        ...entry,
        path: file,
        action: before === entry.content ? "unchanged" : before === null ? "create" : "update",
        before,
        beforeHash,
      });
    }
    files.unshift(...existingFiles.filter((file) => !seen.has(file.path)));
    const prerequisites = [
      ...new Set([
        ...(previous ? pendingPrerequisites(previous, project) : []),
        ...profilePrerequisites,
        ...generated.prerequisites,
      ]),
    ];
    const warnings = [
      ...new Set([...(previous?.warnings ?? []), ...project.warnings, ...generated.warnings]),
    ];
    const manifest: SetupManifest = {
      schemaVersion: STORAGE_VERSION,
      ...(installAnalytics || previous?.extensions
        ? {
            extensions: {
              ...previous?.extensions,
              ...(installAnalytics ? { analytics: ANALYTICS_VERSION } : {}),
            },
          }
        : {}),
      options: storedOptions(settings),
      files: files.map((file) => ({
        path: file.path,
        hash: fingerprint(file.content),
        purpose: file.purpose,
      })),
      warnings,
      prerequisites,
      profilePrerequisites,
      nextSteps: generated.nextSteps,
    };
    files.push({
      path: MANIFEST,
      content: stringify(manifest),
      purpose: "Approved xp setup settings and generated-file fingerprints",
      action: previous ? "update" : "create",
      before: state,
      beforeHash: state === null ? null : fingerprint(state),
    });
    project.inputs[MANIFEST] = state === null ? null : fingerprint(state);
    return {
      schemaVersion: STORAGE_VERSION,
      options: settings,
      files,
      inputs: { ...project.inputs },
      warnings,
      prerequisites,
      nextSteps: generated.nextSteps,
      status: prerequisites.length ? "manual-steps-required" : "ready",
    };
  }

  detectScoped(options: ScopedSetupOptions, interactive = false) {
    return detectScoped(options, interactive);
  }

  async planScoped(options: ScopedSetupOptions): Promise<ScopedSetupPlan> {
    const scope = requestedScope(options);
    if (scope !== "both" && scope !== "frontend") {
      const storage = await this.planSetup(options);
      return options.scope
        ? { ...storage, options: { ...storage.options, scope: options.scope } }
        : storage;
    }
    const project = await this.detectScoped(options);
    const frontend = await frontendPlan(project);
    if (scope !== "both") return frontend;
    const storage = await this.planSetup({
      ...storedOptions(options),
      cwd: project.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const paths = new Set(storage.files.map((file) => file.path));
    for (const file of frontend.files)
      if (paths.has(file.path))
        throw new Error(`Conflicting frontend and storage outputs: ${file.path}`);
    const prerequisites = [...storage.prerequisites, ...frontend.prerequisites];
    for (const [path, hash] of Object.entries(frontend.inputs)) {
      if (Object.hasOwn(storage.inputs, path) && storage.inputs[path] !== hash)
        throw new Error(`Project changed during generation: ${path}.`);
    }
    return {
      ...frontend,
      options: { ...storage.options, ...frontend.options },
      files: [...storage.files, ...frontend.files],
      inputs: { ...storage.inputs, ...frontend.inputs },
      nextSteps: [...storage.nextSteps, ...frontend.nextSteps],
      warnings: [...storage.warnings, ...frontend.warnings],
      prerequisites,
      status: prerequisites.length ? "manual-steps-required" : "ready",
    };
  }

  applySetup(plan: SetupPlan): Promise<SetupResult> {
    return this.applyScoped(plan);
  }

  async applyScoped(plan: ScopedSetupPlan): Promise<SetupResult> {
    const root = plan.options.cwd;
    const changed = plan.files.filter((file) => file.action !== "unchanged");
    const verify = async (): Promise<void> => {
      for (const [file, expected] of Object.entries(plan.inputs)) {
        const content = await readText(path.resolve(root, file));
        if ((content === null ? null : fingerprint(content)) !== expected)
          throw new Error(`Project changed since preview: ${file}. Run setup again.`);
      }
      const paths = new Set<string>();
      for (const file of plan.files) {
        const target = await checkOutputPath(root, file.path);
        if (paths.has(target)) throw new Error(`Duplicate setup output: ${file.path}`);
        paths.add(target);
        const current = await readText(target);
        if ((current === null ? null : fingerprint(current)) !== file.beforeHash)
          throw new Error(`File changed since preview: ${file.path}. Run setup again.`);
        if (file.beforeHash !== (file.before === null ? null : fingerprint(file.before)))
          throw new Error(`Invalid before fingerprint for ${file.path}.`);
      }
    };
    await verify();
    if (!changed.length) return result(plan, []);
    await checkOutputPath(root, ".xp/.setup-lock");
    const createdDirectories: string[] = [];
    const ensureDirectory = async (directory: string): Promise<void> => {
      if (directory === root) return;
      try {
        const info = await stat(directory);
        if (!info.isDirectory()) throw new Error(`Not a directory: ${directory}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await ensureDirectory(path.dirname(directory));
        await mkdir(directory);
        createdDirectories.push(directory);
      }
    };
    await ensureDirectory(path.join(root, ".xp"));
    let lock;
    try {
      lock = await open(path.join(root, ".xp/.setup-lock"), "wx");
    } catch (error) {
      throw new Error(
        "Another xp setup is applying changes, or a previous run left .xp/.setup-lock. Resolve that run before retrying.",
        { cause: error },
      );
    }
    let stage: string | undefined;
    let keepRecoveryFiles = false;
    const applied: { file: FileChange; target: string; backup: string | undefined }[] = [];
    try {
      stage = await mkdtemp(path.join(root, ".xp/.setup-stage-"));
      for (const [index, file] of changed.entries()) {
        const handle = await open(path.join(stage, `${index}.new`), "wx");
        try {
          await handle.writeFile(file.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await verify();
      for (const [index, file] of changed.entries()) {
        const target = await checkOutputPath(root, file.path);
        await ensureDirectory(path.dirname(target));
        const current = await readText(target);
        if ((current === null ? null : fingerprint(current)) !== file.beforeHash)
          throw new Error(`File changed while applying setup: ${file.path}.`);
        let backup: string | undefined;
        if (current !== null) {
          backup = path.join(stage, `${index}.old`);
          await copyFile(target, backup, constants.COPYFILE_EXCL);
          // Preserve executable bits and other file mode choices on deliberate edits.
          const mode = (await stat(target)).mode;
          const handle = await open(path.join(stage, `${index}.new`), "r+");
          try {
            await handle.chmod(mode);
          } finally {
            await handle.close();
          }
          await rename(path.join(stage, `${index}.new`), target);
        } else {
          await copyFile(path.join(stage, `${index}.new`), target, constants.COPYFILE_EXCL);
        }
        applied.push({ file, target, backup });
      }
      return result(
        plan,
        changed.map((file) => file.path),
      );
    } catch (error) {
      const recoveryErrors: string[] = [];
      for (const entry of applied.reverse()) {
        try {
          const current = await readText(entry.target);
          if (current === null || fingerprint(current) !== fingerprint(entry.file.content)) {
            recoveryErrors.push(`${entry.file.path} changed concurrently; left untouched`);
          } else if (entry.backup) await rename(entry.backup, entry.target);
          else await rm(entry.target);
        } catch (recoveryError) {
          recoveryErrors.push(`${entry.file.path}: ${String(recoveryError)}`);
        }
      }
      if (recoveryErrors.length) {
        keepRecoveryFiles = true;
        throw new Error(
          `Setup failed; recovery needs attention: ${recoveryErrors.join("; ")}. Backups remain at ${stage}.`,
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      if (stage && !keepRecoveryFiles) await rm(stage, { recursive: true, force: true });
      await lock.close();
      await rm(path.join(root, ".xp/.setup-lock"), { force: true });
      for (const directory of createdDirectories.reverse()) {
        try {
          await rmdir(directory);
        } catch {
          // Directory cleanup is best-effort; never remove nonempty directories or hide the original failure.
        }
      }
    }
  }
}
