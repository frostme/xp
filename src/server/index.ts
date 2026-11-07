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
} from "~/use-cases";

import { detectClient, type ServerOptions } from "./detectClient";

const server = (client: unknown, options: ServerOptions = {}) => {
  const serverConfig = detectClient(client, options);

  const groupUseCase = new GetGroup(
    serverConfig.dao.userDAO,
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
    serverConfig.bucketer,
  );

  const joinCohortUseCase = new JoinCohort(
    serverConfig.dao.userDAO,
    serverConfig.dao.experimentDAO,
    serverConfig.dao.cohortDAO,
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

  return new ServerFramework(
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
  );
};

export default server;
