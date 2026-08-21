import { InferInsertModel } from "drizzle-orm";
import { DeploymentLogs as DL } from "../schema";
import { database } from "..";

import { DeploymentLogs } from "../tables/deployment";

export const createDeploymentLogs = async (
  params: InferInsertModel<typeof DL>,
) => {
  return database.insert(DeploymentLogs).values({
    deploymentId: params.deploymentId,
    message: params.message,
    createdBy: params.createdBy,
  });
};
