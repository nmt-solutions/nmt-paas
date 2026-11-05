import { withAppLifecycleLock } from "@repo/database/access-layer/app-retirement.dal";
import { createDeploymentExecutor } from "./execute-deployment.js";
import {
  getDeployment,
  updateDeployment,
  saveDeploymentCleanup,
} from "@repo/database/access-layer/deployment.dal";
import { createDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";
import {
  createBuilderContainer,
  executeCommand,
  getDocker,
  getLocalDocker,
} from "../services/docker.js";
import { getCloneUrl } from "../services/github.js";
import { fetchEnvVars } from "../services/env-vars.js";
import env from "../env/vars.js";

// One instance per process shares app coordination for execution and recovery.
// Importing this adapter does not register a queue consumer.
export const executeDeployment = createDeploymentExecutor({
  withAppLifecycleLock,
  getDeployment,
  updateDeployment,
  saveDeploymentCleanup,
  createDeploymentLogs,
  getDocker,
  getCleanupDocker: async () => getLocalDocker(),
  createBuilderContainer,
  executeCommand,
  getCloneUrl,
  fetchEnvVars,
  registry: {
    username: env.variables.GITHUB_USER_NAME,
    password: env.variables.GITHUB_PAT,
  },
});
