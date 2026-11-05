import { and, eq } from "drizzle-orm";
import { database } from "..";
import { Apps, AppDomains, Deployments } from "../schema";

// A session lock spans host cleanup without holding a database transaction open.
// Execution takes the same lock, then reloads active eligibility before Docker.
export async function withAppLifecycleLock<T>(
  appId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await database.$client.connect();
  let destroy = true;
  try {
    await connection.query("SELECT pg_advisory_lock(2121, $1)", [appId]);
    destroy = false;
    try {
      return await operation();
    } finally {
      try {
        await connection.query("SELECT pg_advisory_unlock(2121, $1)", [appId]);
      } catch {
        // A broken session must never return to the pool holding this lock.
        destroy = true;
      }
    }
  } finally {
    connection.release(destroy);
  }
}

export const getOwnedAppRetirement = (appId: number, userId: string) =>
  database.query.Apps.findFirst({
    where: { id: appId, createdBy: userId, project: { userId } },
    columns: {
      id: true,
      appName: true,
      resourceStatus: true,
      retirement: true,
    },
  });

export async function deactivateOwnedApp(appId: number, userId: string) {
  return database.transaction(async (tx) => {
    const app = await tx.query.Apps.findFirst({
      where: { id: appId, createdBy: userId, project: { userId } },
    });
    if (!app) return undefined;
    if (app.resourceStatus === "active" || app.retirement === null) {
      await tx
        .update(Apps)
        .set({
          resourceStatus: "inactive",
          modifiedBy: userId,
          retirement: {
            status: "pending",
            message: "Runtime cleanup pending. Retry cleanup to recover.",
          },
        })
        .where(and(eq(Apps.id, appId), eq(Apps.createdBy, userId)));
      await tx
        .update(AppDomains)
        .set({ resourceStatus: "inactive", modifiedBy: userId })
        .where(eq(AppDomains.appId, appId));
      await tx
        .update(Deployments)
        .set({ resourceStatus: "inactive", modifiedBy: userId })
        .where(eq(Deployments.appId, appId));
    }
    return tx.query.Deployments.findMany({
      where: { appId, userId, createdBy: userId },
      columns: { id: true },
    });
  });
}

export const saveAppRetirementCleanup = (
  appId: number,
  userId: string,
  complete: boolean,
) =>
  database
    .update(Apps)
    .set({
      retirement: complete
        ? { status: "complete", message: "Owned runtime cleanup complete." }
        : {
            status: "pending",
            message: "Runtime cleanup incomplete. Retry cleanup to recover.",
          },
      modifiedBy: userId,
    })
    .where(
      and(
        eq(Apps.id, appId),
        eq(Apps.createdBy, userId),
        eq(Apps.resourceStatus, "inactive"),
      ),
    );
