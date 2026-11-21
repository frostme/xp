import type { ServerOptions } from "~/server/detectClient";

import { detectClient } from "~/server/detectClient";
import { AnalyticsWorker, type WorkerSettings } from "~/use-cases/analytics/worker";

export type { AnalyticsDestination, CohortJoinedV1, PendingDelivery } from "~/entities/analytics";
export type {
  AnalyticsAdaptor,
  DeliveryDiagnostics,
  DeliveryFailure,
  DeliveryResult,
  DeliveryState,
  DeliverySummary,
} from "~/interfaces/analytics";
export type { WorkerSettings, DrainCounts } from "~/use-cases/analytics/worker";
export interface AnalyticsWorkerOptions
  extends WorkerSettings, Pick<ServerOptions, "tableName" | "databaseName"> {
  connection: unknown;
}
export function createAnalyticsWorker({ connection, ...options }: AnalyticsWorkerOptions) {
  const { dao } = detectClient(connection, options);
  if (!dao.analytics) throw new Error("This database adaptor does not support analytics storage");
  return new AnalyticsWorker(dao.analytics, options);
}
