import type Docker from "dockerode";
import type { DeploymentExecutionDependencies } from "./execute-deployment.js";

/** Production Docker commands with only Docker and log storage as dependencies. */
export const createDockerCommandAdapter = ({
  getDocker,
  createDeploymentLogs,
}: Pick<
  DeploymentExecutionDependencies,
  "getDocker" | "createDeploymentLogs"
>) => {
  async function createBuilderContainer(
    deploymentId: number,
  ): Promise<Docker.Container> {
    // Create container from base image

    const docker = await getDocker();

    await new Promise((resolve, reject) => {
      docker.pull(
        "node:22-alpine",
        (err: object, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);

          docker.modem.followProgress(stream, (err) =>
            err ? reject(err) : resolve(undefined),
          );
        },
      );
    });

    const container = await docker.createContainer({
      Image: "node:22-alpine",
      Cmd: ["tail", "-f", "/dev/null"],
      Tty: true,
      WorkingDir: "/app",
      name: `builder-${deploymentId}`,
    });

    await container.start();

    await executeCommand(container, [
      "sh",
      "-c",
      "apk add --no-cache git docker-cli bash",
    ]);

    return container;
  }

  async function executeCommand(
    container: Docker.Container,
    command: string[],
    workingDir?: string,
  ) {
    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workingDir,
    });

    const stream = await exec.start({
      hijack: true,
    });

    const details = await container.inspect();
    const containerName = details.Name;
    const deploymentId = Number(containerName.replace("/builder-", ""));

    stream.on("data", async (chunk: Buffer) => {
      const message = chunk.toString("utf8").replace(/\0/g, "");

      console.log(message);

      await createDeploymentLogs({
        deploymentId,
        message,
        createdBy: containerName,
      });
    });

    await new Promise((resolve) => {
      stream.on("end", resolve);
    });

    const result = await exec.inspect();

    if (result.ExitCode !== 0) {
      const message = `Command failed: ${command.join(" ")}`;
      console.error();
      createDeploymentLogs({
        deploymentId,
        message,
        createdBy: containerName,
      });
      throw new Error(message);
    }
  }
  return { createBuilderContainer, executeCommand };
};
