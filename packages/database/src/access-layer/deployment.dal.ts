import { database } from "..";
import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { Deployments, type DeploymentCleanup } from "../schema";
import { UpdateInput } from "../utils/types";

export const getDeployment = async (deploymentId: number) => {
  return database.query.Deployments.findFirst({
    where: { id: deploymentId, resourceStatus: "active" },
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
