import path from "node:path";
import process from "node:process";
import { satisfies } from "semver";

import type {
  FileChange,
  ScopedDetection,
  ScopedSetupOptions,
  ScopedSetupPlan,
  SetupFrontend,
} from "~/interfaces/setup";

import { detectProject, installedVersions, storedOptions } from "../discovery";
import { checkOutputPath, fingerprint, projectRoot, readText, relativePath } from "../filesystem";
import { ORM_PACKAGES } from "../registry";
import { profiles } from "./registry";

const manifestPath = ".xp/frontend.json";
interface Manifest {
  version: 1;
  options: Pick<ScopedSetupOptions, "frontend" | "transport" | "endpoint" | "island">;
  files: { path: string; hash: string }[];
  registrations: { path: string; kind: string }[];
  manual: string[];
}

function manifest(content: string | null): Manifest | null {
  if (content === null) return null;
  const data = JSON.parse(content);
  if (
    data?.version !== 1 ||
    !data.options ||
    !Array.isArray(data.files) ||
    !Array.isArray(data.registrations)
  )
    throw new Error("Unsupported .xp/frontend.json. Review the existing frontend registration.");
  return data;
}

export function requestedScope(options: ScopedSetupOptions) {
  const frontend = [options.frontend, options.transport, options.endpoint, options.island].some(
    (v) => v !== undefined,
  );
  const storage = Object.keys(storedOptions(options)).some(
    (key) => !["language", "moduleFormat"].includes(key),
  );
  const scope = options.scope ?? (frontend ? "frontend" : undefined);
  if ((scope === "storage" && frontend) || (scope === "frontend" && storage))
    throw new Error("Mixing storage and frontend flags requires --scope both.");
  return scope ?? (storage ? "storage" : undefined);
}

function publicEndpoint(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    /[\\\s]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32) ||
    (!/^https?:\/\//i.test(value) && !/^\/(?!\/)/.test(value))
  )
    throw new Error("Provide a public HTTP(S) endpoint or root-relative path.");
  const url = new URL(value, "http://localhost");
  if (url.username || url.password || /[?#]/.test(value))
    throw new Error(
      "Use a public endpoint without credentials, query or fragment. Supply credentials with a custom authenticated loader.",
    );
  return value;
}

export async function detectScoped(
  explicit: ScopedSetupOptions,
  interactive = false,
): Promise<ScopedDetection> {
  explicit.signal?.throwIfAborted();
  const scope = requestedScope(explicit);
  if (scope === "storage" || (!scope && !interactive)) {
    const project = await detectProject(explicit);
    return interactive
      ? { ...project, options: { ...project.options, scope: "storage" } }
      : project;
  }
  const cwd = await projectRoot(explicit.cwd ?? process.cwd(), explicit.cwd !== undefined);
  const inputs: Record<string, string | null> = {};
  async function inspect(file: string) {
    const content = await readText(path.resolve(cwd, file));
    inputs[relativePath(cwd, file)] = content === null ? null : fingerprint(content);
    return content;
  }
  const app = JSON.parse((await inspect("package.json")) ?? "{}");
  const dependencies = {
    ...app.dependencies,
    ...app.devDependencies,
    ...app.peerDependencies,
    ...app.optionalDependencies,
  };
  const saved = manifest(await inspect(await checkOutputPath(cwd, manifestPath)));
  const matches = profiles.filter((p) =>
    Object.keys(p.packages).every((name) => Object.hasOwn(dependencies, name)),
  );
  const candidates = matches
    .filter((p) => !matches.some((other) => other.supersedes?.includes(p.id)))
    .map((p) => p.id);
  if (!candidates.length && app.workspaces)
    throw new Error(
      "Select an application package with --cwd so setup can resolve its declared framework and entry point.",
    );
  const hasStorage =
    [
      ...Object.values(ORM_PACKAGES),
      "pg",
      "mysql2",
      "tedious",
      "mssql",
      "mongodb",
      "@aws-sdk/lib-dynamodb",
    ].some((k) => Object.hasOwn(dependencies, k)) ||
    (await readText(path.join(cwd, ".xp/setup.json"))) !== null;
  const selected =
    scope ??
    (candidates.length || saved
      ? hasStorage
        ? "both"
        : "frontend"
      : hasStorage
        ? "storage"
        : undefined);
  const storage =
    selected === "both" || selected === "storage"
      ? await detectProject({
          cwd,
          ...storedOptions(explicit),
          ...(explicit.signal ? { signal: explicit.signal } : {}),
        })
      : undefined;
  if (selected === "storage" && storage)
    return {
      ...storage,
      options: { ...storage.options, scope: "storage" },
      frontendCandidates: candidates,
    };
  const frontend =
    explicit.frontend ??
    saved?.options.frontend ??
    (candidates.length === 1 ? (candidates[0] as SetupFrontend) : undefined);
  const transport = explicit.transport ?? saved?.options.transport ?? "rest";
  if (!["rest", "graphql"].includes(transport))
    throw new Error("Choose --transport rest or graphql.");
  const endpoint = publicEndpoint(
    explicit.endpoint ??
      (transport === saved?.options.transport ? saved.options.endpoint : undefined) ??
      (transport === "rest" ? "/xp" : "/graphql"),
  );
  const versions = await installedVersions(
    cwd,
    dependencies,
    [
      ...new Set(
        profiles.flatMap((p) => [...Object.keys(p.packages), ...(p.optionalPackages ?? [])]),
      ),
    ],
    inspect,
  );
  const options: ScopedSetupOptions = {
    ...storage?.options,
    ...explicit,
    cwd,
    ...(selected ? { scope: selected } : {}),
    ...(frontend ? { frontend } : {}),
    transport,
    endpoint,
    language:
      explicit.language ??
      storage?.options.language ??
      ((await inspect("tsconfig.json")) === null ? "javascript" : "typescript"),
  };
  const missing: ScopedDetection["missing"] = selected
    ? [...(storage?.missing ?? []), ...(frontend ? [] : ["frontend" as const])]
    : ["scope"];
  return {
    cwd,
    options,
    missing,
    versions: { ...storage?.versions, ...versions },
    inputs: { ...storage?.inputs, ...inputs },
    frontendCandidates: candidates,
    ormCandidates: storage?.ormCandidates ?? [],
    databaseCandidates: storage?.databaseCandidates ?? [],
    packageManager: storage?.packageManager ?? "npm",
    sources: storage?.sources ?? ["package.json"],
    warnings: storage?.warnings ?? [],
  };
}

export async function frontendPlan(project: ScopedDetection): Promise<ScopedSetupPlan> {
  const { cwd, versions, inputs, options } = project;
  const profile = profiles.find((p) => p.id === options.frontend);
  if (!profile)
    throw new Error(
      `Select --frontend from ${profiles.map((p) => p.id).join(", ")}. Detected: ${project.frontendCandidates?.join(", ") || "none"}.`,
    );
  for (const [name, range] of Object.entries(profile.packages)) {
    if (!versions[name] || !satisfies(versions[name]!, range))
      throw new Error(
        `Install and declare ${name}@${range} in this application before generating ${profile.id} wiring (found ${versions[name] ?? "no installed target"}).`,
      );
  }
  async function read(file: string) {
    options.signal?.throwIfAborted();
    const content = await readText(await checkOutputPath(cwd, file));
    const hash = content === null ? null : fingerprint(content);
    if (Object.hasOwn(inputs, file) && inputs[file] !== hash)
      throw new Error(`Project changed during generation: ${file}.`);
    inputs[file] = hash;
    return content;
  }
  const previous = manifest(await read(manifestPath));
  if (previous && previous.options.frontend !== options.frontend)
    throw new Error(
      "Remove the prior frontend registration manually before switching frontend profiles.",
    );
  const settings = {
    frontend: options.frontend!,
    transport: options.transport!,
    endpoint: options.endpoint!,
    island: options.island ?? ("none" as const),
  };
  const output = await profile.generate({
    cwd,
    versions,
    read,
    language: options.language!,
    ...settings,
  });
  const files: FileChange[] = [];
  const owned: Manifest["files"] = [];
  const seen = new Set<string>();
  async function change(
    file: string,
    content: string,
    purpose: string,
    host: boolean,
    internal = false,
  ) {
    if (seen.has(file) || (!internal && file.startsWith(".xp/")))
      throw new Error(`Reserved or duplicate frontend output: ${file}`);
    seen.add(file);
    const before = await read(file);
    const beforeHash = before === null ? null : fingerprint(before);
    const expected = fingerprint(content);
    if (!host && !internal) {
      const prior = previous?.files.find((item) => item.path === file);
      if (before !== null && before !== content && prior?.hash !== beforeHash) {
        if (!prior || prior.hash !== expected)
          throw new Error(
            `File conflict: ${file} contains host edits. Review the new options before replacing it.`,
          );
        content = before;
      }
      owned.push({ path: file, hash: expected });
    }
    files.push({
      path: file,
      ...(host ? { merge: true } : {}),
      content,
      purpose,
      before,
      beforeHash,
      action: before === content ? "unchanged" : before === null ? "create" : "update",
    });
  }
  for (const file of output.owned) await change(file.path, file.content, file.purpose, false);
  for (const edit of output.registrations) await change(edit.path, edit.content, edit.kind, true);
  const state: Manifest = {
    version: 1,
    options: settings,
    files: owned,
    registrations: output.registrations.map(({ path, kind }) => ({ path, kind })),
    manual: output.manual,
  };
  for (const prior of previous?.files ?? [])
    if (!seen.has(prior.path))
      throw new Error(
        `Resolve previous generated file ${prior.path} manually before changing frontend configuration.`,
      );
  await change(
    manifestPath,
    JSON.stringify(state, null, 2) + "\n",
    "Frontend settings, generated files and host registration",
    false,
    true,
  );
  return {
    schemaVersion: 1,
    options: { ...options, cwd },
    files,
    inputs,
    warnings: project.frontendCandidates?.length
      ? [`Detected frontend profiles: ${project.frontendCandidates.join(", ")}.`]
      : [],
    prerequisites: output.manual,
    nextSteps: output.nextSteps ?? [],
    status: output.manual.length ? "manual-steps-required" : "ready",
  };
}
