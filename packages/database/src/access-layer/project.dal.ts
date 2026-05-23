import { and, eq, InferInsertModel } from "drizzle-orm";
import { Projects } from "../schema";
import { database } from "..";
import { UpdateInput } from "../utils/types";

export const getProject = async (projectId: number) => {
  return database.query.Projects.findFirst({
    where: () => eq(Projects.id, projectId),
  });
};

export const getProjectByRepoId = async (repoId: number) => {
  return database.query.Projects.findFirst({
    where: () => eq(Projects.repoId, repoId),
  });
};

export const getUserProjects = async (userId: string) => {
  return database.query.Projects.findMany({
    where: () =>
      and(eq(Projects.userId, userId), eq(Projects.resourceStatus, "active")),
  });
};

export const createProject = async (
  params: InferInsertModel<typeof Projects>,
) => {
  const [project] = await database.insert(Projects).values(params).returning();

  return project;
};

export const updateProject = (
  params: UpdateInput<InferInsertModel<typeof Projects>, "id">,
  updatedBy: string,
) => {
  return database
    .update(Projects)
    .set({ ...params, modifiedBy: updatedBy, id: undefined })
    .where(eq(Projects.id, params.id));
};
