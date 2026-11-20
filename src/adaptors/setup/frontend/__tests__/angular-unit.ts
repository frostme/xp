import { describe, expect, it } from "vitest";

import { angular } from "../angular";

const main = `import { bootstrapApplication as start } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig as settings } from "./app/app.config";
start(App, settings).catch(report);
`;
const config = `import { type ApplicationConfig } from "@angular/core";
export const appConfig: ApplicationConfig = {
  providers: [existingOne(), /* keep provider order */ existingTwo(),],
};`;

const generate = (files: Record<string, string>) =>
  angular.generate({
    cwd: "/shop",
    frontend: "angular",
    transport: "graphql",
    endpoint: "/api/graphql",
    language: "typescript",
    versions: { "@angular/core": "22.3.0" },
    island: "none",
    read: async (p) => files[p] ?? null,
  });

describe("Angular setup", () => {
  it("resolves the bootstrap's config import, preserves providers and accepts host edits on rerun", async () => {
    const app = { "src/main.ts": main, "src/app/app.config.ts": config };
    const plan = await generate(app);
    const edit = plan.registrations[0]!;
    expect(edit.path).toBe("src/app/app.config.ts");
    expect(edit.content).toContain(
      "existingOne(), /* keep provider order */ existingTwo(), provideAppXp(),",
    );
    const edited = "/* Host-owned change */\n" + edit.content;
    expect((await generate({ ...app, [edit.path]: edited })).registrations[0]?.content).toBe(
      edited,
    );
    expect(plan.owned.find((f) => f.path.endsWith("providers.ts"))?.content).toContain(
      'endpoint: "/api/graphql"',
    );
  });

  it("patches a literal inline bootstrap, preserving the trailing comment", async () => {
    const inline = main.replace(
      "start(App, settings)",
      "start(App, { providers: [first() /* tail */] })",
    );
    const edit = (await generate({ "src/main.ts": inline })).registrations[0];
    expect(edit?.path).toBe("src/main.ts");
    expect(edit?.content).toContain("first(), provideAppXp() /* tail */");
  });

  it.each([
    [main.replace("start(App, settings)", "start(App, selectConfig())"), config],
    [main + "\nstart(App, settings);", config],
    [main, config.replace("existingTwo()", "provideXp()")],
    [main, config.replace("existingTwo()", "provideClientHydration()")],
  ])("provides a manual path when registration is ambiguous", async (entry, cfg) => {
    const plan = await generate({ "src/main.ts": entry, "src/app/app.config.ts": cfg });
    expect(plan.registrations).toEqual([]);
    expect(plan.owned).toHaveLength(2);
    expect(plan.manual.join(" ")).toContain("provideAppXp()");
  });
});
