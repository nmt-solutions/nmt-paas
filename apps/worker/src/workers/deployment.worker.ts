import { Worker } from "bullmq";

import { redis } from "@repo/redis";
import { getDeployment } from "@repo/database/access-layer/deployment.dal";

new Worker(
  "deployment-queue",

  async (job: { data: { deploymentId: number } }) => {
    console.log(job);

    const deploymentId = job.data.deploymentId;

    const deployment = await getDeployment(deploymentId);

    if (!deployment) {
      throw new Error("Deployment not found");
    }

    console.log(deployment.id);

    for (let i = 0; i < 20; i++) {
      const result = await new Promise((res) =>
        setTimeout(() => res(`Step ${i + 1}`), 1000),
      );

      console.log(result);
    }

    console.log("Deployment Success.");
  },

  {
    connection: redis as any,

    concurrency: 5,
  },
);
