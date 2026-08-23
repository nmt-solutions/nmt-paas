import { database } from "..";
import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { Deployments } from "../schema";
import { UpdateInput } from "../utils/types";

export const getDeployment = async (deploymentId: number) => {
  return database.query.Deployments.findFirst({
    where: { id: deploymentId },
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
  database
    .update(Deployments)
    .set({ ...params, modifiedBy: updatedBy, id: undefined })
    .where(eq(Deployments.id, params.id));
};
