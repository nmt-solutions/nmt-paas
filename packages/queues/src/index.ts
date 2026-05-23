import { Queue } from "bullmq";

import { redis } from "@repo/redis";

export const deploymentQueue = new Queue<{ deploymentId: number }>(
  "deployment-queue",
  {
    connection: redis,

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 2000,
      },

      removeOnComplete: 100,

      removeOnFail: 1000,
    },
  },
);
