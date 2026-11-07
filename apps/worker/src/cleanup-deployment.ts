import { safeDiagnosticError } from "./services/diagnostics.js";

const [id, userId, ...extra] = process.argv.slice(2);
if (
  !id ||
  !/^[1-9]\d*$/.test(id) ||
  !Number.isSafeInteger(Number(id)) ||
  !userId?.trim() ||
  extra.length > 1 ||
  (extra.length === 1 && extra[0] !== "--status")
) {
  console.error(
    "Usage: npm run cleanup:deployment --workspace=worker -- <deployment-id> <owner-user-id> [--status]",
  );
  process.exitCode = 1;
} else {
  // Operator-only command: quiesce this host's worker as documented. Recovery
  // also shares retirement's per-app PostgreSQL lifecycle lock.
  let closePersistence: (() => Promise<void>) | undefined;
  try {
    const { database } = await import("@repo/database");
    closePersistence = async () => database.$client.end();
    if (extra[0] === "--status") {
      const { getRecordedDeploymentCleanup } =
        await import("@repo/database/access-layer/deployment.dal");
      const { withAppLifecycleLock } =
        await import("@repo/database/access-layer/app-retirement.dal");
      const recorded = await getRecordedDeploymentCleanup(Number(id), userId);
      if (!recorded) throw new Error("Deployment not found for cleanup owner");
      await withAppLifecycleLock(recorded.appId, async () => {
        const current = await getRecordedDeploymentCleanup(Number(id), userId);
        if (!current) throw new Error("Deployment not found for cleanup owner");
        console.log(
          JSON.stringify({
            deploymentId: Number(id),
            status: current.status,
            cleanup: current.cleanup,
          }),
        );
      });
    } else {
      const { executeDeployment } =
        await import("./deployment/production-executor.js");
      const result = await executeDeployment({
        userId,
        deploymentId: Number(id),
        operation: "cleanup",
      });
      console.log(
        `Deployment ${id}: cleanup ${result?.status ?? "unknown"}. Runtime-start outcome unchanged.`,
      );
      process.exitCode = result?.status === "complete" ? 0 : 2;
    }
  } catch (error) {
    console.error(safeDiagnosticError(error, "Cleanup recovery failed"));
    process.exitCode = 1;
  } finally {
    await closePersistence?.();
  }
}
