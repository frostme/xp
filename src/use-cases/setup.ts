import type { IUseCase } from "~/interfaces";
import type {
  IProjectManager,
  ProjectDetection,
  ScopedDetection,
  ScopedSetupPlan,
  ScopedSetupOptions,
  SetupOptions,
  SetupPlan,
  SetupResult,
} from "~/interfaces/setup";

/** Setup orchestration is independent of terminals, filesystems, and database clients. */
export default class Setup implements IUseCase<SetupPlan> {
  constructor(protected manager: IProjectManager) {}
  call(options: SetupOptions = {}): Promise<SetupPlan> {
    return this.manager.planSetup(options);
  }
}

export class DetectProject implements IUseCase<ProjectDetection> {
  constructor(protected manager: IProjectManager) {}
  call(options: SetupOptions = {}): Promise<ProjectDetection> {
    return this.manager.detectProject(options);
  }
}

export class ApplySetup implements IUseCase<SetupResult> {
  constructor(protected manager: IProjectManager) {}
  call(plan: SetupPlan): Promise<SetupResult> {
    return this.manager.applySetup(plan);
  }
}

/** Scoped orchestration keeps existing storage-only project managers usable. */
export class ScopedSetup {
  constructor(private readonly manager: IProjectManager) {}

  detectScoped(options: ScopedSetupOptions, interactive: boolean): Promise<ScopedDetection> {
    return this.manager.detectScoped?.(options, interactive) ?? this.manager.detectProject(options);
  }

  planScoped(options: ScopedSetupOptions): Promise<ScopedSetupPlan> {
    if (this.manager.planScoped) return this.manager.planScoped(options);
    if (
      options.scope === "frontend" ||
      options.scope === "both" ||
      options.frontend ||
      options.transport ||
      options.endpoint
    )
      throw new Error("The supplied project manager supports storage setup only.");
    return this.manager.planSetup(options);
  }

  applyScoped(plan: ScopedSetupPlan): Promise<SetupResult> {
    if (this.manager.applyScoped) return this.manager.applyScoped(plan);
    if (!plan.options.orm || !plan.options.database)
      throw new Error("The supplied project manager supports storage setup only.");
    return this.manager.applySetup(plan as SetupPlan);
  }
}
