import { database } from "..";
import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { Deployments } from "../schema";
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
