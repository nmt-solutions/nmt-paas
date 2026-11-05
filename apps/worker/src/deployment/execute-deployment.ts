import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import {
  DiagnosticOutput,
  redactDiagnostic,
  registerDiagnosticSecrets,
  safeDiagnosticError,
  withDeploymentDiagnostics,
} from "../services/diagnostics.js";

export type DeploymentRequest = { userId: string; deploymentId: number };

class DeploymentNotFoundError extends Error {
  constructor() {
    super("Deployment not found");
  }
}

type DeploymentStatus =
  | "queued"
  | "cloning"
  | "installing"
  | "building"
  | "starting"
  | "success"
  | "failed";

type DeploymentSnapshot = {
  appId: number;
  repoId: number;
  branch: string;
  commit: string;
  env: "production" | "preview";
  app: {
    appName: string;
    projectId: number;
    appDomains: { domain: string; env: "production" | "preview" }[];
    frameworkConfig: {
      port: number;
      rootDirectory: string;
      installCommand: string;
      buildCommand: string;
      startCommand: string;
    } | null;
  } | null;
};

export type DeploymentExecutionDependencies = {
  getDeployment: (
    id: number,
    userId: string,
  ) => Promise<DeploymentSnapshot | undefined>;
  updateDeployment: (
    params: { id: number; status: DeploymentStatus },
    userId: string,
  ) => Promise<unknown>;
  createDeploymentLogs: (log: {
    deploymentId: number;
    message: string;
    createdBy: string;
  }) => Promise<unknown>;
  getDocker: () => Promise<Docker>;
  createBuilderContainer: (deploymentId: number) => Promise<Docker.Container>;
  executeCommand: (
    container: Docker.Container,
    command: string[],
    workingDirectory?: string,
    stage?: string,
  ) => Promise<void>;
  getCloneUrl: (userId: string, repository: string) => Promise<string>;
  fetchEnvVars: (
    projectId: number,
    env: "production" | "preview",
  ) => Promise<string>;
  registry: { username: string; password: string };
};

type DeploymentContainer = {
  Id: string;
  Names: string[];
  State: string;
  Labels?: Record<string, string>;
};

/**
 * Construct once per worker process to share its app locks.
 * No production adapters are loaded or opened by this module.
 */
export const createDeploymentExecutor = ({
  getDeployment,
  updateDeployment,
  createDeploymentLogs,
  getDocker,
  createBuilderContainer,
  executeCommand,
  getCloneUrl,
  fetchEnvVars,
  registry,
}: DeploymentExecutionDependencies) => {
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
      const value = redactDiagnostic(message);

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
            safeDiagnosticError(error),
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
      if (
        container.Names.includes(`/${deploymentContainerName(deploymentId)}`)
      ) {
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
          console.error(
            `Failed to remove container ${container.Id}:`,
            safeDiagnosticError(error),
          );
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
      console.error(
        `Failed to remove image ${imageName}:`,
        safeDiagnosticError(error),
      );
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
        const output = new DiagnosticOutput();
        logStream.on("data", (chunk: Buffer) => {
          const log = output.write(chunk);

          if (!log.trim()) {
            return;
          }

          process.stdout.write(log);

          void logQueue.add(log);
        });
        logStream.on("end", () => {
          const remaining = output.end();
          if (remaining) {
            process.stdout.write(remaining);
            void logQueue.add(remaining);
          }
        });

        logStream.on("error", (error) => {
          console.error(
            `Deployment log stream error for ${deploymentId}:`,
            safeDiagnosticError(error),
          );
        });
      };

      await Promise.all([consume(stdout), consume(stderr)]);

      stream.on("error", (error) => {
        console.error(
          `Docker log stream error for ${deploymentId}:`,
          safeDiagnosticError(error),
        );
      });
    } catch (error) {
      console.error(
        `Failed to attach deployment logs for ${deploymentId}:`,
        safeDiagnosticError(error),
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
          username: registry.username.toLowerCase(),
          password: registry.password,
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
                console.log(redactDiagnostic(`[GHCR] ${data.status}`));
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
        safeDiagnosticError(error),
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
        safeDiagnosticError(error),
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
    const deployment = await getDeployment(deploymentId, userId);

    if (!deployment) {
      throw new DeploymentNotFoundError();
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
      // Eligibility may change while another delivery owns this app's turn.
      if (!(await getDeployment(deploymentId, userId))) {
        throw new DeploymentNotFoundError();
      }
      const appName = deployment.app?.appName ?? "application";

      const appPort = frameworkConfig.port;
      const installCommand = frameworkConfig.installCommand;
      const buildCommand = frameworkConfig.buildCommand;
      const startCommand = frameworkConfig.startCommand;

      const githubUserName = registry.username.toLowerCase();

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

        await executeCommand(
          builderContainer,
          ["sh", "-c", `git clone ${cloneUrl} .`],
          undefined,
          "Clone repository",
        );

        await createDeploymentLogs({
          deploymentId,
          message: `${appName} repository cloned successfully.`,
          createdBy: userId,
        });

        /*
         * Checkout exact deployment commit.
         */
        await executeCommand(
          builderContainer,
          ["sh", "-c", `git checkout --detach ${deployment.commit}`],
          undefined,
          "Checkout commit",
        );

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
          "Install dependencies",
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
          "Configure environment",
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
          "Build application",
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
          streamDeploymentLogs(
            docker,
            deploymentContainer,
            deploymentId,
            userId,
          ),

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
              safeDiagnosticError(cleanupError),
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
              safeDiagnosticError(cleanupError),
            );
          }
        }
      }
    });
  };

  return async ({ userId, deploymentId }: DeploymentRequest): Promise<void> =>
    withDeploymentDiagnostics(async () => {
      registerDiagnosticSecrets(registry.password);

      try {
        await deploy(userId, deploymentId);
      } catch (failure) {
        // An ineligible delivery has no authority to mutate this deployment.
        if (failure instanceof DeploymentNotFoundError) {
          throw safeDiagnosticError(failure);
        }
        const error = safeDiagnosticError(failure);
        console.error(`Deployment ${deploymentId} failed:`, error);

        try {
          await updateDeployment(
            { id: deploymentId, status: "failed" },
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
            safeDiagnosticError(statusError),
          );
        }

        // BullMQ owns delivery acknowledgement and retry/backoff.
        throw safeDiagnosticError(error);
      }
    });
};
