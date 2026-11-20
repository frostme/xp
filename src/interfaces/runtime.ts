export type UserIdentity = string | number | null | undefined;

export interface CohortDecision {
  slug: string | null;
}

export interface CohortRuntime {
  readonly driverKind: "postgres" | "mysql" | "mssql" | "mongodb" | "dynamodb" | "sequelize";
  readonly dialect?: "postgres" | "mysql" | "mssql";
  resolveCohort(userId: UserIdentity, experimentSlug: string): Promise<CohortDecision>;
}

export interface SeedReport {
  created: string[];
  skipped: string[];
}
