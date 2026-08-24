import { Queue } from "bullmq";

import { redis } from "@repo/redis";

export const deploymentQueue = new Queue<{
  userId: string;
  deploymentId: number;
}>("deployment-queue", {
  connection: redis as object,

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
