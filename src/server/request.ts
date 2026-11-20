import { normalizeIdentity } from "~/entities/identity";

export { validateExperimentSlug } from "~/use-cases/user/validateExperimentSlug";

export interface IdentityOptions<Host> {
  userId?: (host: Host) => unknown;
  header?: string;
}

export async function readIdentity<Host>(
  host: Host,
  options: IdentityOptions<Host>,
  readHeader: (name: string) => unknown,
  readDefault: () => unknown,
): Promise<string | number | null> {
  if (options.userId) return normalizeIdentity(await options.userId(host));
  if (options.header !== undefined) return normalizeIdentity(readHeader(options.header));
  return normalizeIdentity(readDefault());
}
