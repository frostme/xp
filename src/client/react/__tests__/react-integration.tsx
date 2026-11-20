// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Cohort,
  Experiment,
  XPProvider,
  useCohort,
  type CohortResult,
  type XPProviderProps,
} from "..";

const experiment = "checkout-banner";
const on = experiment + "_on";
const control = experiment + "_control";
let host: HTMLDivElement;
let root: Root | undefined;

function branchView() {
  return (
    <Experiment slug={experiment} loading={<i>Pending</i>}>
      <Cohort slug="on">Treatment</Cohort>
      <Cohort slug="control">Control</Cohort>
      <Cohort default>Default</Cohort>
    </Experiment>
  );
}

function deferredLoader() {
  const requests: {
    slug: string;
    signal: AbortSignal;
    resolve(value: string | null): void;
    reject(error: Error): void;
  }[] = [];
  const loader = vi.fn((slug: string, { signal }: { signal: AbortSignal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<string | null>();
    requests.push({ slug, signal, resolve, reject });
    return promise;
  });
  return { requests, loader };
}

async function render(node: ReactNode) {
  root ??= createRoot(host);
  await act(() => root!.render(node));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

describe("React experiment components", () => {
  it("shares requests across a hook and duplicate gates under Strict Mode; retains a settled result", async () => {
    const { requests, loader } = deferredLoader();
    const observe = vi.fn();
    function Sidebar() {
      const result = useCohort(experiment);
      observe(result.status);
      return (
        <section>
          <Cohort slug={on}>Standalone</Cohort>
        </section>
      );
    }
    function page(show: boolean) {
      return (
        <StrictMode>
          <XPProvider loader={loader}>
            {show && (
              <>
                {branchView()}
                <Sidebar />
              </>
            )}
          </XPProvider>
        </StrictMode>
      );
    }
    await render(page(true));
    expect(host.textContent).toBe("Pending");
    expect(requests).toHaveLength(1);
    await act(() => requests[0]!.resolve(on));
    expect(host.textContent).toBe("TreatmentStandalone");
    expect(observe).toHaveBeenLastCalledWith("ready");
    await render(page(false));
    await render(page(true));
    expect(host.textContent).toBe("TreatmentStandalone");
    expect(requests).toHaveLength(1);
  });

  it("supports component boundaries, nested experiment scope, multiple defaults and omitted treatments", async () => {
    const { requests, loader } = deferredLoader();
    function Inside({ children }: { children: ReactNode }) {
      const result = useCohort();
      return (
        <section>
          {result.slug}
          {children}
        </section>
      );
    }
    await render(
      <XPProvider loader={loader}>
        <Experiment slug="outer">
          <Inside>
            <Cohort slug="outer_first">Outer first</Cohort>
            <Cohort default>Outer default</Cohort>
          </Inside>
          <Experiment slug="inner">
            <Inside>
              <Cohort slug="first">Inner first</Cohort>
              <Cohort default>Inner default A</Cohort>
              <Cohort default>Inner default B</Cohort>
            </Inside>
          </Experiment>
        </Experiment>
      </XPProvider>,
    );
    expect(host.textContent).toBe("");
    expect(requests.map((r) => r.slug).sort()).toEqual(["inner", "outer"]);
    await act(() => {
      requests.find((r) => r.slug === "outer")!.resolve("outer_omitted");
      requests.find((r) => r.slug === "inner")!.resolve(null);
    });
    expect(host.textContent).toBe("outer_omittedInner default AInner default B");
  });

  it("shares refreshes, restores treatment after resume and exposes a recoverable failure", async () => {
    const { loader, requests } = deferredLoader();
    let result!: CohortResult;
    function Hook() {
      result = useCohort(experiment);
      return null;
    }
    await render(
      <XPProvider loader={loader}>
        <Hook />
        {branchView()}
      </XPProvider>,
    );
    await act(() => requests[0]!.resolve(on));
    expect(host.textContent).toBe("Treatment");
    for (const [index, decision, branch] of [
      [1, null, "Default"],
      [2, on, "Treatment"],
      [3, new Error("offline"), "Default"],
      [4, control, "Control"],
    ] as const) {
      let refresh!: Promise<void>;
      await act(() => {
        refresh = result.refresh();
        expect(result.refresh()).toBe(refresh);
      });
      expect(requests).toHaveLength(index + 1);
      expect(host.textContent).toBe("Pending");
      expect(result.status).toBe("loading");
      await act(async () => {
        if (decision instanceof Error) requests[index]!.reject(decision);
        else requests[index]!.resolve(decision);
        await refresh;
      });
      expect(host.textContent).toBe(branch);
      expect(result.error).toBe(decision instanceof Error ? decision : null);
      expect(result.status).toBe(decision instanceof Error ? "error" : "ready");
    }
  });

  it("replaces an initial request on refresh and ignores its late error", async () => {
    const { loader, requests } = deferredLoader();
    let result!: CohortResult;
    function Observer() {
      result = useCohort(experiment);
      return null;
    }
    await render(
      <XPProvider loader={loader}>
        <Observer />
        {branchView()}
      </XPProvider>,
    );
    let refreshed!: Promise<void>;
    await act(() => {
      refreshed = result.refresh();
    });
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1]!.resolve(on);
      await refreshed;
      requests[0]!.reject(new Error("late failure"));
    });
    expect(result).toMatchObject({ status: "ready", slug: on, error: null });
    expect(host.textContent).toBe("Treatment");
  });

  it("aborts replaced requests and discards a late treatment after an account switch and logout", async () => {
    const { loader, requests } = deferredLoader();
    const page = (sessionKey: string) => (
      <XPProvider loader={loader} sessionKey={sessionKey}>
        {branchView()}
      </XPProvider>
    );
    await render(page("alice"));
    await render(page("bob"));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe("Pending");
    await act(() => requests[1]!.resolve(control));
    expect(host.textContent).toBe("Control");
    await act(() => requests[0]!.resolve(on));
    expect(host.textContent).toBe("Control");
    await render(page("guest"));
    await act(() => requests[2]!.resolve(null));
    expect(host.textContent).toBe("Default");
    await render(page("alice"));
    expect(host.textContent).toBe("Pending");
    expect(requests).toHaveLength(4);
    await render(null);
    expect(requests[3]!.signal.aborted).toBe(true);
    await act(() => requests[3]!.reject(new Error("late failure")));
    expect(host.textContent).toBe("");
  });

  it("binds initial decisions to their session when a host recreates its preload map", async () => {
    const { loader, requests } = deferredLoader();
    const page = (sessionKey: string, slug: string | null) => (
      <XPProvider
        loader={loader}
        sessionKey={sessionKey}
        initialAssignments={{ [experiment]: slug }}
      >
        {branchView()}
      </XPProvider>
    );
    await render(page("alice", on));
    await render(page("alice", null));
    expect(host.textContent).toBe("Treatment");
    expect(requests).toHaveLength(0);
    await render(page("bob", on));
    expect(host.textContent).toBe("Pending");
    await act(() => requests[0]!.resolve(control));
    expect(host.textContent).toBe("Control");
  });

  it("re-checks a changed endpoint, transport or custom loader", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const graphql = "query" in JSON.parse(String(init.body));
      return Response.json(graphql ? { data: { xpResolveCohort: { slug: null } } } : { slug: on });
    });
    vi.stubGlobal("fetch", fetch);
    const page = (props: XPProviderProps = {}) => (
      <XPProvider {...props}>{branchView()}</XPProvider>
    );
    await render(page());
    expect(host.textContent).toBe("Treatment");
    await render(page({ experimentHost: "/api/" }));
    await render(page({ loader: "graphql", experimentHost: "/api/" }));
    expect(host.textContent).toBe("Default");
    await render(page({ loader: "graphql", endpoint: "/custom" }));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/xp",
      "/api/xp",
      "/api/graphql",
      "/custom",
    ]);
    await render(page({ loader: async () => control }));
    expect(host.textContent).toBe("Control");
    await render(page({ loader: async () => "another_slug" }));
    expect(host.textContent).toBe("Default");
  });

  it.each([
    <Cohort default />,
    <Cohort slug="local" />,
    <Experiment slug="a">
      <Cohort slug="b_local" />
    </Experiment>,
    <Experiment slug="a">
      <Cohort slug="a_bad_name" />
    </Experiment>,
  ])("rejects an invalid or ambiguous cohort gate", (gate) => {
    expect(() => renderToString(<XPProvider>{gate}</XPProvider>)).toThrow();
  });
});

describe("React SSR and hydration", () => {
  it.each([
    [on, "Treatment"],
    [null, "Default"],
    [undefined, "Pending"],
  ] as const)(
    "uses the same request-local snapshot on server and browser for %s",
    async (preload, expected) => {
      const { loader, requests } = deferredLoader();
      const props = preload === undefined ? {} : { initialAssignments: { [experiment]: preload } };
      const page = () => (
        <XPProvider loader={loader} {...props}>
          {branchView()}
        </XPProvider>
      );
      host.innerHTML = renderToString(page());
      expect(host.textContent).toBe(expected);
      const otherRequest = renderToString(
        <XPProvider loader={loader} initialAssignments={{ [experiment]: control }}>
          {branchView()}
        </XPProvider>,
      );
      expect(otherRequest).toContain("Control");
      expect(requests).toHaveLength(0);
      const onRecoverableError = vi.fn();
      await act(() => {
        root = hydrateRoot(host, page(), { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(host.textContent).toBe(expected);
      if (preload === undefined) {
        expect(requests).toHaveLength(1);
        await act(() => requests[0]!.resolve(on));
        expect(host.textContent).toBe("Treatment");
      } else {
        expect(requests).toHaveLength(0);
      }
    },
  );
});

it("hydrates mixed success, explicit null, sanitized failure and an absent experiment independently", async () => {
  const { loader, requests } = deferredLoader();
  function Status({ slug }: { slug: string }) {
    const result = useCohort(slug);
    return (
      <button onClick={() => void result.refresh()}>
        {slug}/{result.status}/{result.error?.message}
      </button>
    );
  }
  const tree = (
    <XPProvider
      loader={loader}
      initialAssignments={{ paid: "paid_on", guest: null }}
      initialErrors={["broken"]}
    >
      {["paid", "guest", "broken", "absent"].map((slug) => (
        <Experiment key={slug} slug={slug} loading="Pending">
          <Cohort slug="on">Treatment</Cohort>
          <Cohort default>Default</Cohort>
          <Status slug={slug} />
        </Experiment>
      ))}
    </XPProvider>
  );
  host.innerHTML = renderToString(tree);
  const html = host.textContent;
  expect(html).toBe(
    "Treatmentpaid/ready/Defaultguest/ready/Defaultbroken/error/Failed to resolve cohortPendingabsent/loading/",
  );
  expect(requests).toHaveLength(0);
  const onRecoverableError = vi.fn();
  await act(() => {
    root = hydrateRoot(host, tree, { onRecoverableError });
  });
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(host.textContent).toBe(html);
  expect(requests.map((r) => r.slug)).toEqual(["absent"]);
  await act(() => host.querySelectorAll("button")[2]!.click());
  expect(host.textContent).toContain("Pendingbroken/loading/");
  await act(() => requests[1]!.resolve("broken_on"));
  expect(host.textContent).toContain("Treatmentbroken/ready/");
  expect(host.textContent).toContain("Treatmentpaid/ready/");
});
