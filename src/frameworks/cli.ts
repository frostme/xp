import type { IUseCase } from "~/interfaces";
import type { ProjectDetection, SetupOptions, SetupPlan, SetupResult } from "~/interfaces/setup";

/** The CLI framework does not require database-backed experiment use cases. */
export default class CliFramework {
  constructor(
    protected detection: IUseCase<ProjectDetection>,
    protected planning: IUseCase<SetupPlan>,
    protected application: IUseCase<SetupResult>,
  ) {}

  async detectProject(options: SetupOptions = {}): Promise<ProjectDetection> {
    return this.detection.call(options);
  }

  async planSetup(options: SetupOptions = {}): Promise<SetupPlan> {
    return this.planning.call(options);
  }

  async applySetup(plan: SetupPlan): Promise<SetupResult> {
    return this.application.call(plan);
  }
}
