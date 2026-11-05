import { Queue } from "bullmq";
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
};

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
  return deploymentQueue.add("deployment-queue", data);
}
