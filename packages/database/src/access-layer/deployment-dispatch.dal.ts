import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { database } from "..";
import { Apps, DeploymentDispatches, Deployments, Projects } from "../schema";

export type Submission = {
  userId: string;
  submissionId: string;
  requestHash: string;
};
export type AdmissionTransaction = Parameters<
  Parameters<typeof database.transaction>[0]
>[0];
type Reader = Pick<typeof database, "select">;

export class SubmissionConflict extends Error {
  constructor() {
    super("Submission identity was already used for a different request.");
  }
}

export async function getDeploymentSubmission(
  userId: string,
  submissionId: string,
  reader: Reader = database,
) {
  const [result] = await reader
    .select({
      dispatch: DeploymentDispatches,
      deployment: Deployments,
      app: Apps,
      project: Projects,
    })
    .from(DeploymentDispatches)
    .innerJoin(
      Deployments,
      eq(Deployments.id, DeploymentDispatches.deploymentId),
    )
    .innerJoin(Apps, eq(Apps.id, Deployments.appId))
    .innerJoin(Projects, eq(Projects.id, Apps.projectId))
    .where(
      and(
        eq(DeploymentDispatches.userId, userId),
        eq(DeploymentDispatches.submissionId, submissionId),
      ),
    );
  return result;
}

export async function getAppDispatches(appId: number, userId: string) {
  return database
    .select({
      deploymentId: DeploymentDispatches.deploymentId,
      submissionId: DeploymentDispatches.submissionId,
      state: DeploymentDispatches.state,
      attempts: DeploymentDispatches.attempts,
      nextAttemptAt: DeploymentDispatches.nextAttemptAt,
      leaseUntil: DeploymentDispatches.leaseUntil,
    })
    .from(DeploymentDispatches)
    .innerJoin(
      Deployments,
      eq(Deployments.id, DeploymentDispatches.deploymentId),
    )
    .where(
      and(
        eq(DeploymentDispatches.userId, userId),
        eq(Deployments.appId, appId),
      ),
    )
    .orderBy(sql`${DeploymentDispatches.deploymentId} DESC`)
    .limit(100);
}

export async function lockDeploymentSubmission(
  tx: AdmissionTransaction,
  submission: Submission,
) {
  // Serializes duplicate admissions only; no network operation runs in this tx.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([submission.userId, submission.submissionId])}, 0))`,
  );
  const existing = await getDeploymentSubmission(
    submission.userId,
    submission.submissionId,
    tx,
  );
  if (existing && existing.dispatch.requestHash !== submission.requestHash)
    throw new SubmissionConflict();
  return existing;
}

export async function recordDeploymentDispatch(
  tx: AdmissionTransaction,
  submission: Submission,
  deploymentId: number,
) {
  await tx.insert(DeploymentDispatches).values({ ...submission, deploymentId });
}

export async function admitDeployment(
  params: typeof Deployments.$inferInsert,
  submission: Submission,
) {
  return database.transaction(async (tx) => {
    const existing = await lockDeploymentSubmission(tx, submission);
    if (existing) return existing.deployment;
    const [deployment] = await tx
      .insert(Deployments)
      .values(params)
      .returning();
    if (!deployment) throw new Error("Deployment creation failed");
    await recordDeploymentDispatch(tx, submission, deployment.id);
    return deployment;
  });
}

export async function claimPendingDispatches(deploymentId?: number) {
  // One short statement commits the lease before the HTTP handoff. Expiry
  // recovers a dispatcher killed between the handoff and confirmation.
  const candidates = database
    .select({ deploymentId: DeploymentDispatches.deploymentId })
    .from(DeploymentDispatches)
    .where(
      and(
        eq(DeploymentDispatches.state, "pending"),
        lte(DeploymentDispatches.nextAttemptAt, sql`now()`),
        or(
          isNull(DeploymentDispatches.leaseUntil),
          lte(DeploymentDispatches.leaseUntil, sql`now()`),
        ),
        deploymentId === undefined
          ? undefined
          : eq(DeploymentDispatches.deploymentId, deploymentId),
      ),
    )
    .orderBy(DeploymentDispatches.nextAttemptAt)
    .limit(10)
    .for("update", { skipLocked: true });
  return database
    .update(DeploymentDispatches)
    .set({
      lease: randomUUID(),
      leaseUntil: sql`now() + interval '30 seconds'`,
      attempts: sql`${DeploymentDispatches.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(DeploymentDispatches.deploymentId, candidates))
    .returning();
}

export async function finishDispatch(
  dispatch: typeof DeploymentDispatches.$inferSelect,
  state: "pending" | "dispatched" | "rejected",
) {
  if (!dispatch.lease) return;
  await database
    .update(DeploymentDispatches)
    .set({
      state,
      lease: null,
      leaseUntil: null,
      nextAttemptAt: sql`now() + interval '5 seconds'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(DeploymentDispatches.deploymentId, dispatch.deploymentId),
        eq(DeploymentDispatches.lease, dispatch.lease),
      ),
    );
}
