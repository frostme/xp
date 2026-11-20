import process from "node:process";
import { describe, expect, it } from "vitest";

import type { FrontendContext } from "../frontend/types";

import { nuxt, vue } from "../frontend/vue";

describe("Vue setup profiles", () => {
  const context = (
    files: Record<string, string>,
    language: FrontendContext["language"] = "typescript",
  ): FrontendContext => ({
    cwd: process.cwd(),
    frontend: "vue",
    transport: "rest",
    endpoint: "/xp",
    island: "none",
    language,
    versions: { vue: "3.5.46" },
    read: async (p) => files[p] ?? null,
  });
  it.each([
    ["js", "javascript"],
    ["ts", "typescript"],
  ] as const)(
    "wraps only the resolved %s root and preserves later edits on rerun",
    async (extension, lang) => {
      const entry = "src/main." + extension;
      const original =
        '<template><section class="shop"><!-- keep --><RouterView /></section></template>\n';
      const files = {
        [entry]:
          'import Root from "./pages/Shop.vue"; import {createApp as create} from "vue"; create(Root).mount("#app");',
        "src/pages/Shop.vue": original,
      };
      const dist = await vue.generate(context(files, lang));
      expect(dist.manual).toEqual([]);
      const wrapped = dist.registrations[0]!;
      expect(wrapped.path).toBe("src/pages/Shop.vue");
      expect(wrapped.content).toContain('import XpAppProvider from "../xp/XpAppProvider.vue"');
      expect(wrapped.content).toContain(
        '<section class="shop"><!-- keep --><RouterView /></section>',
      );
      expect(dist.owned[0]?.path).toBe("src/xp/options." + extension);
      files[wrapped.path] = wrapped.content.replace("<!-- keep -->", "<!-- edited -->");
      expect((await vue.generate(context(files, lang))).registrations[0]?.content).toBe(
        files[wrapped.path],
      );
    },
  );
  it("leaves custom mount factories untouched with standalone integration and instructions", async () => {
    const output = await vue.generate(context({ "src/main.ts": 'configureApp().mount("#app")' }));
    expect(output.registrations).toEqual([]);
    expect(output.manual.join()).toContain("src/main.ts");
    expect(output.owned).toHaveLength(3);
  });
  it("can make the stock implicit Nuxt pages layout explicit and preserves existing app markup", async () => {
    const result = await nuxt.generate(
      context({ "app/pages/index.vue": "<template>Index</template>" }),
    );
    expect(result.registrations[0]?.path).toBe("app/app.vue");
    expect(result.registrations[0]?.content).toContain("<NuxtLayout><NuxtPage /></NuxtLayout>");
    expect((await nuxt.generate(context({}))).manual).toHaveLength(1);
  });
});
