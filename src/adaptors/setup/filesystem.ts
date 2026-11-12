import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function relativePath(root: string, file: string): string {
  return path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
}

export function resolveOutput(root: string, file: string): string {
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Setup path must stay inside ${root}: ${file}. Select a workspace root with --cwd for shared files.`,
    );
  }
  return target;
}

/** Output symlinks are deliberately unsupported, including symlinked parent directories. */
export async function checkOutputPath(root: string, file: string): Promise<string> {
  const target = resolveOutput(root, file);
  const parts = path.relative(root, target).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`Setup will not write through a symlink: ${current}`);
      if (index < parts.length - 1 && !info.isDirectory())
        throw new Error(`Setup parent is not a directory: ${current}`);
      if (index === parts.length - 1 && !info.isFile())
        throw new Error(`Setup output is not a file: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export async function projectRoot(cwd: string, explicit: boolean): Promise<string> {
  const initial = await realpath(path.resolve(cwd));
  if (explicit) return initial;
  let current = initial;
  while (true) {
    if (await readText(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

export async function sourceFiles(root: string, directory: string, depth = 3): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(path.resolve(root, directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      entry.isSymbolicLink() ||
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "build"].includes(entry.name)
    )
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(root, file, depth - 1)));
    else if (/\.(?:[cm]?[jt]s|prisma|json)$/.test(entry.name)) files.push(relativePath(root, file));
    if (files.length > 500) return files.slice(0, 500);
  }
  return files;
}
