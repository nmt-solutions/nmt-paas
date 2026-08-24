import { eq, InferInsertModel } from "drizzle-orm";
import { database } from "..";
import { AppEnv, EnvVars } from "../schema";

export const createEnvVars = async (
  params: InferInsertModel<typeof EnvVars>[],
) => {
  return await database.insert(EnvVars).values(params).returning();
};

export const getEnvVars = async (
  projectId: number,
  env: (typeof AppEnv.enumValues)[number],
) => {
  return database.query.EnvVars.findMany({
    where: {
      projectId,
      env,
      resourceStatus: "active",
    },
  });
};

export const getEnvVarKeys = async (projectId: number) =>
  database.query.EnvVars.findMany({
    where: { projectId, resourceStatus: "active" },
    columns: {
      id: true,
      key: true,
      env: true,
      createdAt: true,
      modifiedAt: true,
    },
  });

export const deactivateEnvVar = async (id: number, updatedBy: string) =>
  database
    .update(EnvVars)
    .set({ resourceStatus: "inactive", modifiedBy: updatedBy })
    .where(eq(EnvVars.id, id));
