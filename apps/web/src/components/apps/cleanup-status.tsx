import type { DeploymentCleanup } from "@repo/database/schema";

export function CleanupStatus({
  cleanup,
  deploymentId,
}: {
  cleanup?: DeploymentCleanup | null;
  deploymentId?: number;
}) {
  if (!cleanup) return null;
  const pending = cleanup.artifacts.filter(
    (artifact) => artifact.status === "pending" || artifact.status === "failed",
  );
  return (
    <section
      aria-label="Deployment cleanup"
      className="glass-panel space-y-2 p-5"
    >
      <h2 className="font-semibold">
        {cleanup.status === "pending"
          ? "Cleanup incomplete"
          : "Cleanup complete"}{" "}
        · Deployment #{deploymentId}
      </h2>
      <p className="text-sm text-muted-foreground">
        {cleanup.status === "pending"
          ? `${pending.length} artifact${pending.length === 1 ? "" : "s"} awaiting cleanup. Ask an operator to retry cleanup without redeploying.`
          : "Tracked temporary and superseded artifacts have been resolved."}{" "}
        The container-start result is unchanged.
      </p>
      {pending
        .filter((artifact) => artifact.error)
        .map((artifact) => (
          <p
            key={`${artifact.kind}:${artifact.id}`}
            className="break-words text-sm text-muted-foreground"
          >
            {artifact.error}
          </p>
        ))}
    </section>
  );
}
