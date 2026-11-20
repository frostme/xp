// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App, type VNode } from "vue";

import { Cohort, Experiment, XPProvider, useCohort } from "..";

let app: App | undefined;
function mount(render: () => VNode) {
  app = createApp(defineComponent({ setup: () => render }));
  const host = document.createElement("div");
  app.mount(host);
  return host;
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.unstubAllGlobals();
});

const gate = (props: { slug?: string; default?: boolean }, text: string) =>
  h(Cohort, props, () => text);
describe("Vue public API", () => {
  it("scopes nested providers and experiments and only constructs matching slot children", async () => {
    const created = vi.fn();
    const child = defineComponent({
      setup() {
        created();
        return () => "mounted";
      },
    });
    const host = mount(() =>
      h(XPProvider, { initialAssignments: { outer: "outer_on", inner: null } }, () =>
        h(Experiment, { slug: "outer" }, () => [
          gate({ slug: "on" }, "a"),
          gate({ slug: "outer_on" }, "b"),
          h(Cohort, { slug: "off" }, () => h(child)),
          h(Experiment, { slug: "inner" }, () => [
            gate({ default: true }, "c"),
            gate({ default: true }, "d"),
          ]),
          h(XPProvider, { initialAssignments: { outer: "outer_other" } }, () =>
            gate({ slug: "outer_on" }, "unmatched"),
          ),
        ]),
      ),
    );
    expect(host.textContent).toBe("abcd");
    expect(created).toHaveBeenCalledTimes(0);
  });

  it("retargets a getter, aborts on teardown and prevents obsolete account results from displaying", async () => {
    const pending: { slug: string; signal: AbortSignal; resolve: (v: string | null) => void }[] =
      [];
    const loader = (slug: string, { signal }: { signal: AbortSignal }) => {
      const work = Promise.withResolvers<string | null>();
      pending.push({ slug, signal, resolve: work.resolve });
      return work.promise;
    };
    const revision = ref(1);
    const slug = ref("one");
    const Reader = defineComponent({
      setup() {
        const result = useCohort(() => slug.value);
        return () => h("output", result.value.slug ?? result.value.status);
      },
    });
    const host = mount(() =>
      h(
        XPProvider,
        { loader, sessionKey: revision.value, initialAssignments: { one: "one_on" } },
        () => h(Reader),
      ),
    );
    expect(host.textContent).toBe("one_on");
    revision.value++;
    await nextTick();
    expect(host.textContent).toBe("loading");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    slug.value = "two";
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[0]!.resolve("one_on");
    pending[1]!.resolve("two_off");
    await vi.waitFor(() => expect(host.textContent).toBe("two_off"));
    revision.value++;
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    app?.unmount();
    app = undefined;
    expect(pending[2]?.signal.aborted).toBe(true);
  });

  it.each(["rest", "graphql"] as const)(
    "sends %s through the configured endpoint and distinguishes failures from null",
    async (loader) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          loader === "rest" ? { slug: null } : { data: { xpResolveCohort: { slug: null } } },
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const endpoint = ref("/decision");
      const Reader = defineComponent({
        setup() {
          const state = useCohort("shop");
          return () => h("output", state.value.status);
        },
      });
      const host = mount(() =>
        h(XPProvider, { loader, endpoint: endpoint.value }, () => h(Reader)),
      );
      await vi.waitFor(() => expect(host.textContent).toBe("ready"));
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/decision");
      const body = JSON.parse(String(init.body));
      expect(loader === "rest" ? body : body.variables).toEqual({ slug: "shop" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      fetcher.mockImplementationOnce(async () => Response.json({ slug: "other_on" }));
      endpoint.value = "/changed";
      await vi.waitFor(() => expect(host.textContent).toBe("error"));
    },
  );
});
