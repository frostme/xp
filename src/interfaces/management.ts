import type { Experiment } from "~/entities";
import type { RolloutCommand } from "~/use-cases/experiment/rollout";

export type ManagementAccess = "deny" | "view" | "manage";
export interface DirectoryQuery {
  query: string;
  limit: number;
  cursor?: string;
}
export type DirectoryEntry = Pick<
  Experiment,
  "slug" | "name" | "type" | "enabled" | "winner" | "rolloutPhase"
>;
export interface DirectoryPage {
  items: DirectoryEntry[];
  nextCursor: string | null;
}
export interface ManagementDetail extends DirectoryEntry {
  id: Experiment["id"];
  description: string;
  revision: number;
  actions: RolloutCommand["type"][];
  countsReadAt: string | null;
  cohorts: {
    slug: string;
    type: string;
    description: string;
    percentage: number | null;
    memberships: number | null;
    value: Experiment["cohorts"][number]["value"];
  }[];
}
