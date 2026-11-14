import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SetupPlan } from "~/interfaces/setup";

import { FilePreview } from "../screens";
import { Box } from "../termcn/components/ui/box";
import { Code } from "../termcn/components/ui/code";
import { Confirm } from "../termcn/components/ui/confirm";
import { getCompletions, PathInput } from "../termcn/components/ui/path-input";
import { ScrollView } from "../termcn/components/ui/scroll-view";
import { Select } from "../termcn/components/ui/select";
import { FocusScope } from "../termcn/hooks/use-interaction";
import { cleanup, render } from "./terminal";

afterEach(cleanup);
const input = (app: Awaited<ReturnType<typeof render>>, value: string) => app.input(value);
const contains = async (app: Awaited<ReturnType<typeof render>>, text: string) =>
  vi.waitFor(() => expect(app.lastFrame()).toContain(text));

describe("TermCN integration", () => {
  it("uses the latest selection when navigation and submission arrive in one read", async () => {
    const submit = vi.fn();
    const app = await render(
      <FocusScope active>
        <Select
          options={[
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
            { value: "third", label: "Third" },
          ]}
          onSubmit={submit}
        />
      </FocusScope>,
    );
    await contains(app, "First");
    await input(app, "\u001b[B\u001b[B\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith("third");
  });

  it("confirms the latest selection when the arrow and Enter arrive together", async () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const app = await render(
      <FocusScope active>
        <Confirm message="Generate?" onConfirm={confirm} onCancel={cancel} />
      </FocusScope>,
    );
    await contains(app, "Generate?");
    await input(app, "\u001b[D\r");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("completes relative to cwd, excludes symlinks/escapes, and allows spaces and Unicode", async () => {
    const root = await mkdtemp(join(tmpdir(), "xp-paths-"));
    try {
      await mkdir(join(root, "db"));
      await mkdir(join(root, "db", "migrations"));
      await mkdir(join(root, "新 folder"));
      await mkdir(join(root, "node_modules"));
      await writeFile(join(root, "config.ts"), "");
      await symlink(join(root, "db"), join(root, "link"));
      const original = process.cwd();
      expect(getCompletions("db/mi", root, undefined, true)).toEqual(["db/migrations/"]);
      expect(getCompletions("新", root, undefined, true)).toEqual(["新 folder/"]);
      expect(getCompletions("", root, undefined, true)).toEqual(["db/", "新 folder/"]);
      expect(getCompletions("con", root)).toEqual(["config.ts"]);
      expect(getCompletions("../", root)).toEqual([]);
      expect(getCompletions("/tmp/", root)).toEqual([]);
      expect(getCompletions("link/", root)).toEqual([]);
      expect(getCompletions("link/mi", root)).toEqual([]);
      expect(process.cwd()).toBe(original);
      const submit = vi.fn();
      const app = await render(
        <FocusScope active>
          <PathInput cwd={root} dirsOnly onSubmit={submit} />
        </FocusScope>,
      );
      await input(app, "db/new folder/新");
      await input(app, "\r");
      expect(submit).toHaveBeenCalledWith("db/new folder/新");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets Tab change focus without appending a tab to a path", async () => {
    const submit = vi.fn();
    const selected = vi.fn();
    const app = await render(
      <FocusScope active initialFocusId="path">
        <Box flexDirection="column">
          <PathInput id="path" defaultValue="db/new" onSubmit={submit} />
          <Select id="next" options={[{ value: "next", label: "Next" }]} onSubmit={selected} />
        </Box>
      </FocusScope>,
    );
    await input(app, "\t");
    await input(app, "\r");
    expect(selected).toHaveBeenCalledWith("next");
    expect(submit).not.toHaveBeenCalled();
    await input(app, "\t");
    await input(app, "\r");
    expect(submit).toHaveBeenCalledWith("db/new");
  });

  it("inactive and disabled controls never consume input", async () => {
    const inactive = vi.fn();
    const disabled = vi.fn();
    const active = vi.fn();
    const options = [{ value: "item", label: "Item" }];
    const app = await render(
      <FocusScope active>
        <Box>
          <Select isActive={false} options={options} onSubmit={inactive} />
          <Select disabled options={options} onSubmit={disabled} />
          <Select options={options} onSubmit={active} />
        </Box>
      </FocusScope>,
    );
    await input(app, "\r");
    expect(active).toHaveBeenCalledTimes(1);
    expect(inactive).not.toHaveBeenCalled();
    expect(disabled).not.toHaveBeenCalled();
  });

  it("unfocused controls outside a scope do not consume input", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const options = [{ value: "item", label: "Item" }];
    const app = await render(
      <Box>
        <Select autoFocus options={options} onSubmit={first} />
        <Select options={options} onSubmit={second} />
      </Box>,
    );
    await input(app, "\r");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("measures wrapped content so its final line remains reachable after resizing", async () => {
    const content =
      Array.from({ length: 45 }, (_, i) => `line ${i}: ${"wide words ".repeat(8)}`).join("\n") +
      "\nFINAL LINE";
    const app = await render(
      <FocusScope active>
        <Box width="100%">
          <ScrollView height={8}>
            <Code>{content}</Code>
          </ScrollView>
        </Box>
      </FocusScope>,
      { columns: 50, rows: 20 },
    );
    await contains(app, "line 0:");
    expect(app.lastFrame()).not.toContain("FINAL LINE");
    await input(app, "\u001b[F");
    await contains(app, "FINAL LINE");
    await app.resize(32, 20);
    await input(app, "\u001b[F");
    await contains(app, "FINAL LINE");
    await input(app, "\u001b[H");
    await contains(app, "line 0:");
    expect(app.lastFrame()).not.toContain("FINAL LINE");
  });

  it("offers full before/after contents and switches to unchanged files", async () => {
    const file = {
      path: "first.ts",
      content: "after",
      before: "before",
      action: "update" as const,
      purpose: "test",
      beforeHash: "hash",
    };
    const plan = {
      files: [
        file,
        {
          ...file,
          path: "second.ts",
          content: "unchanged content",
          before: "unchanged content",
          action: "unchanged",
        },
      ],
    } as SetupPlan;
    const app = await render(
      <FocusScope active initialFocusId="preview-mode">
        <FilePreview plan={plan} height={20} />
      </FocusScope>,
    );
    await contains(app, "+after");
    await contains(app, "-before");
    await input(app, "\u001b[B");
    await input(app, "\r");
    await contains(app, "before");
    expect(app.lastFrame()).not.toContain("+after");
    await input(app, "\u001b[F");
    await input(app, "\r");
    await contains(app, "Choose a file");
    await input(app, "\u001b[B");
    await input(app, "\r");
    await contains(app, "2/2 second.ts");
    await contains(app, "unchanged content");
  });
});
