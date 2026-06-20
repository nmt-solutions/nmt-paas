import { and, eq, InferInsertModel } from "drizzle-orm";
import { AppEnv, EnvVars } from "../schema";
import { database } from "..";

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
    where: and(
      eq(EnvVars.projectId, projectId),
      eq(EnvVars.env, env),
      eq(EnvVars.resourceStatus, "active"),
    ),
  });
};
