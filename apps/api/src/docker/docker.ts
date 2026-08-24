import os from "node:os";
import Docker from "dockerode";

export const docker = new Docker({
  socketPath:
    os.platform() === "win32"
      ? "//./pipe/docker_engine"
      : "/var/run/docker.sock",
});

export const getDeploymentContainer = (deploymentId: number) =>
  docker.getContainer(`deployment-${deploymentId}`);
