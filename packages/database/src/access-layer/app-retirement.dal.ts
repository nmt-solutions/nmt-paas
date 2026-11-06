import { and, eq } from "drizzle-orm";
import { database } from "..";
import { Client } from "pg";
import env from "../env/vars";
import { Apps } from "../schema";
import { retireAppVisibility } from "./retirement-visibility";

// A session lock spans host cleanup without holding a database transaction open.
// Execution takes the same lock, then reloads active eligibility before Docker.
export async function withAppLifecycleLock<T>(
  appId: number,
  operation: () => Promise<T>,
): Promise<T> {
  // Waiters use separate short-lived sessions so a request burst cannot
  // consume every application-pool slot needed by the lock holder's writes.
  const connection = new Client({ connectionString: env.databaseUrl });
  await connection.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(2121, $1)", [appId]);
    return await operation();
  } finally {
    // Closing the session releases its advisory lock, including on failures.
    await connection.end();
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
    await retireAppVisibility(tx, app, userId);
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
