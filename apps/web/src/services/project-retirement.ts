import "server-only";
import { TRPCError } from "@trpc/server";
import {
  deactivateOwnedProject,
  getOwnedProjectRetirement,
  getOwnedRetiredProjects,
} from "@repo/database/access-layer/project-retirement.dal";

function outcome(
  project: NonNullable<Awaited<ReturnType<typeof getOwnedProjectRetirement>>>,
  userId: string,
) {
  const complete = project.apps.every(
    (app) =>
      app.resourceStatus === "inactive" &&
      app.retirement?.status === "complete",
  );
  return {
    ...project,
    // A manually linked foreign child cannot grant access through its parent.
    // Keep it in the completion check, but never expose its identity/outcome.
    apps: project.apps
      .filter((app) => app.createdBy === userId)
      .map((app) => ({
        id: app.id,
        appName: app.appName,
        resourceStatus: app.resourceStatus,
        retirement: app.retirement,
      })),
    retirement:
      project.resourceStatus === "active"
        ? null
        : {
            status: complete ? ("complete" as const) : ("pending" as const),
            message: complete
              ? "Owned runtime cleanup complete for every app."
              : "Runtime cleanup incomplete. Retry cleanup to recover unfinished apps.",
          },
  };
}

export async function retiredProjects(userId: string) {
  return (await getOwnedRetiredProjects(userId)).map((project) =>
    outcome(project, userId),
  );
}

export async function projectRetirementStatus(
  projectId: number,
  userId: string,
) {
  const project = await getOwnedProjectRetirement(projectId, userId);
  if (!project)
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return outcome(project, userId);
}

export async function retireProject(projectId: number, userId: string) {
  await projectRetirementStatus(projectId, userId);
  let appIds: number[] | undefined;
  try {
    appIds = await deactivateOwnedProject(projectId, userId);
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to retire project. Check its status before retrying.",
    });
  }
  if (!appIds)
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  // Visibility is committed and all multi-app locks are released before calling
  // app retirement, which takes its own lock and owns host/outcome recovery.
  for (const appId of appIds) {
    try {
      const { retireApp } = await import("./apps");
      await retireApp(appId, userId);
    } catch {
      // One failed host acknowledgement or outcome write cannot skip siblings.
      // Its committed pending state remains available for a fresh owner retry.
    }
  }
  return projectRetirementStatus(projectId, userId);
}
