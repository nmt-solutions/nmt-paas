import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import {
  claimPendingDispatches,
  finishDispatch,
  getDeploymentSubmission,
  SubmissionConflict,
  type Submission,
} from "@repo/database/access-layer/deployment-dispatch.dal";
import { TRPCError } from "@trpc/server";
import cpApiClient from "./cp-api-client";
import env from "@/env/vars";

export function deploymentSubmission(
  userId: string,
  submissionId: string | undefined,
  request: unknown,
): Submission {
  return {
    userId,
    submissionId: submissionId ?? randomUUID(),
    requestHash: createHmac("sha256", env.variables.ENV_ENCRYPTION_KEY)
      .update(JSON.stringify(request))
      .digest("hex"),
  };
}

export async function existingSubmission(submission: Submission) {
  const existing = await getDeploymentSubmission(
    submission.userId,
    submission.submissionId,
  );
  if (existing && existing.dispatch.requestHash !== submission.requestHash)
    throw admissionError(new SubmissionConflict());
  return existing;
}

export function admissionError(
  error: unknown,
  message = "Unable to save deployment. Retry using the same submission identity.",
) {
  return error instanceof SubmissionConflict
    ? new TRPCError({ code: "CONFLICT", message: error.message })
    : new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

export async function dispatchSubmission(submission: Submission) {
  const accepted = await getDeploymentSubmission(
    submission.userId,
    submission.submissionId,
  );
  if (!accepted)
    throw new TRPCError({ code: "NOT_FOUND", message: "Submission not found" });
  await recoverPendingDispatches(accepted.deployment.id).catch(() => undefined);
  // Confirmation persistence can fail after enqueue. Read only durable state;
  // the lease will expire and the existing producer identity deduplicates retry.
  const current = await getDeploymentSubmission(
    submission.userId,
    submission.submissionId,
  ).catch(() => undefined);
  return submissionResult(current ?? accepted);
}

export function submissionResult(
  accepted: NonNullable<Awaited<ReturnType<typeof getDeploymentSubmission>>>,
) {
  const state = accepted.dispatch.state;
  return {
    submissionId: accepted.dispatch.submissionId,
    deploymentId: accepted.deployment.id,
    appId: accepted.app.id,
    projectId: accepted.project.id,
    branch: accepted.deployment.branch,
    outcome:
      state === "dispatched"
        ? ("accepted" as const)
        : state === "rejected"
          ? ("rejected" as const)
          : ("uncertain" as const),
    dispatchState: state,
    attempts: accepted.dispatch.attempts,
    nextAttemptAt:
      state === "pending"
        ? (accepted.dispatch.leaseUntil ?? accepted.dispatch.nextAttemptAt)
        : null,
    message:
      state === "dispatched"
        ? "Deployment queued"
        : state === "rejected"
          ? "The deployment host rejected dispatch. This deployment was saved; contact the operator before starting a new submission."
          : "Deployment saved; queue confirmation pending. Automatic recovery will retry.",
  };
}

async function recoverPendingDispatches(deploymentId?: number) {
  const claimed = await claimPendingDispatches(deploymentId);
  await Promise.all(
    claimed.map(async (dispatch) => {
      let state: "pending" | "dispatched" | "rejected" = "pending";
      try {
        const response = await cpApiClient.queueDeployment(
          dispatch.deploymentId,
          dispatch.userId,
        );
        if (response.status === "success" && response.data === true)
          state = "dispatched";
        else if (
          response.status === "error" &&
          [400, 409, 422].includes(response.statusCode)
        )
          state = "rejected";
      } catch {
        /* HTTP loss is not proof that the job was never queued. */
      }
      // Never persist or log raw provider errors, commands, headers or bodies.
      await finishDispatch(dispatch, state);
    }),
  );
}

const recoveryGlobal = globalThis as typeof globalThis & {
  deploymentDispatchRecoveryStarted?: boolean;
};
export function startDeploymentDispatchRecovery() {
  if (recoveryGlobal.deploymentDispatchRecoveryStarted) return;
  recoveryGlobal.deploymentDispatchRecoveryStarted = true;
  const tick = async () => {
    try {
      await recoverPendingDispatches();
    } catch {
      console.warn(
        "Deployment dispatch recovery is unavailable; saved intents will be retried.",
      );
    } finally {
      setTimeout(() => {
        void tick();
      }, 5_000).unref();
    }
  };
  void tick();
}
