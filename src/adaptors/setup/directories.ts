import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Directory browsing is an outer integration; it never creates folders. */
export async function listDirectories(cwd: string, directory: string): Promise<string[]> {
  const root = await realpath(cwd);
  const target = await realpath(resolve(root, directory));
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Choose a directory within the selected project.");
  }
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    )
    .map((entry) => relative(root, resolve(target, entry.name)))
    .sort();
}
