import { safeDiagnosticError } from "./services/diagnostics.js";

const [id, userId, ...extra] = process.argv.slice(2);
if (
  !id ||
  !/^[1-9]\d*$/.test(id) ||
  !Number.isSafeInteger(Number(id)) ||
  !userId?.trim() ||
  extra.length
) {
  console.error(
    "Usage: npm run cleanup:deployment --workspace=worker -- <deployment-id> <owner-user-id>",
  );
  process.exitCode = 1;
} else {
  // Operator-only command: stop this host's worker first. App locks are local
  // to one process; this command does not acquire a distributed worker lock.
  let closePersistence: (() => Promise<void>) | undefined;
  try {
    const { database } = await import("@repo/database");
    closePersistence = async () => database.$client.end();
    const { executeDeployment } =
      await import("./deployment/production-executor.js");
    const result = await executeDeployment({
      userId,
      deploymentId: Number(id),
      action: "cleanup",
    });
    console.log(
      `Deployment ${id}: cleanup ${result?.status ?? "unknown"}. Runtime-start outcome unchanged.`,
    );
    process.exitCode = result?.status === "complete" ? 0 : 2;
  } catch (error) {
    console.error(safeDiagnosticError(error, "Cleanup recovery failed"));
    process.exitCode = 1;
  } finally {
    await closePersistence?.();
  }
}
