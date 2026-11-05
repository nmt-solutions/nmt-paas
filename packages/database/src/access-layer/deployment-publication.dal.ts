import { and, eq } from "drizzle-orm";
import { database } from "..";
import { Apps, DeploymentPublications, Deployments, Projects } from "../schema";

// Publication access is scoped independently of host-wide Docker administration.
export async function getPublicationDeployment(
  deploymentId: number,
  userId: string,
  administrator = false,
) {
  const [record] = await database
    .select({
      deploymentId: Deployments.id,
      userId: Deployments.userId,
      status: Deployments.status,
      publication: DeploymentPublications,
    })
    .from(Deployments)
    .innerJoin(Apps, eq(Apps.id, Deployments.appId))
    .innerJoin(Projects, eq(Projects.id, Apps.projectId))
    .leftJoin(
      DeploymentPublications,
      eq(DeploymentPublications.deploymentId, Deployments.id),
    )
    .where(
      and(
        eq(Deployments.id, deploymentId),
        eq(Deployments.resourceStatus, "active"),
        eq(Apps.resourceStatus, "active"),
        eq(Projects.resourceStatus, "active"),
        ...(administrator
          ? []
          : [
              eq(Deployments.userId, userId),
              eq(Apps.createdBy, userId),
              eq(Projects.userId, userId),
            ]),
      ),
    );
  return record;
}

export async function getPublication(deploymentId: number, userId: string) {
  return (
    (await getPublicationDeployment(deploymentId, userId))?.publication ??
    undefined
  );
}

export async function recordPublication(
  image: { deploymentId: number; imageId: string; imageName: string },
  userId: string,
) {
  if (!(await getPublicationDeployment(image.deploymentId, userId)))
    throw new Error("Publication not found");
  await database
    .insert(DeploymentPublications)
    .values(image)
    .onConflictDoNothing();
  const record = await getPublication(image.deploymentId, userId);
  if (
    !record ||
    record.imageId !== image.imageId ||
    record.imageName !== image.imageName
  )
    throw new Error("Publication image identity changed");
}

export async function updatePublication(
  deploymentId: number,
  state: {
    status: "pending" | "publishing" | "published" | "failed";
    lastError: string | null;
  },
  userId: string,
) {
  if (!(await getPublication(deploymentId, userId)))
    throw new Error("Publication not found");
  await database
    .update(DeploymentPublications)
    .set({ ...state, updatedAt: new Date() })
    .where(eq(DeploymentPublications.deploymentId, deploymentId));
}
