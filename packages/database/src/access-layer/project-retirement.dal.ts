import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { database } from "..";
import env from "../env/vars";
import { Projects } from "../schema";
import { retireAppVisibility } from "./retirement-visibility";

const retirementSelection = {
  columns: { id: true, name: true, resourceStatus: true },
  with: {
    apps: {
      columns: {
        id: true,
        appName: true,
        createdBy: true,
        resourceStatus: true,
        retirement: true,
      },
      orderBy: { id: "asc" as const },
    },
  },
} as const;

export const getOwnedProjectRetirement = (projectId: number, userId: string) =>
  database.query.Projects.findFirst({
    where: { id: projectId, userId, createdBy: userId },
    ...retirementSelection,
  });

export const getOwnedRetiredProjects = (userId: string) =>
  database.query.Projects.findMany({
    where: { userId, createdBy: userId, resourceStatus: "inactive" },
    orderBy: { id: "desc" },
    ...retirementSelection,
  });

/** Project lock first, then ascending app locks, all on one dedicated session.
 * App execution/retirement never takes a project lock. No pool slot is held by
 * a waiter and no transaction is open while waiting for in-flight execution. */
export async function deactivateOwnedProject(
  projectId: number,
  userId: string,
) {
  const connection = new Client({ connectionString: env.databaseUrl });
  await connection.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(2222, $1)", [projectId]);
    const { rows: lockedApps } = await connection.query<{ id: number }>(
      'SELECT a.id FROM "Apps" a JOIN "Projects" p ON p.id = a."projectId" WHERE p.id = $1 AND p."userId" = $2 AND p."createdBy" = $2 ORDER BY a.id',
      [projectId, userId],
    );
    for (const app of lockedApps)
      await connection.query("SELECT pg_advisory_lock(2121, $1)", [app.id]);

    return await database.transaction(async (tx) => {
      const project = await tx.query.Projects.findFirst({
        where: { id: projectId, userId, createdBy: userId },
        with: { apps: { orderBy: { id: "asc" } } },
      });
      if (!project) return undefined;
      // No current workflow adds apps to an existing project. If that changes,
      // refuse an unlocked child rather than racing its execution.
      if (
        project.apps.length !== lockedApps.length ||
        project.apps.some((app, index) => app.id !== lockedApps[index]?.id)
      )
        throw new Error("Project membership changed; retry retirement");
      if (project.resourceStatus === "active")
        await tx
          .update(Projects)
          .set({ resourceStatus: "inactive", modifiedBy: userId })
          .where(and(eq(Projects.id, projectId), eq(Projects.userId, userId)));
      for (const app of project.apps) {
        await retireAppVisibility(tx, app, userId);
      }
      return project.apps.map((app) => app.id);
    });
  } finally {
    // Release every acquired project/app lock even on failed commit or wait.
    await connection.end();
  }
}
