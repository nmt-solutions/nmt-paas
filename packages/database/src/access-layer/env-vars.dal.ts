import { InferInsertModel } from "drizzle-orm";
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
