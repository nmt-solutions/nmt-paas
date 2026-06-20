import { eq, InferInsertModel } from "drizzle-orm";
import { database } from "..";
import { Apps } from "../schema";

export const getAppByRepoId = async (repoId: number) => {
  return database.query.Apps.findFirst({
    where: eq(Apps.repoId, repoId),
    with: {
      project: true,
    },
  });
};

export const createApp = async (params: InferInsertModel<typeof Apps>) => {
  const [app] = await database.insert(Apps).values(params).returning();

  return app;
};
