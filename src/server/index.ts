import { parseManagedDefinition } from "~/adaptors/validation/zod/seed";
import { ServerFramework } from "~/frameworks";
import {
  GetGroup,
  JoinCohort,
  LeaveExperiment,
  AddCohortToExperiment,
  CreateExperiment,
  FinalizeExperiment,
  RemoveExperiment,
  UpdateExperiment,
  ViewCohort,
  UpdateCohort,
  RemoveCohort,
  SetExperimentAvailability,
} from "~/use-cases";
import { JoinCapture, type AnalyticsCaptureOptions } from "~/use-cases/analytics/capture";
import { storageReadiness } from "~/use-cases/analytics/readiness";
import { createExperimentManagement } from "~/use-cases/experiment/management";
import { seedExperiments } from "~/use-cases/experiment/seed";

import { detectClient, type ServerOptions } from "./detectClient";
import { readSeedConfig } from "./readSeedConfig";

export type { CohortDecision, CohortRuntime, SeedReport, UserIdentity } from "~/interfaces/runtime";
export { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

export type { AnalyticsCaptureOptions };

export interface InitializeOptions extends ServerOptions {
  connection: unknown;
  cwd?: string;
  configPath?: string;
}

function createServer(
  serverConfig: ReturnType<typeof detectClient>,
  analytics?: AnalyticsCaptureOptions,
  allowCreate = false,
) {
  const capture = analytics === undefined ? undefined : new JoinCapture(analytics);
  const checkAnalyticsStorage = capture
    ? storageReadiness(serverConfig.dao.analytics, capture.destinations)
    : () => Promise.resolve();
  const verifiedCapture = capture && {
    async prepare(...args: Parameters<JoinCapture["prepare"]>) {
      await checkAnalyticsStorage();
      return capture.prepare(...args);
    },
  };
  const groupUseCase = new GetGroup(
    serverConfig.dao.userDAO,
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
    serverConfig.bucketer,
    verifiedCapture,
  );

  const joinCohortUseCase = new JoinCohort(
    serverConfig.dao.userDAO,
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
    verifiedCapture,
  );

  const leaveExperimentUseCase = new LeaveExperiment(
    serverConfig.dao.userDAO,
    serverConfig.dao.experimentDAO,
  );

  const addCohortToExperimentUseCase = new AddCohortToExperiment(
    serverConfig.validation.cohort.create,
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
  );

  const createExperimentUseCase = new CreateExperiment(
    serverConfig.validation.experiment.create,
    serverConfig.dao.experimentDAO,
  );

  const finalizeExperimentUseCase = new FinalizeExperiment(
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
  );

  const removeExperimentUseCase = new RemoveExperiment(serverConfig.dao.experimentDAO);

  const updateExperimentUseCase = new UpdateExperiment(
    serverConfig.validation.experiment.update,
    serverConfig.dao.experimentDAO,
  );

  const viewCohortUseCase = new ViewCohort(serverConfig.dao.cohortDAO);

  const updateCohortUseCase = new UpdateCohort(
    serverConfig.validation.cohort.update,
    serverConfig.dao.cohortDAO,
  );

  const removeCohortUseCase = new RemoveCohort(serverConfig.dao.cohortDAO);

  const framework = new ServerFramework(
    groupUseCase,
    joinCohortUseCase,
    leaveExperimentUseCase,
    addCohortToExperimentUseCase,
    createExperimentUseCase,
    finalizeExperimentUseCase,
    removeExperimentUseCase,
    updateExperimentUseCase,
    viewCohortUseCase,
    updateCohortUseCase,
    removeCohortUseCase,
    new SetExperimentAvailability(serverConfig.dao.experimentDAO),
  );
  return Object.assign(framework, {
    checkAnalyticsStorage,
    management: createExperimentManagement(serverConfig.dao.experimentDAO, allowCreate, (input) =>
      parseManagedDefinition(input, serverConfig.driverKind === "dynamodb" ? 32 : undefined),
    ),
    driverKind: serverConfig.driverKind,
    ...(serverConfig.driverKind === "sequelize" ? { dialect: serverConfig.dialect } : {}),
    resolveCohort: groupUseCase.resolveCohort.bind(groupUseCase),
  });
}

export { ExperimentPausedError, NotFoundError } from "~/errors";
export default function server(client: unknown, options: ServerOptions = {}) {
  return createServer(detectClient(client, options), options.analytics);
}

export async function initializeXp({ connection, cwd, configPath, ...options }: InitializeOptions) {
  const config = detectClient(connection, options);
  const { experiments, allowCreate } = await readSeedConfig(
    cwd,
    configPath,
    config.driverKind === "dynamodb" ? 32 : undefined,
  );
  const runtime = createServer(config, options.analytics, allowCreate);
  await runtime.checkAnalyticsStorage();
  const seedReport = await seedExperiments(experiments, config.dao.experimentDAO);
  return Object.assign(runtime, { seedReport });
}
