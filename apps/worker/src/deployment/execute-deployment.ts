import { PassThrough } from "node:stream";
import { publishImage } from "./publish-image.js";
import type Docker from "dockerode";
import type {
  DeploymentCleanup,
  DeploymentCleanupArtifact,
} from "@repo/database/schema";
import {
  DiagnosticOutput,
  redactDiagnostic,
  registerDiagnosticSecrets,
  safeDiagnosticError,
  withDeploymentDiagnostics,
} from "../services/diagnostics.js";

export type DeploymentRequest = {
  userId: string;
  deploymentId: number;
  action?: "cleanup";
  operation?: "publish";
};

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
  status?: string;
  userId?: string;
  cleanup?: DeploymentCleanup | null;
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

export type PublicationRecord = {
  deploymentId: number;
  imageId: string;
  imageName: string;
  status: "pending" | "publishing" | "published" | "failed";
  lastError: string | null;
};

export type DeploymentExecutionDependencies = {
  withAppLifecycleLock?: <T>(
    appId: number,
    operation: () => Promise<T>,
  ) => Promise<T>;
  getPublication: (
    deploymentId: number,
    userId: string,
  ) => Promise<PublicationRecord | undefined>;
  recordPublication: (
    image: Pick<PublicationRecord, "deploymentId" | "imageId" | "imageName">,
    userId: string,
  ) => Promise<unknown>;
  updatePublication: (
    deploymentId: number,
    state: Pick<PublicationRecord, "status" | "lastError">,
    userId: string,
  ) => Promise<unknown>;
  getDeployment: (
    id: number,
    userId: string,
  ) => Promise<DeploymentSnapshot | undefined>;
  saveDeploymentCleanup: (
    id: number,
    cleanup: DeploymentCleanup,
    userId: string,
  ) => Promise<unknown>;
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
  getCleanupDocker?: () => Promise<Docker>;
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
    environment?: string[],
  ) => Promise<void>;
  getCloneUrl: (userId: string, repositoryId: number) => Promise<string>;
  fetchEnvVars: (
    projectId: number,
    env: "production" | "preview",
  ) => Promise<{ key: string; value: string }[]>;
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
 * A successful execution confirms container start, without an application
 * readiness check. Replacement retirement is awaited; publication is background.
 */
export const createDeploymentExecutor = ({
  withAppLifecycleLock = async (_appId, operation) => operation(),
  getDeployment,
  saveDeploymentCleanup,
  getPublication,
  recordPublication,
  updatePublication,
  updateDeployment,
  createDeploymentLogs,
  getDocker,
  getCleanupDocker = getDocker,
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

  const publish = async (deploymentId: number, userId: string) => {
    const publication = await getPublication(deploymentId, userId);
    if (!publication) throw new Error("Publication not found");
    if (publication.status === "published") return;
    let pushing = false;
    try {
      await updatePublication(
        deploymentId,
        { status: "publishing", lastError: null },
        userId,
      );
      pushing = true;
      await publishImage(await getDocker(), publication, registry);
      pushing = false;
      await updatePublication(
        deploymentId,
        { status: "published", lastError: null },
        userId,
      );
    } catch (failure) {
      const diagnostic = safeDiagnosticError(
        failure,
        "Registry publication failed",
      );
      const error = pushing
        ? diagnostic
        : new Error(
            "Registry publication outcome could not be saved. Retry publication to confirm the recorded image.",
          );
      try {
        await updatePublication(
          deploymentId,
          { status: "failed", lastError: error.message.slice(0, 2000) },
          userId,
        );
      } catch (persistenceError) {
        console.error(
          "Unable to save publication outcome:",
          safeDiagnosticError(persistenceError),
        );
      }
      console.error(diagnostic);
      throw error;
    }
  };

  const notFound = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404;

  const cleanupArtifacts = async (
    docker: Docker,
    deployment: DeploymentSnapshot,
    deploymentId: number,
    userId: string,
    targets: DeploymentCleanupArtifact[] = [],
  ): Promise<DeploymentCleanup> => {
    const cleanup: DeploymentCleanup = structuredClone(
      deployment.cleanup ?? { status: "complete", artifacts: [] },
    );
    const persist = async () => {
      cleanup.status = cleanup.artifacts.some(
        (a) => a.status === "pending" || a.status === "failed",
      )
        ? "pending"
        : "complete";
      try {
        await saveDeploymentCleanup(deploymentId, cleanup, userId);
      } catch {
        // Driver errors can embed the entire ledger as SQL parameters. Keep
        // those internals out of persisted diagnostics and subsequent ledgers.
        throw new Error("Cleanup outcome could not be saved");
      }
      deployment.cleanup = structuredClone(cleanup);
    };
    for (const target of targets) {
      if (
        !cleanup.artifacts.some(
          (a) => a.id === target.id && a.kind === target.kind,
        )
      )
        cleanup.artifacts.push(target);
    }
    // Durable intent precedes every removal, including the first one. A crash
    // after Docker removes a target is recovered by the target's 404 response.
    try {
      await persist();
    } catch (error) {
      const message = safeDiagnosticError(
        error,
        "Cleanup failed to save removal intent",
      ).message;
      await createDeploymentLogs({
        deploymentId,
        createdBy: userId,
        message,
      }).catch(() => {});
      console.error(message);
      return { ...cleanup, status: "pending" };
    }
    for (const target of cleanup.artifacts) {
      if (target.status === "complete" || target.status === "preserved")
        continue;
      try {
        let details:
          | Docker.ImageInspectInfo
          | Docker.ContainerInspectInfo
          | undefined;
        try {
          details =
            target.kind === "image"
              ? await docker.getImage(target.id).inspect()
              : await docker.getContainer(target.id).inspect();
        } catch (error) {
          if (!notFound(error)) throw error;
        }
        if (details) {
          const labels: Record<string, string> = details.Config?.Labels ?? {};
          if (
            !Object.keys(target.labels).length ||
            Object.entries(target.labels).some(
              ([key, value]) => labels[key] !== value,
            )
          ) {
            throw new Error(
              "Artifact ownership no longer matches; resource preserved",
            );
          }
          if (target.kind === "prior runtime") {
            if (
              target.labels["nmt.app-id"] !== String(deployment.appId) ||
              !target.replacementId ||
              target.replacementId === target.id
            ) {
              throw new Error(
                "Cannot verify superseded runtime ownership; resource preserved",
              );
            }
            const replacement = await docker
              .getContainer(target.replacementId)
              .inspect();
            if (
              !replacement.State.Running ||
              replacement.Config.Labels?.["nmt.app-id"] !==
                String(deployment.appId) ||
              replacement.Config.Labels?.["nmt.deployment-id"] !==
                String(deploymentId)
            ) {
              throw new Error(
                "Replacement is not running with the expected identity; runtime preserved",
              );
            }
          } else if (
            target.labels["nmt.deployment-id"] !== String(deploymentId) ||
            target.labels["nmt.artifact"] !==
              (target.kind === "image"
                ? "image"
                : target.kind === "builder"
                  ? "builder"
                  : "runtime")
          ) {
            throw new Error(
              "Cannot verify deployment artifact ownership; resource preserved",
            );
          }
          const running =
            target.kind === "runtime" &&
            (deployment.status === "success" ||
              (details as Docker.ContainerInspectInfo).State.Running);
          const usedImage =
            target.kind === "image" &&
            (deployment.status === "success" ||
              (await docker.listContainers({ all: true })).some(
                (c) =>
                  c.State === "running" &&
                  c.Labels?.["nmt.app-id"] === String(deployment.appId) &&
                  c.Labels?.["nmt.deployment-id"] === String(deploymentId),
              ));
          if (running || usedImage) {
            // A deployment retry can adopt a once-failed runtime/image. Its
            // earlier failure-cleanup intent must never delete that runtime.
            target.status = "preserved";
          } else {
            try {
              if (target.kind === "image")
                await docker.getImage(target.id).remove();
              else await docker.getContainer(target.id).remove({ force: true });
            } catch (error) {
              if (!notFound(error)) throw error;
            }
            target.status = "complete";
          }
        } else target.status = "complete";
        delete target.error;
        await persist();
      } catch (error) {
        target.status = "failed";
        target.error = safeDiagnosticError(
          error,
          `Cleanup failed for ${target.kind} ${target.id}`,
        ).message;
        console.error(target.error);
        // Status, cleanup and log writes are independent outcomes. A failed
        // acknowledgement leaves the persisted pending intent safe to retry.
        await persist().catch((writeError) =>
          console.error(
            safeDiagnosticError(writeError, "Failed to save cleanup outcome"),
          ),
        );
        await createDeploymentLogs({
          deploymentId,
          createdBy: userId,
          message: target.error,
        }).catch((logError) => console.error(safeDiagnosticError(logError)));
      }
    }
    return cleanup;
  };

  const deploy = async (
    userId: string,
    deploymentId: number,
    deployment: DeploymentSnapshot | undefined,
    onRuntimeStarted: () => void,
  ) => {
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
    let environment: string[] | undefined;

    const loadEnvironment = async () => {
      if (!environment) {
        const envVars = await fetchEnvVars(
          deployment.app!.projectId,
          deployment.env,
        );
        registerDiagnosticSecrets(...envVars.map(({ value }) => value));
        environment = envVars.map(({ key, value }) => `${key}=${value}`);
      }
      return environment;
    };

    const finishRuntime = async (container: Docker.Container) => {
      // Recovered attempts have a fresh diagnostic scope. Load configured
      // secrets before attaching runtime output even when no build was needed.
      await loadEnvironment();
      await updateDeployment({ id: deploymentId, status: "success" }, userId);
      const startMessage = `Container started for ${appName} at ${appDomain}. Application readiness has not been checked.`;
      await createDeploymentLogs({
        deploymentId,
        message: startMessage,
        createdBy: userId,
      });
      console.log(startMessage);
      if (!committedImageId)
        throw new Error("Started runtime image identity unavailable");
      await recordPublication(
        { deploymentId, imageName, imageId: committedImageId },
        userId,
      );
      const oldContainers = await getDeploymentContainers(
        docker,
        deployment.appId,
        deploymentId,
        appDomain,
      );
      // Replacement retirement and cleanup recovery share this app's lock.
      const targets: DeploymentCleanupArtifact[] = oldContainers.map((old) => ({
        id: old.Id,
        kind: "prior runtime",
        labels: Object.fromEntries(
          Object.entries(old.Labels ?? {}).filter(([key]) =>
            key.startsWith("nmt."),
          ),
        ),
        replacementId: container.id,
        status: "pending",
      }));
      if (builderContainer)
        targets.push({
          id: builderContainer.id,
          kind: "builder",
          labels: {
            "nmt.deployment-id": String(deploymentId),
            "nmt.artifact": "builder",
          },
          status: "pending",
        });
      if (
        (
          await cleanupArtifacts(
            docker,
            deployment,
            deploymentId,
            userId,
            targets,
          )
        ).status === "pending"
      ) {
        throw new Error(
          "Artifact cleanup incomplete; retry cleanup without redeploying",
        );
      }
      void Promise.allSettled([
        streamDeploymentLogs(docker, container, deploymentId, userId),
        withAppLock(deployment.appId, () =>
          withAppLifecycleLock(deployment.appId, async () => {
            const current = await getDeployment(deploymentId, userId);
            if (!current) throw new Error("Publication not found");
            return publish(deploymentId, userId);
          }),
        ),
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
        committedImageId = details.Image;
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
        await loadEnvironment();
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
        if (URL.canParse(cloneUrl)) {
          const credentials = new URL(cloneUrl);
          registerDiagnosticSecrets(
            decodeURIComponent(credentials.username),
            decodeURIComponent(credentials.password),
          );
        }

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

        // Supply values without storing them in builder configuration or
        // generating a secret file.
        await loadEnvironment();

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
          environment,
        );

        await createDeploymentLogs({
          deploymentId,
          message: "Project dependencies installed successfully.",
          createdBy: userId,
        });

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
          environment,
        );

        await createDeploymentLogs({
          deploymentId,
          message: "Application built successfully.",
          createdBy: userId,
        });

        // Clone URLs and reflogs can retain installation credentials. Remove
        // repository metadata only after tools have finished building from it.
        // A failed removal must prevent committing or starting this image.
        await executeCommand(
          builderContainer,
          ["rm", "-rf", "--", "/app/.git"],
          "/app",
          "Remove build credentials",
        );

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

        Env: environment,

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
        const targets: DeploymentCleanupArtifact[] = [];
        if (deploymentContainer)
          targets.push({
            id: deploymentContainer.id,
            kind: "runtime",
            labels: {
              "nmt.app-id": String(deployment.appId),
              "nmt.deployment-id": String(deploymentId),
              "nmt.artifact": "runtime",
            },
            status: "pending",
          });
        if (builderContainer)
          targets.push({
            id: builderContainer.id,
            kind: "builder",
            labels: {
              "nmt.deployment-id": String(deploymentId),
              "nmt.artifact": "builder",
            },
            status: "pending",
          });
        if (committedImageId)
          targets.push({
            id: committedImageId,
            kind: "image",
            labels: {
              "nmt.deployment-id": String(deploymentId),
              "nmt.artifact": "image",
            },
            status: "pending",
          });
        if (targets.length)
          await cleanupArtifacts(
            docker,
            deployment,
            deploymentId,
            userId,
            targets,
          );
      }
    }
  };

  return async ({
    userId,
    deploymentId,
    action,
    operation,
  }: DeploymentRequest): Promise<DeploymentCleanup | void> =>
    withDeploymentDiagnostics(async () => {
      registerDiagnosticSecrets(registry.password);

      if (operation === "publish" && action !== "cleanup") {
        // Recovery has its own outcome. It never enters deployment finalization,
        // starts a container, or retires a runtime (including a newer release).
        const publication = await getPublication(deploymentId, userId);
        if (!publication) throw new Error("Publication not found");
        const deployment = await getDeployment(deploymentId, userId);
        if (!deployment) throw new Error("Publication not found");
        return withAppLock(deployment.appId, () =>
          withAppLifecycleLock(deployment.appId, async () => {
            // Eligibility can change while waiting for either app coordinator.
            const current = await getDeployment(deploymentId, userId);
            if (!current) throw new Error("Publication not found");
            return publish(deploymentId, userId);
          }),
        );
      }

      const reportFailure = async (
        failure: unknown,
        runtimeStarted = false,
      ): Promise<never> => {
        // An ineligible delivery has no authority to mutate this deployment.
        if (failure instanceof DeploymentNotFoundError) {
          throw safeDiagnosticError(failure);
        }
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
        deployment = await getDeployment(deploymentId, userId);
        if (!deployment) throw new DeploymentNotFoundError();
      } catch (failure) {
        if (action === "cleanup") throw safeDiagnosticError(failure);
        return reportFailure(failure);
      }
      const attempt = async () => {
        if (action === "cleanup") {
          try {
            // Read after taking the lock so recovery never overwrites a newer
            // attempt's ledger. This mode performs no build/start/status writes.
            const current = await getDeployment(deploymentId, userId);
            if (!current || current.userId !== userId)
              throw new Error("Deployment not found for cleanup owner");
            if (!current.cleanup)
              throw new Error(
                "No recorded cleanup; recover deployment execution before retrying cleanup",
              );
            const cleanup = await cleanupArtifacts(
              await getCleanupDocker(),
              current,
              deploymentId,
              userId,
            );
            await createDeploymentLogs({
              deploymentId,
              createdBy: userId,
              message:
                cleanup.status === "complete"
                  ? "Cleanup complete. Runtime-start outcome unchanged."
                  : "Cleanup incomplete; retry cleanup after resolving the removal error. Runtime-start outcome unchanged.",
            });
            return cleanup;
          } catch (failure) {
            throw safeDiagnosticError(failure);
          }
        }
        let runtimeStarted = false;
        try {
          // Recheck inside the existing app turn, before touching Docker.
          deployment = await getDeployment(deploymentId, userId);
          if (!deployment) throw new DeploymentNotFoundError();
          await deploy(userId, deploymentId, deployment, () => {
            runtimeStarted = true;
          });
        } catch (failure) {
          return reportFailure(failure, runtimeStarted);
        }
      };
      return withAppLock(deployment.appId, () =>
        withAppLifecycleLock(deployment!.appId, attempt),
      );
    });
};
