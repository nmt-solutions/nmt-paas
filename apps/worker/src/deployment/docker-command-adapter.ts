import type Docker from "dockerode";
import {
  DiagnosticOutput,
  safeDiagnosticError,
} from "../services/diagnostics.js";
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
    onAcquired: (container: Docker.Container) => void = () => {},
  ): Promise<Docker.Container> {
    try {
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

      onAcquired(container);

      await container.start();

      await executeCommand(
        container,
        ["sh", "-c", "apk add --no-cache git docker-cli bash"],
        undefined,
        "Prepare builder",
      );

      return container;
    } catch (error) {
      throw safeDiagnosticError(error, "Prepare builder");
    }
  }

  async function executeCommand(
    container: Docker.Container,
    command: string[],
    workingDir?: string,
    stage = "Container command",
  ) {
    try {
      const exec = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        WorkingDir: workingDir,
      });

      const stream = await exec.start({
        hijack: true,
        Tty: true,
      });

      const details = await container.inspect();
      const containerName = details.Name;
      const deploymentId = Number(containerName.replace("/builder-", ""));

      const output = new DiagnosticOutput();
      const saveOutput = async (message: string) => {
        if (!message) return;
        console.log(message);
        await createDeploymentLogs({
          deploymentId,
          message,
          createdBy: containerName,
        });
      };
      for await (const chunk of stream) {
        await saveOutput(output.write(Buffer.from(chunk)).replace(/\0/g, ""));
      }
      await saveOutput(output.end().replace(/\0/g, ""));

      const result = await exec.inspect();

      if (result.ExitCode !== 0) {
        const message = `${stage} failed (exit code ${result.ExitCode}).`;
        console.error(message);
        await createDeploymentLogs({
          deploymentId,
          message,
          createdBy: containerName,
        });
        throw new Error(message);
      }
    } catch (error) {
      throw safeDiagnosticError(error, stage);
    }
  }
  return { createBuilderContainer, executeCommand };
};
