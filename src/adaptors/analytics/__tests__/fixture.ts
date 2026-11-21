import type { PendingDelivery } from "~/entities/analytics";

export const membership = {
  subjectId: "external-shopper",
  event: {
    name: "xp.cohort.joined",
    version: 1,
    id: "69d67977-3038-42ef-ad64-a75fb460bd49",
    occurredAt: "2026-11-01T12:00:01.234Z",
    experimentSlug: "checkout",
    cohortSlug: "checkout_control",
    source: "automatic",
  },
} as const satisfies Pick<PendingDelivery, "subjectId" | "event">;
