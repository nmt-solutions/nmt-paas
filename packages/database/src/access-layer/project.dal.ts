import { eq, InferInsertModel } from "drizzle-orm";
import { database } from "..";
import { Projects } from "../schema";
import { UpdateInput } from "../utils/types";

export const getProject = async (projectId: number) => {
  return database.query.Projects.findFirst({
    where: { id: projectId },
  });
};

export const getUserProjects = async (userId: string) => {
  return database.query.Projects.findMany({
    where: { userId, resourceStatus: "active" },
    with: {
      apps: {
        with: {
          appDomains: true,
          deployments: true,
        },
      },
    },
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
