import type { AnalyticsDestination } from "~/entities/analytics";
import type { AnalyticsStore } from "~/interfaces/analytics";

export function storageReadiness(
  store: AnalyticsStore | undefined,
  destinations: readonly AnalyticsDestination[],
) {
  if (!store) throw new Error("This database adaptor does not support analytics storage");
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= store.ready(destinations).catch((error: unknown) => {
      ready = undefined;
      throw new Error(
        "Analytics storage check failed. Apply the xp setup --analytics extension and check destination key/provider bindings.",
        { cause: error },
      );
    });
    return ready;
  };
}
