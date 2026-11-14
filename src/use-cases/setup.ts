import type { IUseCase } from "~/interfaces";
import type {
  IProjectManager,
  ProjectDetection,
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
