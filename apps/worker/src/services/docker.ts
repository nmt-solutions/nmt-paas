import { createDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";
import Docker from "dockerode";
import env from "../env/vars.js";
import os from "os";
import { DiagnosticOutput, safeDiagnosticError } from "./diagnostics.js";

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

export async function createBuilderContainer(
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

  await executeCommand(
    container,
    ["sh", "-c", "apk add --no-cache git docker-cli bash"],
    undefined,
    "Prepare builder",
  );

  return container;
}

export async function executeCommand(
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
