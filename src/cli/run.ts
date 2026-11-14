import meow from "meow";
import process from "node:process";

import { DATABASES, ORMS, type SetupOptions } from "~/interfaces/setup";

import cli from "./index";
import { describePlan, describeResult, previewFile } from "./presentation";

const help = `
  Usage
    xp setup [options]

  Examples
    bun run xp setup
    pnpm exec xp setup --orm sequelize --database postgres
    xp setup --orm none --database postgres --user-storage create --yes
    xp setup --orm knex --database mysql --user-id-type 'VARCHAR(191)' --dry-run

  Options
    --cwd <path>               Project directory (defaults to current directory)
    --orm <tool>               sequelize, typeorm, mikroorm, prisma, drizzle,
                               kysely, knex, mongoose, none
    --orm-version <version>    Output compatibility profile when not installed
    --database <provider>      postgres, mysql, mssql, mongodb, dynamodb
    --config <path>            ORM configuration file
    --schema <path>            Schema file or directory
    --migrations-dir <path>    Migration / provisioning output directory
    --models / --no-models     Optional supporting models or types (default off)
    --models-dir <path>        Supporting models / types output directory
    --language <language>      typescript or javascript
    --module-format <format>   esm or commonjs
    --user-storage <mode>      reuse or create (default reuse)
    --user-id-type <type>      Exact SQL users.id type, or Mongo string/number
    --user-id-collation <name> Existing user key collation
    --user-id-charset <name>   Existing MySQL user key character set
    --table-name <name>        DynamoDB table name
    --yes                     Accept the resolved file plan without prompting
    --non-interactive         Never open the wizard; requires --yes or --dry-run
    --dry-run                 Preview only; leave the project unchanged
    --help                    Show this help
    --version                 Show version

  Setup writes files only. It never installs packages or applies migrations.
`;

export function parseArguments(argv: string[]) {
  const parsed = meow(help, {
    importMeta: import.meta,
    argv,
    booleanDefault: undefined,
    allowUnknownFlags: false,
    flags: {
      cwd: { type: "string" },
      orm: { type: "string" },
      database: { type: "string" },
      ormVersion: { type: "string" },
      config: { type: "string" },
      schema: { type: "string" },
      migrationsDir: { type: "string" },
      models: { type: "boolean" },
      modelsDir: { type: "string" },
      language: { type: "string" },
      moduleFormat: { type: "string" },
      userStorage: { type: "string" },
      userIdType: { type: "string" },
      userIdCollation: { type: "string" },
      userIdCharset: { type: "string" },
      tableName: { type: "string" },
      yes: { type: "boolean", shortFlag: "y" },
      nonInteractive: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
  });
  if (parsed.input.length === 0) parsed.showHelp(0);
  if (parsed.input.length !== 1 || parsed.input[0] !== "setup")
    throw new Error("Unknown command. Use xp setup, or xp --help.");
  const { yes, nonInteractive, dryRun, ...values } = parsed.flags;
  const checks = {
    orm: ORMS,
    database: DATABASES,
    language: ["typescript", "javascript"],
    moduleFormat: ["esm", "commonjs"],
    userStorage: ["reuse", "create"],
  };
  for (const [key, allowed] of Object.entries(checks)) {
    const value = values[key as keyof typeof values];
    if (value !== undefined && !(allowed as readonly unknown[]).includes(value))
      throw new Error(`Invalid --${key}: ${String(value)}. Choose ${allowed.join(", ")}.`);
  }
  const options = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as SetupOptions;
  return {
    options,
    yes: Boolean(yes),
    nonInteractive: Boolean(nonInteractive),
    dryRun: Boolean(dryRun),
  };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    const framework = cli();
    if (!args.yes && !args.nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
      const [{ render }, { createElement }, { default: Wizard }] = await Promise.all([
        import("ink"),
        import("react"),
        import("./wizard"),
      ]);
      let finish: (code: number) => void = () => {};
      const completed = new Promise<number>((resolve) => {
        finish = resolve;
      });
      const app = render(
        createElement(Wizard, {
          framework,
          options: args.options,
          dryRun: args.dryRun,
          onFinish: finish,
        }),
        { exitOnCtrlC: false },
      );
      try {
        return await completed;
      } finally {
        app.unmount();
      }
    }
    const project = await framework.detectProject(args.options);
    if (project.missing.length > 0)
      throw new Error(
        `Missing setup choices: ${project.missing.join(", ")}. Supply the corresponding flags or run xp setup in an interactive terminal.`,
      );
    const plan = await framework.planSetup(args.options);
    process.stdout.write(`${describePlan(plan)}\n`);
    if (args.dryRun) {
      for (let i = 0; i < plan.files.length; i++)
        process.stdout.write(`\n--- ${plan.files[i]!.path}\n${previewFile(plan, i).join("\n")}\n`);
      process.stdout.write("\nDry run: no project files changed.\n");
      return 0;
    }
    if (!args.yes)
      throw new Error(
        "A noninteractive write requires --yes. Use --dry-run to preview the files first.",
      );
    const result = await framework.applySetup(plan);
    process.stdout.write(`\n${describeResult(result)}\n`);
    return 0;
  } catch (reason) {
    process.stderr.write(`xp: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    return 1;
  }
}
