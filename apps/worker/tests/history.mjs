import assert from "node:assert/strict";

// Keep all earlier diagnostic/outcome assertions when migrating fixture reads
// from eager app details to the same bounded owner-facing history interface.
export async function readHistoryLogs(appId, deploymentId, userId) {
  const { readDeploymentLogs } =
    await import("@repo/database/access-layer/deployment-logs.dal");
  const logs = [];
  let after = 0;
  for (;;) {
    const page = await readDeploymentLogs({
      appId,
      deploymentId,
      userId,
      after,
      limit: 100,
    });
    assert.ok(
      page,
      "The fixture deployment must remain accessible to its owner",
    );
    assert.ok(
      page.logs.every((log) => !log.truncated),
      "Fixture assertions require complete diagnostic messages",
    );
    logs.push(...page.logs);
    if (!page.hasMore) return logs;
    after = page.newestCursor;
  }
}
