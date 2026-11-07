import { ValidationError } from "~/errors";

export interface Key {
  pk: string;
  sk: string;
}

export const experimentKey = (id: string | number): Key => ({ pk: `EXP#${id}`, sk: "META" });
export const cohortKey = (experimentId: string | number, id: string | number): Key => ({
  pk: `EXP#${experimentId}`,
  sk: `C#${id}`,
});
export const cohortLocator = (id: string | number): Key => ({ pk: `COHORT#${id}`, sk: "META" });
export const experimentClaim = (slug: string): Key => ({ pk: `EXP_SLUG#${slug}`, sk: "META" });
export const cohortClaim = (slug: string): Key => ({ pk: `COHORT_SLUG#${slug}`, sk: "META" });

/** Preserve the distinction between numeric and string application user IDs. */
export function encodeUserId(id: string | number): string {
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new ValidationError("User IDs must be strings or finite numbers");
  }
  return Buffer.from(JSON.stringify([typeof id, id])).toString("base64url");
}

export const userKey = (id: string | number): Key => ({
  pk: `USER#${encodeUserId(id)}`,
  sk: "META",
});
export const membershipKey = (experimentId: string | number, userId: string | number): Key => ({
  pk: `EXP#${experimentId}`,
  sk: `M#${encodeUserId(userId)}`,
});
export const membershipReference = (cohortId: string | number, userId: string | number): Key => ({
  pk: `COHORT#${cohortId}`,
  sk: `M#${encodeUserId(userId)}`,
});
