import type { SetupPlan, SetupResult } from "~/interfaces/setup";

export function describePlan(plan: SetupPlan): string {
  const o = plan.options;
  return [
    `Using ${o.orm}${o.ormVersion ? ` ${o.ormVersion}` : ""} with ${o.database}`,
    `Project: ${o.cwd}`,
    `Migrations: ${o.migrationsDir}`,
    ...(o.schema ? [`Schema: ${o.schema}`] : []),
    `Models: ${o.models ? o.modelsDir : "not requested"}`,
    `Language: ${o.language}; modules: ${o.moduleFormat}`,
    `Users: ${o.userStorage} users.id (${o.userIdType}${o.userIdCollation ? `, ${o.userIdCollation}` : ""})`,
    ...(o.database === "dynamodb" ? [`Table: ${o.tableName}`] : []),
    "",
    ...plan.files.map((file) => `${file.action.padEnd(9)} ${file.path} — ${file.purpose}`),
    ...plan.warnings.map((value) => `Note: ${value}`),
    ...plan.prerequisites.map((value) => `Manual step: ${value}`),
  ].join("\n");
}

export function describeResult(result: SetupResult): string {
  return [
    result.status === "unchanged"
      ? "Setup is already generated; no files changed."
      : result.status === "manual-steps-required"
        ? "Files generated. Manual integration is still required."
        : "Setup files generated.",
    ...result.files.map((path) => `  ${path}`),
    ...result.prerequisites.map((value) => `Manual step: ${value}`),
    ...result.warnings.map((value) => `Note: ${value}`),
    "",
    ...result.nextSteps,
    "xp/server continues to use a supported native database client. Apply the generated migration or provisioning files before using xp.",
  ].join("\n");
}

/** A compact complete before/after review, without hiding removed content. */
export function previewFile(plan: SetupPlan, index: number): string[] {
  const file = plan.files[index];
  if (!file) return [];
  if (file.action === "unchanged") return file.content.split("\n").map((line) => `  ${line}`);
  return [
    ...(file.before === null ? [] : file.before.split("\n").map((line) => `- ${line}`)),
    ...file.content.split("\n").map((line) => `+ ${line}`),
  ];
}
