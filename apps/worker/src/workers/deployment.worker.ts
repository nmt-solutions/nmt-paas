import { Worker } from "bullmq";
import { PassThrough } from "node:stream";

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

type Docker = Awaited<ReturnType<typeof getDocker>>;

type DeploymentContainer = {
  Id: string;
  Names: string[];
  State: string;
  Labels?: Record<string, string>;
};

const deploymentContainerName = (deploymentId: number) =>
  `deployment-${deploymentId}`;

const deploymentLocks = new Map<number, Promise<void>>();

const withAppLock = async <T>(
  appId: number,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = deploymentLocks.get(appId) ?? Promise.resolve();

  let release!: () => void;

  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  deploymentLocks.set(
    appId,
    previous.then(() => current),
  );

  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (deploymentLocks.get(appId) === current) {
      deploymentLocks.delete(appId);
    }
  }
};

/**
 * Serializes deployment log writes.
 *
 * Docker can emit many log chunks at once. We don't want multiple
 * database writes for the same deployment racing each other.
 */
class DeploymentLogQueue {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deploymentId: number,
    private readonly createdBy: string,
  ) {}

  add(message: string): Promise<void> {
    const value = message;

    this.queue = this.queue
      .then(async () => {
        if (!value.trim()) {
          return;
        }

        await createDeploymentLogs({
          deploymentId: this.deploymentId,
          message: value,
          createdBy: this.createdBy,
        });
      })
      .catch((error) => {
        console.error(
          `Failed to save deployment log for ${this.deploymentId}:`,
          error,
        );
      });

    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

const getRootDirectory = (rootDirectory: string) => {
  const normalized = rootDirectory.trim();

  if (!normalized || normalized === "./" || normalized === "/") {
    return "/app";
  }

  return `/app/${normalized.replace(/^\.?\//, "")}`;
};

const getDeploymentContainers = async (
  docker: Docker,
  appId: number,
  deploymentId: number,
  appDomain: string,
): Promise<DeploymentContainer[]> => {
  const containers = await docker.listContainers({
    all: true,
  });

  return containers.filter((container) => {
    if (container.Names.includes(`/${deploymentContainerName(deploymentId)}`)) {
      return false;
    }

    const labels = container.Labels ?? {};

    if (labels["nmt.app-id"] === String(appId)) {
      return true;
    }

    return Object.entries(labels).some(
      ([label, value]) =>
        label.startsWith("traefik.http.routers.deployment-") &&
        label.endsWith(".rule") &&
        value.includes(appDomain),
    );
  });
};

const removeContainers = async (
  docker: Docker,
  containers: DeploymentContainer[],
) => {
  if (containers.length === 0) {
    return;
  }

  await Promise.allSettled(
    containers.map(async (container) => {
      try {
        await docker.getContainer(container.Id).remove({
          force: true,
        });

        console.log(`Removed old deployment container ${container.Id}`);
      } catch (error) {
        console.error(`Failed to remove container ${container.Id}:`, error);
      }
    }),
  );
};

const removeImage = async (
  docker: Docker,
  imageName: string,
  message: string,
) => {
  try {
    const image = docker.getImage(imageName);

    await image.remove({
      force: true,
    });

    console.log(message);
  } catch (error) {
    console.error(`Failed to remove image ${imageName}:`, error);
  }
};

const streamDeploymentLogs = async (
  docker: Docker,
  container: import("dockerode").Container,
  deploymentId: number,
  userId: string,
) => {
  try {
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    docker.modem.demuxStream(stream, stdout, stderr);

    const logQueue = new DeploymentLogQueue(deploymentId, userId);

    const consume = async (logStream: PassThrough) => {
      logStream.on("data", (chunk: Buffer) => {
        const log = chunk.toString("utf8");

        if (!log.trim()) {
          return;
        }

        process.stdout.write(log);

        void logQueue.add(log);
      });

      logStream.on("error", (error) => {
        console.error(
          `Deployment log stream error for ${deploymentId}:`,
          error,
        );
      });
    };

    await Promise.all([consume(stdout), consume(stderr)]);

    stream.on("error", (error) => {
      console.error(`Docker log stream error for ${deploymentId}:`, error);
    });
  } catch (error) {
    console.error(
      `Failed to attach deployment logs for ${deploymentId}:`,
      error,
    );
  }
};

const pushImage = async (
  docker: Docker,
  imageName: string,
  deploymentId: number,
) => {
  try {
    const image = docker.getImage(imageName);

    const stream = await image.push({
      authconfig: {
        username: env.variables.GITHUB_USER_NAME.toLowerCase(),
        password: env.variables.GITHUB_PAT,
        serveraddress: "ghcr.io",
      },
    });

    let lastPercent = -1;
    let pushed = false;

    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);

      stream.on("end", resolve);

      stream.on("data", (chunk: Buffer) => {
        const output = chunk.toString("utf8").trim();

        if (!output) {
          return;
        }

        for (const line of output.split("\n")) {
          try {
            const data = JSON.parse(line);

            if (data.status === "Pushing" && data.progressDetail?.total) {
              const { current = 0, total } = data.progressDetail;

              const percent = Math.floor((current / total) * 100);

              const roundedPercent = Math.floor(percent / 10) * 10;

              if (roundedPercent > lastPercent) {
                lastPercent = roundedPercent;

                console.log(`[GHCR] Pushing ${roundedPercent}%`);
              }

              continue;
            }

            if (data.status === "Pushed") {
              pushed = true;
              console.log("[GHCR] Pushed");
              continue;
            }

            if (data.status?.includes("digest:")) {
              console.log(`[GHCR] ${data.status}`);
            }
          } catch {
            // Docker can send non-JSON output.
          }
        }
      });
    });

    if (!pushed) {
      console.log(
        `[GHCR] Push stream completed for deployment ${deploymentId}`,
      );
    }
  } catch (error) {
    console.error(
      `Failed to push image for deployment ${deploymentId}:`,
      error,
    );
  }
};

const cleanupDeployment = async ({
  docker,
  builderContainer,
  imageName,
  oldContainers,
  deploymentContainerStarted,
  deploymentId,
}: {
  docker: Docker;
  builderContainer: import("dockerode").Container;
  imageName: string;
  oldContainers: DeploymentContainer[];
  deploymentContainerStarted: boolean;
  deploymentId: number;
}) => {
  /*
   * Builder containers are temporary.
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
   * Only remove the old containers after the new deployment
   * successfully started.
   */
  if (deploymentContainerStarted) {
    await removeContainers(docker, oldContainers);
  } else {
    /*
     * If the new deployment never started, remove its image.
     * The old application remains untouched.
     */
    await removeImage(
      docker,
      imageName,
      `Removed failed deployment image: ${imageName}`,
    );
  }
};

const deploy = async (userId: string, deploymentId: number) => {
  const deployment = await getDeployment(deploymentId);

  if (!deployment) {
    throw new Error("Deployment not found");
  }

  if (!deployment.app) {
    throw new Error("Application not found");
  }

  const appDomain = deployment.app.appDomains.find(
    (domain) => domain.env === deployment.env,
  )?.domain;

  if (!appDomain) {
    throw new Error("App Domain Not Found");
  }

  const frameworkConfig = deployment.app.frameworkConfig;

  if (!frameworkConfig) {
    throw new Error("Framework configuration not found");
  }

  return withAppLock(deployment.appId, async () => {
    const appName = deployment.app?.appName ?? "application";

    const appPort = frameworkConfig.port;
    const installCommand = frameworkConfig.installCommand;
    const buildCommand = frameworkConfig.buildCommand;
    const startCommand = frameworkConfig.startCommand;

    const githubUserName = env.variables.GITHUB_USER_NAME.toLowerCase();

    const docker = await getDocker();

    const imageName = `ghcr.io/${githubUserName}/${deploymentId}:${deploymentId}`;

    const builderContainer = await createBuilderContainer(deploymentId);

    let deploymentContainer: import("dockerode").Container | undefined;

    let deploymentContainerStarted = false;

    let oldContainers: DeploymentContainer[] = [];

    try {
      /*
       * Clone.
       */
      await updateDeployment(
        {
          id: deploymentId,
          status: "cloning",
        },
        userId,
      );

      await createDeploymentLogs({
        deploymentId,
        message: `Cloning repository for ${appName}...`,
        createdBy: userId,
      });

      console.log(`Cloning repository for ${appName}...`);

      const cloneUrl = await getCloneUrl(userId, appName);

      await executeCommand(builderContainer, [
        "sh",
        "-c",
        `git clone ${cloneUrl} .`,
      ]);

      await createDeploymentLogs({
        deploymentId,
        message: `${appName} repository cloned successfully.`,
        createdBy: userId,
      });

      /*
       * Checkout exact deployment commit.
       */
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

      /*
       * Resolve project directory.
       */
      const rootDirectory = getRootDirectory(frameworkConfig.rootDirectory);

      /*
       * Install.
       */
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

      /*
       * Environment variables.
       */
      const envVars = await fetchEnvVars(
        deployment.app!.projectId,
        deployment.env,
      );

      await executeCommand(
        builderContainer,
        [
          "sh",
          "-c",
          `cat > .env << 'EOF'
          ${envVars}
          EOF`,
        ],
        rootDirectory,
      );

      /*
       * Build.
       */
      await updateDeployment(
        {
          id: deploymentId,
          status: "building",
        },
        userId,
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

      /*
       * Commit the builder container into a deployable image.
       *
       * JSON.stringify prevents quotes inside startCommand
       * from breaking the generated CMD instruction.
       */
      await builderContainer.commit({
        repo: `ghcr.io/${githubUserName}/${deploymentId}`,
        tag: deploymentId.toString(),
        changes: [
          "WORKDIR /app",
          `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
        ],
      });

      console.log(`Application image created: ${imageName}`);

      /*
       * Get the containers currently serving this app.
       *
       * IMPORTANT:
       * We do not stop them yet.
       */
      oldContainers = await getDeploymentContainers(
        docker,
        deployment.appId,
        deploymentId,
        appDomain,
      );

      /*
       * Create the new deployment container FIRST.
       */
      await updateDeployment(
        {
          id: deploymentId,
          status: "starting",
        },
        userId,
      );

      await createDeploymentLogs({
        deploymentId,
        message: "Starting application...",
        createdBy: userId,
      });

      console.log(`Starting application...`);

      deploymentContainer = await docker.createContainer({
        name: deploymentContainerName(deploymentId),

        Image: imageName,

        Labels: {
          "traefik.enable": "true",

          "nmt.app-id": String(deployment.appId),

          "nmt.deployment-id": String(deploymentId),

          [`traefik.http.routers.deployment-${deploymentId}.rule`]: `Host(\`${appDomain}\`)`,

          [`traefik.http.routers.deployment-${deploymentId}.entrypoints`]:
            "web",

          [`traefik.http.services.deployment-${deploymentId}.loadbalancer.server.port`]:
            String(appPort),

          "traefik.docker.network": "app-network",
        },

        ExposedPorts: {
          [`${appPort}/tcp`]: {},
        },

        HostConfig: {
          NetworkMode: "app-network",

          RestartPolicy: {
            Name: "unless-stopped",
          },
        },
      });

      /*
       * Start the new container before touching the old one.
       */
      await deploymentContainer.start();

      deploymentContainerStarted = true;

      console.log(`Deployment container ${deploymentId} started.`);

      /*
       * The application is now available to Traefik.
       *
       * Mark success immediately. Everything after this point
       * is cleanup/background work.
       */
      await updateDeployment(
        {
          id: deploymentId,
          status: "success",
        },
        userId,
      );

      await createDeploymentLogs({
        deploymentId,
        message: `${appName} deployed successfully at ${appDomain}.`,
        createdBy: userId,
      });

      console.log(`${appName} deployed successfully at ${appDomain}.`);

      /*
       * Start background work.
       *
       * None of this blocks the deployment response/status.
       */
      void Promise.allSettled([
        streamDeploymentLogs(docker, deploymentContainer, deploymentId, userId),

        pushImage(docker, imageName, deploymentId),

        cleanupDeployment({
          docker,
          builderContainer,
          imageName,
          oldContainers,
          deploymentContainerStarted,
          deploymentId,
        }),
      ]);

      /*
       * deploy() can return now.
       */
      return;
    } catch (error) {
      /*
       * If the new container was created but failed to start,
       * remove it and leave the previous application untouched.
       */
      if (deploymentContainer && !deploymentContainerStarted) {
        try {
          await deploymentContainer.remove({
            force: true,
          });
        } catch (cleanupError) {
          console.error(
            `Failed to remove failed deployment container ${deploymentId}:`,
            cleanupError,
          );
        }
      }

      throw error;
    } finally {
      /*
       * If deployment succeeded, cleanupDeployment() already
       * owns builder cleanup.
       *
       * If deployment failed before background cleanup started,
       * clean the builder here.
       */
      if (!deploymentContainerStarted) {
        try {
          await builderContainer.remove({
            force: true,
          });

          console.log(
            `Removed builder container for deployment ${deploymentId}`,
          );
        } catch (cleanupError) {
          console.error(
            `Failed to remove builder container for deployment ${deploymentId}:`,
            cleanupError,
          );
        }
      }
    }
  });
};

const worker = new Worker(
  "deployment-queue",

  async (job) => {
    const { userId, deploymentId } = job.data as {
      userId: string;
      deploymentId: number;
    };

    const { error } = await tryCatch(deploy(userId, deploymentId));

    if (!error) {
      return;
    }

    console.error(`Deployment ${deploymentId} failed:`, error);

    try {
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
    } catch (statusError) {
      console.error(
        `Failed to update failed deployment ${deploymentId}:`,
        statusError,
      );
    }

    throw error;
  },

  {
    connection: redis as object,
    concurrency: 5,
  },
);

worker.on("error", (error) => {
  console.error("Deployment worker error:", error);
});

console.log("Deployment worker started");
