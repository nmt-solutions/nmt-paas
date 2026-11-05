import { createDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";
import Docker from "dockerode";
import env from "../env/vars.js";
import os from "os";
import { createDockerCommandAdapter } from "../deployment/docker-command-adapter.js";

export const getDocker = async () => {
  const socketPath =
    os.platform() === "win32"
      ? "//./pipe/docker_engine"
      : "/var/run/docker.sock";

  const docker = new Docker({ socketPath });

  await docker.checkAuth({
    username: env.variables.GITHUB_USER_NAME,
    password: env.variables.GITHUB_PAT,
    serveraddress: "ghcr.io",
  });

  return docker;
};

export const { createBuilderContainer, executeCommand } =
  createDockerCommandAdapter({
    getDocker,
    createDeploymentLogs,
  });
