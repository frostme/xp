import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import type { ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

export const runFile = promisify(execFile);
export const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function projectPath(options: ResolvedSetup, file: string): string {
  const absolute = path.resolve(options.cwd, file);
  const relative = path.relative(options.cwd, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Setup path must be inside the selected project: ${file}`);
  }
  return absolute;
}

export async function readInput(
  options: ResolvedSetup,
  project: ProjectDetection,
  file: string,
): Promise<string | null> {
  const absolute = projectPath(options, file);
  try {
    const actual = await realpath(absolute);
    const actualRoot = await realpath(options.cwd);
    const relative = path.relative(actualRoot, actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Setup input escapes the selected project: ${file}`);
    const content = await readFile(absolute, "utf8");
    project.inputs[path.relative(options.cwd, absolute)] = fingerprint(content);
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    project.inputs[path.relative(options.cwd, absolute)] = null;
    return null;
  }
}

export async function localPackage(
  options: ResolvedSetup,
  project: ProjectDetection,
  name: string,
): Promise<{ directory: string; version: string; bin: string } | null> {
  const require = createRequire(path.join(options.cwd, "package.json"));
  let resolved: string;
  try {
    resolved = require.resolve(`${name}/package.json`);
  } catch {
    try {
      resolved = require.resolve(name);
    } catch {
      return null;
    }
  }
  let directory = path.dirname(resolved);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    try {
      const content = await readFile(manifest, "utf8");
      const json = JSON.parse(content) as {
        name?: string;
        version?: string;
        bin?: string | Record<string, string>;
      };
      if (json.name === name && json.version) {
        project.inputs[path.relative(options.cwd, manifest)] = fingerprint(content);
        const entry =
          typeof json.bin === "string"
            ? json.bin
            : (json.bin?.[name] ?? Object.values(json.bin ?? {})[0]);
        return { directory, version: json.version, bin: path.join(directory, entry ?? "") };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  return null;
}

export function command(project: ProjectDetection, executable: string, args: string): string {
  const prefix =
    project.packageManager === "npm"
      ? "npm exec --"
      : project.packageManager === "bun"
        ? "bun run"
        : project.packageManager === "pnpm"
          ? "pnpm exec"
          : "yarn";
  return `${prefix} ${executable} ${args}`;
}

export async function runLocal(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<string> {
  const { stdout, stderr } = await runFile(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, ...env, CI: "1", NO_COLOR: "1", DO_NOT_TRACK: "1" },
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  return stdout + stderr;
}

/** Masks comments without moving source offsets, retaining quoted values. */
export function maskComments(source: string): string {
  return source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) =>
      match.startsWith("//") || match.startsWith("/*") ? match.replace(/[^\n]/g, " ") : match,
  );
}

export interface SchemaBlock {
  kind: string;
  name: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}
export function prismaBlocks(source: string): SchemaBlock[] {
  const masked = maskComments(source);
  const pattern = /\b(model|datasource|generator|enum|type)\s+([A-Za-z_]\w*)\s*\{/g;
  const blocks: SchemaBlock[] = [];
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    const bodyStart = pattern.lastIndex;
    let cursor = bodyStart;
    let quote = false;
    let depth = 1;
    for (; cursor < masked.length; cursor++) {
      const char = masked[cursor];
      if (char === "\\" && quote) {
        cursor++;
        continue;
      }
      if (char === '"') quote = !quote;
      if (quote) continue;
      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (cursor >= masked.length) throw new Error("Prisma schema contains an unclosed block.");
    blocks.push({
      kind: match[1]!,
      name: match[2]!,
      start: match.index,
      end: cursor + 1,
      bodyStart,
      bodyEnd: cursor,
      body: source.slice(bodyStart, cursor),
    });
    pattern.lastIndex = cursor + 1;
  }
  return blocks;
}
