import { and, eq } from "drizzle-orm";
import type { database } from "..";
import { Apps, AppDomains, Deployments } from "../schema";

type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
type RetirementApp = Pick<
  typeof Apps.$inferSelect,
  "id" | "createdBy" | "resourceStatus" | "retirement"
>;

// Callers authorize the workflow and hold its lifecycle locks. Keep this child
// transition in their transaction so a failed child/write/commit rolls back all
// visibility, while retries retain an already pending or complete outcome.
export async function retireAppVisibility(
  tx: Transaction,
  app: RetirementApp,
  userId: string,
) {
  if (app.resourceStatus === "inactive" && app.retirement !== null) return;
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
    .where(and(eq(Apps.id, app.id), eq(Apps.createdBy, app.createdBy)));
  await tx
    .update(AppDomains)
    .set({ resourceStatus: "inactive", modifiedBy: userId })
    .where(eq(AppDomains.appId, app.id));
  await tx
    .update(Deployments)
    .set({ resourceStatus: "inactive", modifiedBy: userId })
    .where(eq(Deployments.appId, app.id));
}
