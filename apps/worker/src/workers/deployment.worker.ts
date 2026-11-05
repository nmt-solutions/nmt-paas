import { Worker } from "bullmq";
import type { DeploymentRequest } from "../deployment/execute-deployment.js";
import { executeDeployment } from "../deployment/production-executor.js";
import { redis } from "@repo/redis";
import { safeDiagnosticError } from "../services/diagnostics.js";

export const worker = new Worker<DeploymentRequest>(
  "deployment-queue",

  async (job) => executeDeployment(job.data),

  {
    connection: redis as object,
    concurrency: 5,
  },
);

worker.on("error", (error) => {
  console.error("Deployment worker error:", safeDiagnosticError(error));
});

console.log("Deployment worker started");
