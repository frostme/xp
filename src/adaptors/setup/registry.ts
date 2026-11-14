import type { ResolvedSetup, SetupDatabase, SetupOrm } from "~/interfaces/setup";

export const ORM_PACKAGES: Record<Exclude<SetupOrm, "none">, string> = {
  sequelize: "sequelize",
  typeorm: "typeorm",
  mikroorm: "@mikro-orm/core",
  prisma: "prisma",
  drizzle: "drizzle-orm",
  kysely: "kysely",
  knex: "knex",
  mongoose: "mongoose",
};

export const ORM_DATABASES: Record<SetupOrm, readonly SetupDatabase[]> = {
  sequelize: ["postgres", "mysql", "mssql"],
  typeorm: ["postgres", "mysql", "mssql", "mongodb"],
  mikroorm: ["postgres", "mysql", "mssql", "mongodb"],
  prisma: ["postgres", "mysql", "mssql", "mongodb"],
  drizzle: ["postgres", "mysql"],
  kysely: ["postgres", "mysql", "mssql"],
  knex: ["postgres", "mysql", "mssql"],
  mongoose: ["mongodb"],
  none: ["postgres", "mysql", "mssql", "mongodb", "dynamodb"],
};

export function defaultVersion(orm: SetupOrm, database: SetupDatabase): string | undefined {
  const versions: Record<Exclude<SetupOrm, "none">, string> = {
    sequelize: "6.37.8",
    typeorm: "1.1.3",
    mikroorm: "7.2.9",
    prisma: database === "mongodb" ? "6.19.3" : "7.10.1",
    drizzle: "0.45.4",
    kysely: "0.29.9",
    knex: "3.3.0",
    mongoose: "9.12.1",
  };
  return orm === "none" ? undefined : versions[orm];
}

function accepts(version: string, prefix: string): boolean {
  return /^\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(version) && version.startsWith(`${prefix}.`);
}

export function validateProfile(
  options: ResolvedSetup,
  versions: Record<string, string>,
): string[] {
  if (!ORM_DATABASES[options.orm].includes(options.database)) {
    throw new Error(
      `${options.orm} does not support ${options.database} in xp's stable setup profiles. Use --orm none for native output.`,
    );
  }
  if (options.orm === "none") return [];
  const packageName = ORM_PACKAGES[options.orm];
  const prefixes: Record<Exclude<SetupOrm, "none">, string> = {
    sequelize: "6",
    typeorm: "1",
    mikroorm: "7",
    prisma: options.database === "mongodb" ? "6.19" : "7",
    drizzle: "0.45",
    kysely: "0.29",
    knex: "3",
    mongoose: "9",
  };
  const candidates = [options.ormVersion, versions[packageName]].filter((value): value is string =>
    Boolean(value),
  );
  for (const version of candidates) {
    if (!accepts(version, prefixes[options.orm]))
      throw new Error(
        `Unsupported ${packageName} version ${version}; xp tests stable ${prefixes[options.orm]}.x. Use --orm none for native output.`,
      );
  }
  const prerequisites: string[] = [];
  if (!versions[packageName])
    prerequisites.push(
      `Install ${packageName}@${options.ormVersion ?? defaultVersion(options.orm, options.database)} in the application before using its generated files.`,
    );
  const companions: Record<string, string> =
    options.orm === "sequelize"
      ? { "sequelize-cli": "6" }
      : options.orm === "drizzle"
        ? { "drizzle-kit": "0.31" }
        : options.orm === "prisma"
          ? { "@prisma/client": prefixes[options.orm] }
          : {};
  for (const [name, prefix] of Object.entries(companions)) {
    const installed = versions[name];
    if (installed && !accepts(installed, prefix))
      throw new Error(
        `Unsupported ${name} version ${installed}; xp tests stable ${prefix}.x. Use --orm none for native output.`,
      );
    if (!installed)
      prerequisites.push(`Install compatible ${name}@${prefix} before using the generated files.`);
  }
  return prerequisites;
}
