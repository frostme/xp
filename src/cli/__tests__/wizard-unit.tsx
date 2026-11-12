import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetection, SetupOptions, SetupPlan } from "~/interfaces/setup";

import CliFramework from "~/frameworks/cli";

import { parseArguments } from "../run";
import Wizard from "../wizard";
import { cleanup, render } from "./terminal";

vi.mock("~/adaptors/setup/directories", () => ({
  listDirectories: async () => ["migrations", "src"],
}));
afterEach(cleanup);

const plan: SetupPlan = {
  schemaVersion: 1,
  options: {
    cwd: "/project",
    orm: "sequelize",
    database: "postgres",
    migrationsDir: "migrations",
    models: false,
    modelsDir: "models",
    language: "typescript",
    moduleFormat: "esm",
    userStorage: "reuse",
    userIdType: "uuid",
    tableName: "xp",
  },
  files: [
    {
      path: "migrations/xp.cjs",
      content: "exports.up = async () => {};",
      purpose: "xp schema",
      action: "create",
      before: null,
      beforeHash: null,
    },
  ],
  inputs: {},
  warnings: [],
  prerequisites: [],
  nextSteps: ["Run your migration command."],
  status: "ready",
};
const project: ProjectDetection = {
  cwd: "/project",
  options: plan.options,
  ormCandidates: ["sequelize"],
  databaseCandidates: ["postgres"],
  versions: {},
  packageManager: "bun",
  sources: [],
  warnings: [],
  missing: [],
  inputs: {},
};

function fixture(missing = false) {
  const detect = vi.fn(async (options: SetupOptions = {}) => ({
    ...project,
    options: { ...project.options, ...options },
    missing: missing && !options.orm ? ["orm" as const] : [],
  }));
  const planning = vi.fn(async (options: SetupOptions = {}) => {
    const { signal: _signal, ...persisted } = options;
    return { ...plan, options: { ...plan.options, ...persisted } };
  });
  const applying = vi.fn(async () => ({
    status: "complete" as const,
    files: ["migrations/xp.cjs"],
    warnings: [],
    prerequisites: [],
    nextSteps: ["Run your migration command."],
  }));
  return {
    framework: new CliFramework({ call: detect }, { call: planning }, { call: applying }),
    detect,
    planning,
    applying,
  };
}
const frameContains = async (app: ReturnType<typeof render>, text: string) =>
  vi.waitFor(() => expect(app.lastFrame()).toContain(text));
const input = async (app: ReturnType<typeof render>, value: string) => {
  app.stdin.write(value);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

describe("setup wizard", () => {
  it("goes directly to confirmation for a detected project and writes only on confirmation", async () => {
    const f = fixture();
    const finish = vi.fn();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={finish} />);
    await frameContains(app, "Using sequelize");
    expect(f.applying).not.toHaveBeenCalled();
    await input(app, "\r");
    await vi.waitFor(() => expect(f.applying).toHaveBeenCalledWith(plan));
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(0));
    await frameContains(app, "Setup files generated.");
  });

  it("filters tools and resolves only a missing choice", async () => {
    const f = fixture(true);
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "ORM / query tool");
    await input(app, "knex");
    await input(app, "\r");
    await frameContains(app, "Using knex");
    expect(f.planning).toHaveBeenCalledWith(expect.objectContaining({ orm: "knex" }));
  });

  it("supports reviewed model selection and manual directory entry", async () => {
    const f = fixture();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "Using sequelize");
    await input(app, "e");
    await input(app, "supporting");
    await input(app, "\r");
    await frameContains(app, "Generate supporting models");
    await input(app, "\u001b[B");
    await input(app, "\r");
    await vi.waitFor(() =>
      expect(f.planning).toHaveBeenLastCalledWith(expect.objectContaining({ models: true })),
    );
    await frameContains(app, "Using sequelize");
    await input(app, "e");
    await input(app, "Migrations");
    await input(app, "\r");
    await frameContains(app, "Browsing .");
    await input(app, "\t");
    await frameContains(app, "new or existing path");
    for (let i = 0; i < "migrations".length; i++) await input(app, "\u007f");
    await input(app, "db/migrations");
    await input(app, "\r");
    await vi.waitFor(() =>
      expect(f.planning).toHaveBeenLastCalledWith(
        expect.objectContaining({ models: true, migrationsDir: "db/migrations" }),
      ),
    );
  });

  it("lets a fresh application choose to scaffold users before asking for their type", async () => {
    const f = fixture();
    f.detect.mockImplementation(async (options: SetupOptions = {}) => ({
      ...project,
      options: { ...project.options, ...options },
      missing: options.userStorage === "create" ? [] : ["userIdType"],
    }));
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "User storage");
    await input(app, "create");
    await input(app, "\r");
    await frameContains(app, "Using sequelize");
    expect(f.planning).toHaveBeenCalledWith(expect.objectContaining({ userStorage: "create" }));
  });

  it("cancels pending generation without applying files", async () => {
    const f = fixture();
    const finish = vi.fn();
    let signal: AbortSignal | undefined;
    f.planning.mockImplementation(async (options: SetupOptions = {}) => {
      signal = options.signal;
      return new Promise<SetupPlan>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={finish} />);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await input(app, "\u0003");
    expect(signal?.aborted).toBe(true);
    expect(finish).toHaveBeenCalledWith(130);
    expect(f.applying).not.toHaveBeenCalled();
  });

  it("previews content, cancels, and never applies during dry run", async () => {
    const f = fixture();
    const finish = vi.fn();
    const app = render(<Wizard framework={f.framework} options={{}} dryRun onFinish={finish} />);
    await frameContains(app, "Using sequelize");
    await input(app, "p");
    await frameContains(app, "+ exports.up");
    await input(app, "\u001b");
    await frameContains(app, "finish dry run");
    await input(app, "\r");
    expect(finish).toHaveBeenCalledWith(0);
    expect(f.applying).not.toHaveBeenCalled();
    await input(app, "q");
    expect(finish).toHaveBeenCalledWith(130);
  });
});

describe("arguments", () => {
  it("preserves unspecified values and accepts explicit false", () => {
    expect(parseArguments(["setup"]).options).toEqual({});
    expect(
      parseArguments([
        "setup",
        "--no-models",
        "--database",
        "postgres",
        "--user-id-type",
        "uuid",
        "--yes",
      ]),
    ).toEqual({
      options: { models: false, database: "postgres", userIdType: "uuid" },
      yes: true,
      nonInteractive: false,
      dryRun: false,
    });
  });
  it("rejects unsupported commands and values", () => {
    expect(() => parseArguments(["delete"])).toThrow("Unknown command");
    expect(() => parseArguments(["setup", "--database", "sqlite"])).toThrow("Invalid --database");
  });
});
