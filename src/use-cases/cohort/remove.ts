import type { PKey } from "~/entities";
import type { IUseCase, ICohortDAO } from "~/interfaces";

export default class RemoveCohort implements IUseCase<void> {
  constructor(protected cohortDAO: ICohortDAO) {}

  async call(id: PKey<"Cohort">): Promise<void> {
    await this.cohortDAO.remove(id);
  }
}
