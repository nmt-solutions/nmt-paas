import { and, asc, desc, eq, gt, lt, sql, InferInsertModel } from "drizzle-orm";
import { DeploymentLogs as DL } from "../schema";
import { database } from "..";

import { DeploymentLogs } from "../tables/deployment";
import { activeAppEligibility } from "./app-eligibility";
import { DEPLOYMENT_LOG_MESSAGE_CHARACTERS } from "./deployment-log-limits";

export const readDeploymentLogs = async (input: {
  appId: number;
  deploymentId: number;
  userId: string;
  limit: number;
  before?: number;
  after?: number;
}) => {
  const deployment = await database.query.Deployments.findFirst({
    columns: { id: true },
    where: {
      id: input.deploymentId,
      appId: input.appId,
      createdBy: input.userId,
      userId: input.userId,
      resourceStatus: "active",
      app: activeAppEligibility(input.userId),
    },
  });
  if (!deployment) return undefined;
  const rows = await database
    .select({
      id: DeploymentLogs.id,
      message: sql<string>`left(${DeploymentLogs.message}, ${DEPLOYMENT_LOG_MESSAGE_CHARACTERS})`,
      truncated: sql<boolean>`length(${DeploymentLogs.message}) > ${DEPLOYMENT_LOG_MESSAGE_CHARACTERS}`,
    })
    .from(DeploymentLogs)
    .where(
      and(
        eq(DeploymentLogs.deploymentId, deployment.id),
        // Record creators include builder/runtime identities. Ownership is
        // established by the eligible deployment above, not log provenance.
        eq(DeploymentLogs.resourceStatus, "active"),
        input.before === undefined
          ? undefined
          : lt(DeploymentLogs.id, input.before),
        input.after === undefined
          ? undefined
          : gt(DeploymentLogs.id, input.after),
      ),
    )
    .orderBy(
      input.after === undefined
        ? desc(DeploymentLogs.id)
        : asc(DeploymentLogs.id),
    )
    .limit(input.limit + 1);
  const logs = rows.slice(0, input.limit);
  if (input.after === undefined) logs.reverse();
  return {
    logs,
    hasMore: rows.length > input.limit,
    oldestCursor: logs[0]?.id ?? null,
    newestCursor: logs.at(-1)?.id ?? null,
  };
};

export const createDeploymentLogs = async (
  params: InferInsertModel<typeof DL>,
) => {
  return database.insert(DeploymentLogs).values({
    deploymentId: params.deploymentId,
    message: params.message,
    createdBy: params.createdBy,
  });
};
