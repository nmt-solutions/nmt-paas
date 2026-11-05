import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import env from "./env/vars";

const connection = new IORedis({
  host: env.variables.REDIS_HOST,
  port: env.variables.REDIS_PORT,
  password: env.variables.REDIS_PASSWORD,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 1000,
  commandTimeout: 1500,
});

type DeploymentPayload = {
  userId: string;
  deploymentId: number;
  operation?: "publish";
};

export class DeploymentEnqueueConflict extends Error {
  constructor() {
    super("Deployment is already queued with a different payload.");
  }
}

const deploymentQueue = new Queue<DeploymentPayload>("deployment-queue", {
  connection: connection as object,

  defaultJobOptions: {
    attempts: 3,

    backoff: {
      type: "exponential",
      delay: 2000,
    },

    removeOnComplete: 100,

    removeOnFail: 1000,
  },
});

deploymentQueue.on("error", () => {
  console.error("Deployment queue Redis connection is unavailable.");
});

export async function enqueueDeployment(data: DeploymentPayload) {
  // HTTP producers fail promptly during outages. Workers retain their separate
  // indefinite reconnect policy in @repo/redis.
  if (connection.status !== "ready") {
    throw new Error("Deployment queue is unavailable.");
  }
  // Encode the numeric value, not its JSON spelling. Go uses the same IEEE-754
  // bits, including for fractional/exponent values allowed by the HTTP schema.
  const identity = Buffer.alloc(8);
  identity.writeDoubleBE(data.deploymentId + 0); // Normalize negative zero.
  const job = await deploymentQueue.add("deployment-queue", data, {
    jobId: `deployment-${identity.toString("hex")}`,
  });
  // BullMQ atomically retains the first payload for a custom job ID. Its add()
  // result contains the submitted data even for a duplicate, so read the actual
  // retained record before acknowledging a retry.
  const retained = await deploymentQueue.getJob(job.id!);
  if (!retained) throw new Error("Deployment queue is unavailable.");
  if (
    retained.name !== "deployment-queue" ||
    retained.data.userId !== data.userId ||
    retained.data.deploymentId !== data.deploymentId
  ) {
    throw new DeploymentEnqueueConflict();
  }
  return retained;
}

export async function enqueuePublication(data: {
  userId: string;
  deploymentId: number;
}) {
  if (connection.status !== "ready")
    throw new Error("Deployment queue is unavailable.");
  // Explicit recovery is separate work from a retained deployment delivery.
  // Repeated recovery is safe: the executor serializes by app and checks the
  // persisted publication result before contacting the registry.
  return deploymentQueue.add(
    "deployment-queue",
    { ...data, operation: "publish" },
    {
      jobId: `publication-${randomUUID()}`,
    },
  );
}
