import "server-only";
import { TRPCError } from "@trpc/server";
import {
  deactivateOwnedApp,
  getOwnedAppRetirement,
  saveAppRetirementCleanup,
  withAppLifecycleLock,
} from "@repo/database/access-layer/app-retirement.dal";
import cpApiClient from "./cp-api-client";

export async function retirementStatus(appId: number, userId: string) {
  const app = await getOwnedAppRetirement(appId, userId);
  if (!app)
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  return app;
}

export async function retireApp(appId: number, userId: string) {
  // Reject foreign IDs before taking an app lock or contacting the host.
  await retirementStatus(appId, userId);
  return withAppLifecycleLock(appId, async () => {
    const app = await retirementStatus(appId, userId);
    if (app.retirement?.status === "complete") return app;
    const deployments = await deactivateOwnedApp(appId, userId);
    if (!deployments)
      throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
    let complete = false;
    try {
      complete = await cpApiClient.retireApp(
        appId,
        deployments.map((deployment) => deployment.id),
      );
    } catch {
      // Raw HTTP/Docker errors can contain server credentials. Persist a safe,
      // actionable outcome; retirement remains effective if the host is offline.
    }
    await saveAppRetirementCleanup(appId, userId, complete);
    return retirementStatus(appId, userId);
  });
}
