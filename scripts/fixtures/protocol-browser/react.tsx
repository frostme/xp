import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { Cohort, Experiment, XPProvider, useCohort } from "@frostme/xp/react";
import { createRoot, type Root } from "react-dom/client";

function Decision() {
  const { status, slug, error, refresh } = useCohort();
  return (
    <>
      <output data-status={status} data-slug={slug ?? ""} data-error={Boolean(error)} />
      <button type="button" onClick={() => void refresh()}>
        Retry
      </button>
      <Cohort default>
        <strong>default</strong>
      </Cohort>
      <Cohort slug="short">
        <strong>short</strong>
      </Cohort>
      <Cohort slug="control">
        <strong>control</strong>
      </Cohort>
    </>
  );
}

let root: Root | undefined;
let proxyBase: string;
let customLoader: ReturnType<typeof proxyLoader>;
let nextResponse:
  | {
      received: (slug: string | null) => void;
      failed: (cause: unknown) => void;
      released: Promise<void>;
      delivered: (aborted: boolean) => void;
    }
  | undefined;
let release: (() => void) | undefined;
let delivered: Promise<boolean> | undefined;

// Delay delivery of an authentic decoded result. This models an uncooperative
// loader that still completes after the account switch aborts its signal.
function proxyLoader(experimentHost: string) {
  const load = createGrpcWebLoader({ experimentHost, credentials: "include" });
  return async (slug: string, options: { signal: AbortSignal }) => {
    const held = nextResponse;
    nextResponse = undefined;
    const request = load(slug, options);
    if (!held) return request;
    try {
      const result = await request;
      held.received(result);
      await held.released;
      held.delivered(options.signal.aborted);
      return result;
    } catch (cause) {
      held.failed(cause);
      throw cause;
    }
  };
}

export function holdNextResponse() {
  const received = Promise.withResolvers<string | null>();
  const released = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<boolean>();
  nextResponse = {
    received: received.resolve,
    failed: received.reject,
    released: released.promise,
    delivered: completed.resolve,
  };
  release = released.resolve;
  delivered = completed.promise;
  return received.promise;
}

export async function releaseResponse() {
  release?.();
  return await delivered;
}

export function showSession({
  loader,
  endpoint,
  sessionKey,
}: {
  loader: "grpc-web" | "soap" | "custom";
  endpoint: string;
  sessionKey: string;
}) {
  if (!root) {
    const container = document.createElement("main");
    container.id = "react-journey";
    document.body.append(container);
    root = createRoot(container);
  }
  if (loader === "custom" && (!customLoader || proxyBase !== endpoint)) {
    proxyBase = endpoint;
    customLoader = proxyLoader(endpoint);
  }
  const location = loader === "soap" ? { endpoint } : { experimentHost: endpoint };
  root.render(
    <XPProvider
      loader={loader === "custom" ? customLoader : loader}
      sessionKey={sessionKey}
      {...location}
    >
      <section data-session={sessionKey}>
        <Experiment slug="delivery-copy">
          <Decision />
        </Experiment>
      </section>
    </XPProvider>,
  );
}
