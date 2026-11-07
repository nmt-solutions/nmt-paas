import { createDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";
import Docker from "dockerode";
import os from "os";
import { createDockerCommandAdapter } from "../deployment/docker-command-adapter.js";

export const getLocalDocker = () => {
  const socketPath =
    os.platform() === "win32"
      ? "//./pipe/docker_engine"
      : "/var/run/docker.sock";

  return new Docker({ socketPath });
};

export const getDocker = async () => {
  // Local acquisition/adoption never authenticates against a registry.
  // publishImage supplies registry authentication only when pushing an image.
  return getLocalDocker();
};

export const { createBuilderContainer, executeCommand } =
  createDockerCommandAdapter({
    getDocker,
    createDeploymentLogs,
  });
