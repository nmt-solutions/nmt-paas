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
  getDeployment: (id: number) => Promise<DeploymentSnapshot | undefined>;
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
  // Register acquisition synchronously, before starting or preparing the builder.
  createBuilderContainer: (
    deploymentId: number,
    onAcquired: (container: Docker.Container) => void,
  ) => Promise<Docker.Container>;
  executeCommand: (
    container: Docker.Container,
    command: string[],
    workingDirectory?: string,
    stage?: string,
  ) => Promise<void>;
  getCloneUrl: (userId: string, repositoryId: number) => Promise<string>;
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

    const tail = previous.then(() => current);
    deploymentLocks.set(appId, tail);

    await previous;

    try {
      return await operation();
    } finally {
      release();

      if (deploymentLocks.get(appId) === tail) {
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

      if (labels["nmt.app-id"] !== undefined) {
        return labels["nmt.app-id"] === String(appId);
      }

      return Object.entries(labels).some(
        ([label, value]) =>
          label.startsWith("traefik.http.routers.deployment-") &&
          label.endsWith(".rule") &&
          value === `Host(\`${appDomain}\`)`,
      );
    });
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

  const cleanupFailedArtifact = async (
    deploymentId: number,
    userId: string,
    artifact: string,
    remove: () => Promise<unknown>,
  ) => {
    try {
      await remove();
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      )
        return true;
      const message = safeDiagnosticError(
        error,
        `Cleanup failed for ${artifact}`,
      ).message;
      console.error(message);
      try {
        await createDeploymentLogs({
          deploymentId,
          createdBy: userId,
          message,
        });
      } catch (logError) {
        console.error(
          "Failed to save cleanup diagnostic:",
          safeDiagnosticError(logError),
        );
      }
      return false;
    }
  };

  const deploy = async (
    userId: string,
    deploymentId: number,
    deployment: DeploymentSnapshot | undefined,
    onRuntimeStarted: () => void,
  ) => {
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

    const appName = deployment.app?.appName ?? "application";

    const appPort = frameworkConfig.port;
    const installCommand = frameworkConfig.installCommand;
    const buildCommand = frameworkConfig.buildCommand;
    const startCommand = frameworkConfig.startCommand;

    const githubUserName = registry.username.toLowerCase();

    const docker = await getDocker();

    const imageName = `ghcr.io/${githubUserName}/${deploymentId}:${deploymentId}`;

    let builderContainer: Docker.Container | undefined;

    let committedImageId: string | undefined;

    let deploymentContainer: import("dockerode").Container | undefined;

    let deploymentContainerStarted = false;

    const finishRuntime = async (container: Docker.Container) => {
      await updateDeployment({ id: deploymentId, status: "success" }, userId);
      await createDeploymentLogs({
        deploymentId,
        message: `${appName} deployed successfully at ${appDomain}.`,
        createdBy: userId,
      });
      const oldContainers = await getDeploymentContainers(
        docker,
        deployment.appId,
        deploymentId,
        appDomain,
      );
      // Replacement and retirement stay within the same app lock.
      const removals = oldContainers.map((container) =>
        cleanupFailedArtifact(
          deploymentId,
          userId,
          `prior runtime ${container.Id}`,
          () => docker.getContainer(container.Id).remove({ force: true }),
        ),
      );
      if (builderContainer) {
        const builder = builderContainer;
        removals.push(
          cleanupFailedArtifact(
            deploymentId,
            userId,
            `builder ${builder.id}`,
            () => builder.remove({ force: true }),
          ),
        );
      }
      if ((await Promise.all(removals)).some((removed) => !removed)) {
        throw new Error("Artifact cleanup incomplete; retry this deployment");
      }
      void Promise.allSettled([
        streamDeploymentLogs(docker, container, deploymentId, userId),
        pushImage(docker, imageName, deploymentId),
      ]);
    };

    try {
      const artifacts = await docker.listContainers({ all: true });
      const builder = artifacts.find(
        (container) =>
          container.Names.includes(`/builder-${deploymentId}`) &&
          container.Labels?.["nmt.deployment-id"] === String(deploymentId) &&
          container.Labels?.["nmt.artifact"] === "builder",
      );
      if (builder) builderContainer = docker.getContainer(builder.Id);
      const existing = artifacts.find((container) =>
        container.Names.includes(`/${deploymentContainerName(deploymentId)}`),
      );
      if (existing) {
        if (
          existing.Labels?.["nmt.deployment-id"] !== String(deploymentId) ||
          existing.Labels?.["nmt.app-id"] !== String(deployment.appId)
        ) {
          throw new Error("Runtime name belongs to an unidentified deployment");
        }
        const container = docker.getContainer(existing.Id);
        // A failed inspection does not transfer cleanup ownership of a runtime
        // that may already be serving traffic.
        const details = await container.inspect();
        deploymentContainer = container;
        if (!details.State.Running) await deploymentContainer.start();
        deploymentContainerStarted = true;
        onRuntimeStarted();
        await finishRuntime(deploymentContainer);
        return;
      }
      try {
        const image = await docker.getImage(imageName).inspect();
        if (
          image.Config?.Labels?.["nmt.deployment-id"] !==
            String(deploymentId) ||
          image.Config?.Labels?.["nmt.artifact"] !== "image"
        ) {
          throw new Error("Image name belongs to an unidentified deployment");
        }
        committedImageId = image.Id;
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            error.statusCode === 404
          )
        )
          throw error;
      }
      if (!committedImageId) {
        // A partial build is not a reusable filesystem. Rebuild from the recorded
        // revision, removing only the builder identified as this deployment's.
        if (builderContainer) {
          await builderContainer.remove({ force: true });
          builderContainer = undefined;
        }
        builderContainer = await createBuilderContainer(
          deploymentId,
          (container) => {
            // Own the handle before builder start or preparation can fail.
            builderContainer = container;
          },
        );

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

        const cloneUrl = await getCloneUrl(userId, deployment.repoId);

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
        const committedImage = await builderContainer.commit({
          repo: `ghcr.io/${githubUserName}/${deploymentId}`,
          tag: deploymentId.toString(),
          changes: [
            `WORKDIR ${rootDirectory}`,
            `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
            "LABEL nmt.artifact=image",
          ],
        });

        committedImageId = committedImage.Id;

        console.log(`Application image created: ${imageName}`);
      }

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
          "nmt.artifact": "runtime",

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
      try {
        await deploymentContainer.start();
      } catch (error) {
        throw safeDiagnosticError(error, "Start application");
      }

      deploymentContainerStarted = true;
      onRuntimeStarted();

      console.log(`Deployment container ${deploymentId} started.`);

      /*
       * Start acceptance is the success boundary. Persist the outcome and
       * retire prior runtimes before releasing coordination for this app.
       */
      await finishRuntime(deploymentContainer);

      /*
       * deploy() can return now.
       */
      return;
    } finally {
      /*
       * Before replacement start, release only this attempt's acquired handles.
       * After start, retain recoverable artifacts even if persistence fails.
       */
      if (!deploymentContainerStarted) {
        if (deploymentContainer) {
          const container = deploymentContainer;
          await cleanupFailedArtifact(
            deploymentId,
            userId,
            `runtime ${container.id}`,
            () => container.remove({ force: true }),
          );
        }
        if (builderContainer) {
          const container = builderContainer;
          await cleanupFailedArtifact(
            deploymentId,
            userId,
            `builder ${container.id}`,
            () => container.remove({ force: true }),
          );
        }
        if (committedImageId) {
          const image = docker.getImage(committedImageId);
          await cleanupFailedArtifact(
            deploymentId,
            userId,
            `image ${committedImageId}`,
            () => image.remove(),
          );
        }
      }
    }
  };

  return async ({ userId, deploymentId }: DeploymentRequest): Promise<void> =>
    withDeploymentDiagnostics(async () => {
      registerDiagnosticSecrets(registry.password);

      const reportFailure = async (
        failure: unknown,
        runtimeStarted = false,
      ): Promise<never> => {
        const error = safeDiagnosticError(
          failure,
          runtimeStarted ? "Runtime started; recovery pending" : undefined,
        );
        console.error(
          `Deployment ${deploymentId} attempt requires recovery:`,
          error,
        );

        try {
          await updateDeployment(
            { id: deploymentId, status: runtimeStarted ? "success" : "failed" },
            userId,
          );
        } catch (statusError) {
          console.error(
            `Failed to save deployment ${deploymentId} outcome:`,
            safeDiagnosticError(statusError),
          );
        }
        // A rejected status write must not suppress an independently writable
        // recovery diagnostic (and vice versa).
        try {
          await createDeploymentLogs({
            deploymentId,
            message: error.message,
            createdBy: userId,
          });
        } catch (logError) {
          console.error(
            `Failed to save deployment ${deploymentId} diagnostic:`,
            safeDiagnosticError(logError),
          );
        }

        // BullMQ owns delivery acknowledgement and retry/backoff.
        throw safeDiagnosticError(error);
      };

      let deployment: DeploymentSnapshot | undefined;
      try {
        deployment = await getDeployment(deploymentId);
      } catch (failure) {
        return reportFailure(failure);
      }
      const attempt = async () => {
        let runtimeStarted = false;
        try {
          await deploy(userId, deploymentId, deployment, () => {
            runtimeStarted = true;
          });
        } catch (failure) {
          return reportFailure(failure, runtimeStarted);
        }
      };
      return deployment ? withAppLock(deployment.appId, attempt) : attempt();
    });
};
