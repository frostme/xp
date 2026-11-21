export interface CohortJoinedV1 {
  readonly name: "xp.cohort.joined";
  readonly version: 1;
  readonly id: string;
  readonly occurredAt: string;
  readonly experimentSlug: string;
  readonly cohortSlug: string;
  readonly source: "automatic" | "manual";
}

export interface AnalyticsDestination {
  readonly key: string;
  readonly provider: string;
}

export interface PendingDelivery {
  readonly event: CohortJoinedV1;
  readonly destinationKey: string;
  readonly provider: string;
  readonly subjectId: string;
}
