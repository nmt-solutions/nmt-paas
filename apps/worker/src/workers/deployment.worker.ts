import { Worker } from "bullmq";
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
import { tryCatch } from "../utils/try-catch.js";
import { getCloneUrl } from "../services/github.js";
import env from "../env/vars.js";
import { fetchEnvVars } from "../services/env-vars.js";

const deploymentContainerName = (deploymentId: number) =>
  `deployment-${deploymentId}`;

/**
 * Stop containers that currently serve an app without deleting them yet. Keeping
 * them around until the replacement starts lets us restore service if Docker
 * rejects the new container for any reason.
 */
const stopRunningAppContainers = async (
  docker: Awaited<ReturnType<typeof getDocker>>,
  appId: number,
  replacementDeploymentId: number,
  appDomain: string,
) => {
  const containers = await docker.listContainers({ all: true });
  const previous = containers.filter(
    (container) =>
      (container.Labels?.["nmt.app-id"] === String(appId) ||
        Object.entries(container.Labels ?? {}).some(
          ([label, value]) =>
            label.startsWith("traefik.http.routers.deployment-") &&
            label.endsWith(".rule") &&
            value.includes(appDomain),
        )) &&
      !container.Names.includes(
        `/${deploymentContainerName(replacementDeploymentId)}`,
      ),
  );

  const stopped: string[] = [];

  for (const previousContainer of previous) {
    if (previousContainer.State === "running") {
      await docker.getContainer(previousContainer.Id).stop();
      stopped.push(previousContainer.Id);
    }
  }

  return { previous, stopped };
};

const restoreStoppedContainers = async (
  docker: Awaited<ReturnType<typeof getDocker>>,
  containerIds: string[],
) => {
  await Promise.all(
    containerIds.map((containerId) => docker.getContainer(containerId).start()),
  );
};

const removeReplacedContainers = async (
  docker: Awaited<ReturnType<typeof getDocker>>,
  containers: { Id: string }[],
) => {
  await Promise.all(
    containers.map((container) =>
      docker.getContainer(container.Id).remove({ force: true }),
    ),
  );
};

const deploy = async (userId: string, deploymentId: number) => {
  const deployment = await getDeployment(deploymentId);

  if (!deployment) {
    throw new Error("Deployment not found");
  }

  const appDomain = deployment.app?.appDomains.find(
    (domain) => domain.env === deployment.env,
  )?.domain;

  if (!appDomain) {
    throw new Error("App Domain Not Found");
  }

  const frameworkConfig = deployment.app?.frameworkConfig;

  if (!frameworkConfig) {
    throw new Error("Framework configuration not found");
  }

  const appPort = frameworkConfig.port;
  const installCommand = frameworkConfig.installCommand;
  const buildCommand = frameworkConfig.buildCommand;
  const startCommand = frameworkConfig.startCommand;

  const githubUserName = env.variables.GITHUB_USER_NAME.toLowerCase();

  const docker = await getDocker();

  const imageName = `ghcr.io/${githubUserName}/${deploymentId}:${deploymentId}`;

  const builderContainer = await createBuilderContainer(deploymentId);

  let imageCreated = false;
  let deploymentContainerStarted = false;

  try {
    await updateDeployment(
      {
        id: deploymentId,
        status: "cloning",
      },
      userId,
    );

    await createDeploymentLogs({
      deploymentId,
      message: `Cloning repository for ${deployment.app?.appName}...`,
      createdBy: userId,
    });

    console.log(`Cloning repository for ${deployment.app?.appName}...`);

    const cloneUrl = await getCloneUrl(userId, deployment.app?.appName ?? "");

    await executeCommand(builderContainer, [
      "sh",
      "-c",
      `git clone ${cloneUrl} .`,
    ]);

    await createDeploymentLogs({
      deploymentId,
      message: `${deployment.app?.appName} repository cloned successfully.`,
      createdBy: userId,
    });

    await executeCommand(builderContainer, [
      "sh",
      "-c",
      `git checkout --detach ${deployment.commit}`,
    ]);

    await createDeploymentLogs({
      deploymentId,
      message: `Checked out commit ${deployment.commit.slice(0, 12)} from ${deployment.branch}`,
      createdBy: userId,
    });

    await updateDeployment(
      {
        id: deploymentId,
        status: "installing",
      },
      userId,
    );

    await createDeploymentLogs({
      deploymentId,
      message: "Installing project dependencies...",
      createdBy: userId,
    });

    console.log(`Installing project dependencies...`);

    const rootDirectory =
      frameworkConfig.rootDirectory === "./" ||
      frameworkConfig.rootDirectory === "/"
        ? "/app"
        : `/app/${frameworkConfig.rootDirectory.replace(/^\.?\//, "")}`;

    await executeCommand(
      builderContainer,
      ["sh", "-c", installCommand],
      rootDirectory,
    );

    await createDeploymentLogs({
      deploymentId,
      message: "Project dependencies installed successfully.",
      createdBy: userId,
    });

    console.log(`Project dependencies installed successfully.`);

    await updateDeployment(
      {
        id: deploymentId,
        status: "building",
      },
      userId,
    );

    const envVars = await fetchEnvVars(
      deployment.app?.projectId ?? 0,
      deployment.env,
    );

    await executeCommand(
      builderContainer,
      ["sh", "-c", `cat > .env << 'EOF'\n${envVars}\nEOF`],
      rootDirectory,
    );

    await createDeploymentLogs({
      deploymentId,
      message: "Building application...",
      createdBy: userId,
    });

    console.log(`Building application...`);

    await executeCommand(
      builderContainer,
      ["sh", "-c", buildCommand],
      rootDirectory,
    );

    await createDeploymentLogs({
      deploymentId,
      message: "Application built successfully.",
      createdBy: userId,
    });

    console.log(`Application built successfully.`);

    const result = await builderContainer.commit({
      repo: `ghcr.io/${githubUserName}/${deploymentId}`,
      tag: deploymentId.toString(),
      changes: [
        "WORKDIR /app",
        `CMD ["sh","-c","${startCommand.replace(/"/g, '\\"')}"]`,
      ],
    });

    imageCreated = true;

    console.log("Commit Result:", result);

    const image = docker.getImage(imageName);

    const pushStream = await image.push({
      authconfig: {
        username: githubUserName,
        password: env.variables.GITHUB_PAT,
        serveraddress: "ghcr.io",
      },
    });

    let lastPercent = -1;

    await new Promise<void>((resolve, reject) => {
      pushStream.on("end", resolve);
      pushStream.on("error", reject);

      pushStream.on("data", (chunk: Buffer) => {
        const output = chunk.toString("utf8").trim();

        if (!output) {
          return;
        }

        // Docker can emit multiple JSON objects in one chunk.
        for (const line of output.split("\n")) {
          try {
            const data = JSON.parse(line);

            if (data.status === "Pushing" && data.progressDetail?.total) {
              const { current, total } = data.progressDetail;

              const percent = Math.floor((current / total) * 100);
              const roundedPercent = Math.floor(percent / 10) * 10;

              if (roundedPercent > lastPercent) {
                lastPercent = roundedPercent;
                console.log(`[GHCR] Pushing ${roundedPercent}%`);
              }
            } else if (data.status === "Pushed") {
              if (lastPercent < 100) {
                console.log("[GHCR] Pushing 100%");
              }

              console.log("[GHCR] Pushed");
            } else if (data.status?.includes("digest:")) {
              console.log(`[GHCR] ${data.status}`);
            }
          } catch {
            // Ignore non-JSON output.
          }
        }
      });
    });

    await updateDeployment(
      {
        id: deploymentId,
        status: "starting",
      },
      userId,
    );

    await createDeploymentLogs({
      deploymentId,
      message: "Deploying application...",
      createdBy: userId,
    });

    console.log(`Deploying application.`);

    const deploymentContainer = await docker.createContainer({
      name: deploymentContainerName(deploymentId),

      Image: imageName,

      Labels: {
        "traefik.enable": "true",
        "nmt.app-id": String(deployment.appId),
        "nmt.deployment-id": String(deploymentId),

        [`traefik.http.routers.deployment-${deploymentId}.rule`]: `Host(\`${appDomain}\`)`,

        [`traefik.http.routers.deployment-${deploymentId}.entrypoints`]: "web",

        [`traefik.http.services.deployment-${deploymentId}.loadbalancer.server.port`]:
          String(appPort),

        "traefik.docker.network": "app-network",
      },

      ExposedPorts: {
        [`${appPort}/tcp`]: {},
      },

      HostConfig: {
        NetworkMode: "app-network",
      },
    });

    const previousContainers = await stopRunningAppContainers(
      docker,
      deployment.appId,
      deploymentId,
      appDomain,
    );

    try {
      await deploymentContainer.start();
      deploymentContainerStarted = true;
      await removeReplacedContainers(docker, previousContainers.previous);
    } catch (error) {
      await restoreStoppedContainers(docker, previousContainers.stopped);
      throw error;
    }

    /*
     * The deployment container is now using the image.
     *
     * Removing the image tag here does not remove layers that
     * Docker still needs for the running container.
     */
    try {
      await image.remove({ force: true });

      console.log(`Removed local image: ${imageName}`);
    } catch (error) {
      console.error(`Failed to remove local image ${imageName}:`, error);
    }

    const deploymentStream = await deploymentContainer.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
    });

    deploymentStream.on("data", async (chunk: Buffer) => {
      const log = `${chunk.toString("utf8").replace(/\0/g, "")}\n`;

      console.log(log);

      try {
        await createDeploymentLogs({
          deploymentId,
          message: log,
          createdBy: userId,
        });
      } catch (error) {
        console.error(
          `Failed to save deployment log for ${deploymentId}:`,
          error,
        );
      }
    });

    await updateDeployment(
      {
        id: deploymentId,
        status: "success",
      },
      userId,
    );

    await createDeploymentLogs({
      deploymentId,
      message: `${deployment.app?.appName} deployed successfully at ${appDomain}.`,
      createdBy: userId,
    });

    console.log(
      `${deployment.app?.appName} deployed successfully at ${appDomain}.`,
    );
  } finally {
    /*
     * The builder is temporary and should never survive the deployment.
     *
     * This runs for both successful and failed deployments.
     */
    try {
      await builderContainer.remove({
        force: true,
      });

      console.log(`Removed builder container for deployment ${deploymentId}`);
    } catch (error) {
      console.error(
        `Failed to remove builder container for deployment ${deploymentId}:`,
        error,
      );
    }

    /*
     * If the build failed before the deployment container started,
     * remove the image created by commit if one exists.
     */
    if (imageCreated && !deploymentContainerStarted) {
      try {
        const image = docker.getImage(imageName);

        await image.remove({
          force: true,
        });

        console.log(`Removed failed deployment image: ${imageName}`);
      } catch (error) {
        console.error(
          `Failed to remove failed deployment image ${imageName}:`,
          error,
        );
      }
    }
  }
};

new Worker(
  "deployment-queue",
  async (job: {
    data: {
      userId: string;
      deploymentId: number;
    };
  }) => {
    const deploymentId = job.data.deploymentId;
    const userId = job.data.userId;

    const { error } = await tryCatch(deploy(userId, deploymentId));

    if (error) {
      console.log(error);

      await updateDeployment(
        {
          id: deploymentId,
          status: "failed",
        },
        userId,
      );

      await createDeploymentLogs({
        deploymentId,
        message: error.message,
        createdBy: userId,
      });
    }
  },
  {
    connection: redis as any,
    concurrency: 5,
  },
);
