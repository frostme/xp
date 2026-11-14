import type {
  ISetupGenerator,
  ResolvedSetup,
  ProjectDetection,
  GeneratedArtifacts,
} from "~/interfaces/setup";

import { generateDrizzle } from "./drizzle";
import { generatePrisma } from "./prisma";
import { generateStandard } from "./standard";

export default class SetupGenerators implements ISetupGenerator {
  generate(options: ResolvedSetup, project: ProjectDetection): Promise<GeneratedArtifacts> {
    if (options.orm === "prisma") return generatePrisma(options, project);
    if (options.orm === "drizzle") return generateDrizzle(options, project);
    return generateStandard(options, project);
  }
}
