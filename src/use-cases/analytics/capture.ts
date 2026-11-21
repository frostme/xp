import { randomUUID } from "node:crypto";

import type { AnalyticsDestination, CohortJoinedV1, PendingDelivery } from "~/entities/analytics";

export interface AnalyticsCaptureOptions {
  readonly destinations: readonly AnalyticsDestination[];
  readonly mapIdentity: (input: {
    readonly userId: string | number;
    readonly destination: AnalyticsDestination;
    readonly signal: AbortSignal;
  }) => string | null | Promise<string | null>;
  readonly mappingTimeoutMs?: number;
}

type Join = Pick<CohortJoinedV1, "experimentSlug" | "cohortSlug" | "source">;
const providers = new Set(["amplitude", "segment", "mixpanel", "fullstory", "heap", "posthog"]);

export function validateDestination({ key, provider }: AnalyticsDestination): AnalyticsDestination {
  if (typeof key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(key))
    throw new TypeError("Invalid analytics destination key");
  if (
    typeof provider !== "string" ||
    !(providers.has(provider) || /^custom:[a-z][a-z0-9-]{0,56}$/.test(provider))
  )
    throw new TypeError("Invalid analytics provider (use custom:<name> for a host adaptor)");
  return Object.freeze({ key, provider });
}

export class JoinCapture {
  readonly destinations: readonly AnalyticsDestination[];
  private readonly mapIdentity: AnalyticsCaptureOptions["mapIdentity"];
  private readonly timeoutMs: number;

  constructor(options: AnalyticsCaptureOptions) {
    if (!Array.isArray(options?.destinations) || options.destinations.length > 32)
      throw new TypeError("Configure at most 32 analytics destinations");
    this.destinations = Object.freeze(options.destinations.map(validateDestination));
    if (new Set(this.destinations.map(({ key }) => key)).size !== this.destinations.length)
      throw new TypeError("Analytics destination keys must be unique");
    if (typeof options.mapIdentity !== "function")
      throw new TypeError("Analytics requires mapIdentity");
    this.mapIdentity = options.mapIdentity;
    this.timeoutMs = options.mappingTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000)
      throw new RangeError("mappingTimeoutMs must be an integer between 1 and 30000");
  }

  // Stage candidates outside the membership transaction. Only its winning insert can publish them.
  async prepare(userId: string | number, join: Join): Promise<readonly PendingDelivery[]> {
    if (this.destinations.length === 0) return [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Analytics identity mapping timed out")),
        this.timeoutMs,
      );
    });

    try {
      const identities = await Promise.race([
        timeout,
        Promise.all(
          this.destinations.map(async (destination) => {
            let subjectId: string | null;
            try {
              subjectId = await this.mapIdentity({
                userId,
                destination,
                signal: controller.signal,
              });
            } catch {
              throw new Error("Analytics identity mapping failed");
            }
            if (
              subjectId !== null &&
              (typeof subjectId !== "string" ||
                !subjectId.trim() ||
                !subjectId.isWellFormed() ||
                subjectId.includes("\0") ||
                Buffer.byteLength(subjectId) > 1024)
            )
              throw new TypeError(
                "Mapped analytics identity must be null or a nonempty string of at most 1024 UTF-8 bytes",
              );
            return { destination, subjectId };
          }),
        ),
      ]);
      const event: CohortJoinedV1 = Object.freeze({
        name: "xp.cohort.joined",
        version: 1,
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        experimentSlug: join.experimentSlug,
        cohortSlug: join.cohortSlug,
        source: join.source,
      });
      return Object.freeze(
        identities.flatMap(({ destination, subjectId }) =>
          subjectId === null
            ? []
            : [
                Object.freeze({
                  destinationKey: destination.key,
                  provider: destination.provider,
                  event,
                  subjectId,
                }),
              ],
        ),
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
