import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { database } from "..";
import { Apps } from "../schema";

export const getAppByRepoId = async (repoId: number, userId: string) => {
  return database.query.Apps.findFirst({
    where: { repoId, createdBy: userId },
    with: {
      project: true,
    },
  });
};

export const createApp = async (params: InferInsertModel<typeof Apps>) => {
  const [app] = await database.insert(Apps).values(params).returning();

  return app;
};

export const getUserApp = async (appId: number, userId: string) =>
  database.query.Apps.findFirst({
    where: { id: appId, createdBy: userId, resourceStatus: "active" },
    with: {
      project: true,
      appDomains: true,
      frameworkConfig: true,
      deployments: {
        with: { deploymentLogs: true },
      },
    },
  });

export const updateApp = async (
  appId: number,
  userId: string,
  params: Partial<
    Pick<InferSelectModel<typeof Apps>, "appName" | "resourceStatus">
  >,
) =>
  database
    .update(Apps)
    .set({ ...params, modifiedBy: userId })
    .where(eq(Apps.id, appId));
