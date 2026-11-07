import { database } from "..";
import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { Deployments, type DeploymentCleanup } from "../schema";
import { UpdateInput } from "../utils/types";
import { activeAppEligibility } from "./app-eligibility";

export const getDeployment = async (deploymentId: number, userId: string) => {
  return database.query.Deployments.findFirst({
    where: {
      id: deploymentId,
      userId,
      createdBy: userId,
      resourceStatus: "active",
      app: activeAppEligibility(userId),
    },
    with: {
      app: {
        with: {
          frameworkConfig: true,
          appDomains: true,
        },
      },
    },
  });
};

// Operator cleanup only: expose the recorded ledger and its coordination/start
// identity, never app configuration, environment, logs or deploy/publication data.
// No lifecycle filter is relaxed on the ordinary deployment reader.
export const getRecordedDeploymentCleanup = async (
  deploymentId: number,
  userId: string,
) => {
  const record = await database.query.Deployments.findFirst({
    where: {
      id: deploymentId,
      userId,
      createdBy: userId,
      app: { createdBy: userId, project: { userId, createdBy: userId } },
    },
    columns: { appId: true, userId: true, status: true, cleanup: true },
  });
  return record?.cleanup ? record : undefined;
};

export const createDeployment = async (
  params: InferInsertModel<typeof Deployments>,
) => {
  const [deployment] = await database
    .insert(Deployments)
    .values(params)
    .returning();

  return deployment;
};

export const updateDeployment = async (
  params: UpdateInput<InferSelectModel<typeof Deployments>, "id">,
  updatedBy: string,
) => {
  return database
    .update(Deployments)
    .set({ ...params, modifiedBy: updatedBy, id: undefined })
    .where(eq(Deployments.id, params.id));
};

export const saveDeploymentCleanup = (
  id: number,
  cleanup: DeploymentCleanup,
  updatedBy: string,
) => updateDeployment({ id, cleanup }, updatedBy);
