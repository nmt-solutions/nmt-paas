import { eq, InferInsertModel, InferSelectModel } from "drizzle-orm";
import { database } from "..";
import { Apps } from "../schema";
import { activeAppEligibility } from "./app-eligibility";

export const getActiveApp = (appId: number, userId: string) =>
  database.query.Apps.findFirst({
    where: { id: appId, ...activeAppEligibility(userId) },
  });

export const getAppByRepoId = async (repoId: number, userId: string) => {
  return database.query.Apps.findFirst({
    where: { repoId, ...activeAppEligibility(userId) },
    with: {
      project: true,
    },
  });
};

/** Distinguish an owner's retired link from a repository they have never imported. */
export const hasUserAppForRepo = async (repoId: number, userId: string) =>
  Boolean(
    await database.query.Apps.findFirst({
      columns: { id: true },
      where: { repoId, createdBy: userId },
    }),
  );

export const createApp = async (params: InferInsertModel<typeof Apps>) => {
  const [app] = await database.insert(Apps).values(params).returning();

  return app;
};

export const getUserApp = async (appId: number, userId: string) =>
  database.query.Apps.findFirst({
    where: { id: appId, ...activeAppEligibility(userId) },
    with: {
      project: true,
      appDomains: true,
      frameworkConfig: true,
      deployments: {
        with: { deploymentLogs: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

export const getAppLatestDeployment = async (appId: number, userId: string) => {
  return database.query.Deployments.findFirst({
    where: {
      appId: appId,
      createdBy: userId,
      userId,
      resourceStatus: "active",
      app: activeAppEligibility(userId),
      status: "success",
    },
    orderBy: { createdAt: "desc" },
  });
};

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
