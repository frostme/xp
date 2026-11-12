import type { IProjectManager } from "~/interfaces/projectManager";

import SetupGenerators from "~/adaptors/setup/generators";
import ProjectManager from "~/adaptors/setup/projectManager";
import CliFramework from "~/frameworks/cli";
import Setup, { ApplySetup, DetectProject } from "~/use-cases/setup";

/** Import-safe composition; pass a project manager to supply alternative integration adaptors. */
export default function cli(
  manager: IProjectManager = new ProjectManager(new SetupGenerators()),
): CliFramework {
  return new CliFramework(new DetectProject(manager), new Setup(manager), new ApplySetup(manager));
}

export type {
  SetupOptions,
  ResolvedSetup,
  ProjectDetection,
  SetupPlan,
  SetupResult,
  FileChange,
  IProjectManager,
  ISetupGenerator,
  GeneratedArtifacts,
  GeneratedFile,
} from "~/interfaces/setup";
