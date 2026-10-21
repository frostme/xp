import { sample } from "es-toolkit/array";

import type { IBucketer } from "~/interfaces";

const randomBucketer: IBucketer = (_userId, _experimentId, cohortIds) => {
  if (cohortIds.length === 0) {
    throw new Error("No cohorts available for bucketing");
  }
  return Promise.resolve(sample(cohortIds));
};

export default randomBucketer;
