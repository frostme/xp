import type { IUseCase, ICohortDAO } from "~/interfaces";

import { Cohort, type CohortSlug } from "~/entities";
import { NotFoundError } from "~/errors";

export default class ViewCohort implements IUseCase<Cohort> {
  constructor(protected cohortDAO: ICohortDAO) {}

  async call(slug: CohortSlug): Promise<Cohort> {
    const cohort = await this.cohortDAO.findBySlug(slug);
    if (!cohort) {
      throw new NotFoundError(`Cohort with slug ${slug} not found`);
    }
    return cohort;
  }
}
