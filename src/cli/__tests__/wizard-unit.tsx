import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetection, SetupOptions, SetupPlan } from "~/interfaces/setup";

import CliFramework from "~/frameworks/cli";

import { parseArguments } from "../run";
import Wizard from "../wizard";
import { cleanup, render } from "./terminal";

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

const choose = async (app: ReturnType<typeof render>, index: number) => {
  await input(app, "\u001b[H");
  for (let i = 0; i < index; i++) await input(app, "\u001b[B");
  await input(app, "\r");
};
const editOutput = async (app: ReturnType<typeof render>) => {
  await choose(app, 1);
  await frameContains(app, "Edit settings");
  await choose(app, 1);
  await frameContains(app, "Output settings");
};

describe("setup wizard", () => {
  it("opens at review and applies once only after explicit confirmation", async () => {
    const f = fixture();
    const finish = vi.fn();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={finish} />);
    await frameContains(app, "Using sequelize");
    expect(f.applying).not.toHaveBeenCalled();
    await input(app, "\r");
    await frameContains(app, "Generate the reviewed files");
    expect(f.applying).not.toHaveBeenCalled();
    // Confirmation defaults to returning to review.
    await input(app, "\r");
    await frameContains(app, "Review actions");
    await input(app, "\r");
    await input(app, "\u001b[D");
    await input(app, "\r");
    await vi.waitFor(() => expect(f.applying).toHaveBeenCalledWith(plan));
    await frameContains(app, "Setup files generated.");
    await input(app, "\r");
    expect(f.applying).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("resolves missing settings through the native select then returns to its group", async () => {
    const f = fixture(true);
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "ORM / query tool");
    await choose(app, 6); // knex
    await frameContains(app, "Storage settings");
    expect(f.planning).toHaveBeenCalledWith(expect.objectContaining({ orm: "knex" }));
    await choose(app, 5); // continue
    await frameContains(app, "Using knex");
    expect(f.applying).not.toHaveBeenCalled();
  });

  it("edits models and a new directory without copying unrelated detected defaults", async () => {
    const f = fixture();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "Review actions");
    await editOutput(app);
    await choose(app, 1);
    await frameContains(app, "Enter to save");
    await choose(app, 1);
    await frameContains(app, "Output settings");
    expect(f.planning).toHaveBeenLastCalledWith(expect.objectContaining({ models: true }));
    await choose(app, 0);
    await frameContains(app, "Enter to save");
    for (let i = 0; i < "migrations".length; i++) await input(app, "\u007f");
    await input(app, "db/new migrations");
    await input(app, "\r");
    await frameContains(app, "Output settings");
    expect(f.planning).toHaveBeenLastCalledWith(
      expect.objectContaining({ models: true, migrationsDir: "db/new migrations" }),
    );
    expect(f.planning.mock.calls.at(-1)?.[0]).not.toHaveProperty("orm");
    await choose(app, 5);
    await frameContains(app, "Review actions");
  });

  it("keeps text input separate from wizard navigation and discards cancelled edits", async () => {
    const f = fixture();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "Review actions");
    await choose(app, 1); // groups
    await choose(app, 2); // identity
    await choose(app, 1); // ID type
    await frameContains(app, "Enter to save");
    await input(app, "\u001b[D");
    await input(app, "X");
    await input(app, "\u001b");
    await frameContains(app, "User identity settings");
    expect(f.planning).toHaveBeenCalledTimes(1);
    await input(app, "\t"); // navigation now owns arrows
    await input(app, "\u001b[D");
    await frameContains(app, "Output settings");
    expect(f.applying).not.toHaveBeenCalled();
  });

  it("invalidates the previous plan after a failed edit and supports retry", async () => {
    const f = fixture();
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "Review actions");
    await editOutput(app);
    await choose(app, 1);
    f.planning.mockRejectedValueOnce(new Error("plan failed"));
    await choose(app, 1);
    await frameContains(app, "plan failed");
    await choose(app, 1); // edit
    await input(app, "\u001b");
    await frameContains(app, "plan failed");
    expect(f.applying).not.toHaveBeenCalled();
    await choose(app, 0);
    await frameContains(app, "Review actions");
    expect(f.planning).toHaveBeenLastCalledWith(expect.objectContaining({ models: true }));
  });

  it("asks whether to create users before requiring their key type", async () => {
    const f = fixture();
    f.detect.mockImplementation(async (options: SetupOptions = {}) => ({
      ...project,
      options: { ...project.options, ...options },
      missing: options.userStorage === "create" ? [] : ["userIdType"],
    }));
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "User storage");
    await choose(app, 1);
    await frameContains(app, "User identity settings");
    expect(f.planning).toHaveBeenCalledWith(expect.objectContaining({ userStorage: "create" }));
    await choose(app, 5);
    await frameContains(app, "Review actions");
  });

  it("ignores input while planning and cancels even when a stale request later resolves", async () => {
    const f = fixture();
    const finish = vi.fn();
    let signal: AbortSignal | undefined;
    let complete!: (value: SetupPlan) => void;
    f.planning.mockImplementation(async (options: SetupOptions = {}) => {
      signal = options.signal;
      return new Promise<SetupPlan>((resolve) => {
        complete = resolve;
      });
    });
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={finish} />);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await input(app, "\r");
    await input(app, "y");
    expect(f.applying).not.toHaveBeenCalled();
    await input(app, "\u0003");
    complete(plan);
    await input(app, "\r");
    expect(signal?.aborted).toBe(true);
    expect(finish).toHaveBeenCalledExactlyOnceWith(130);
    expect(app.lastFrame()).not.toContain("Review actions");
    expect(f.applying).not.toHaveBeenCalled();
  });

  it("previews files, returns on Escape, and never writes in a dry run", async () => {
    const f = fixture();
    const finish = vi.fn();
    const app = render(<Wizard framework={f.framework} options={{}} dryRun onFinish={finish} />);
    await frameContains(app, "Review actions");
    await choose(app, 2);
    await frameContains(app, "+exports.up");
    await choose(app, 1);
    await frameContains(app, "does not exist yet");
    await choose(app, 2);
    await frameContains(app, "exports.up");
    await input(app, "\u001b");
    await frameContains(app, "Finish dry run");
    await input(app, "\r");
    await input(app, "\u0003");
    expect(finish).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.applying).not.toHaveBeenCalled();
  });

  it("requires replanning after an apply error", async () => {
    const f = fixture();
    f.applying.mockRejectedValueOnce(new Error("inputs changed"));
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={vi.fn()} />);
    await frameContains(app, "Review actions");
    await input(app, "\r");
    await input(app, "y");
    await frameContains(app, "inputs changed");
    await input(app, "\r");
    await frameContains(app, "Review actions");
    expect(f.planning).toHaveBeenCalledTimes(2);
    expect(f.applying).toHaveBeenCalledTimes(1);
  });

  it("keeps applying non-cancellable and prevents duplicate writes", async () => {
    const f = fixture();
    const finish = vi.fn();
    let complete!: (value: Awaited<ReturnType<typeof f.applying>>) => void;
    f.applying.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const app = render(<Wizard framework={f.framework} options={{}} onFinish={finish} />);
    await frameContains(app, "Review actions");
    await input(app, "\r");
    await input(app, "y");
    await frameContains(app, "Writing approved files");
    await input(app, "\u0003");
    await input(app, "\r");
    expect(finish).not.toHaveBeenCalled();
    expect(f.applying).toHaveBeenCalledTimes(1);
    complete({ status: "complete", files: [], warnings: [], prerequisites: [], nextSteps: [] });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledExactlyOnceWith(0));
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
