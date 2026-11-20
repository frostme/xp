import type { IUseCase } from "~/interfaces";
import type {
  ProjectDetection,
  ScopedDetection,
  ScopedSetupOptions,
  ScopedSetupPlan,
  SetupOptions,
  SetupPlan,
  SetupResult,
} from "~/interfaces/setup";
import type { ScopedSetup } from "~/use-cases/setup";

/** The CLI framework does not require database-backed experiment use cases. */
export default class CliFramework {
  constructor(
    protected detection: IUseCase<ProjectDetection>,
    protected planning: IUseCase<SetupPlan>,
    protected application: IUseCase<SetupResult>,
    private readonly scoped?: ScopedSetup,
  ) {}

  async detectScoped(options: ScopedSetupOptions, interactive = false): Promise<ScopedDetection> {
    return this.scoped?.detectScoped
      ? this.scoped.detectScoped(options, interactive)
      : this.detectProject(options);
  }

  async planScoped(options: ScopedSetupOptions): Promise<ScopedSetupPlan> {
    if (this.scoped?.planScoped) return this.scoped.planScoped(options);
    return this.planSetup(options);
  }

  async applyScoped(plan: ScopedSetupPlan): Promise<SetupResult> {
    if (this.scoped?.applyScoped) return this.scoped.applyScoped(plan);
    return this.applySetup(plan as SetupPlan);
  }

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
