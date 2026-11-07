import { createRequire } from "node:module";

const requireDriver = createRequire(import.meta.url);
const drivers = new Map<string, unknown>();

export function loadDriver<T>(name: string): T {
  if (!drivers.has(name)) drivers.set(name, requireDriver(name));
  return drivers.get(name) as T;
}

export function optionalDriver<T>(name: string): T | undefined {
  try {
    // Resolve separately: a broken installed driver's dependency must not be swallowed.
    requireDriver.resolve(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
  return loadDriver<T>(name);
}
