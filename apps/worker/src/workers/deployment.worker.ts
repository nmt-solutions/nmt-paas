import { Worker } from "bullmq";
import {
  createDeploymentExecutor,
  type DeploymentRequest,
} from "../deployment/execute-deployment.js";

import { redis } from "@repo/redis";

import {
  getDeployment,
  updateDeployment,
} from "@repo/database/access-layer/deployment.dal";

import { createDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";

import {
  createBuilderContainer,
  executeCommand,
  getDocker,
} from "../services/docker.js";

import { getCloneUrl } from "../services/github.js";
import env from "../env/vars.js";
import { fetchEnvVars } from "../services/env-vars.js";
import { safeDiagnosticError } from "../services/diagnostics.js";

const executeDeployment = createDeploymentExecutor({
  getDeployment,
  updateDeployment,
  createDeploymentLogs,
  getDocker,
  createBuilderContainer,
  executeCommand,
  getCloneUrl,
  fetchEnvVars,
  registry: {
    username: env.variables.GITHUB_USER_NAME,
    password: env.variables.GITHUB_PAT,
  },
});

const worker = new Worker<DeploymentRequest>(
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
