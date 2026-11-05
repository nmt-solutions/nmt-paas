import assert from "node:assert/strict";
import { test } from "node:test";
import Docker from "dockerode";
import { createDockerCommandAdapter } from "../src/deployment/docker-command-adapter.js";
import {
  createDeploymentExecutor,
  type DeploymentExecutionDependencies,
} from "../src/deployment/execute-deployment.js";

// Explicit opt-in: needs a disposable local Docker daemon and public image/package access.
// The clone deliberately fails before any runtime, network, image commit, or registry push.
test(
  "real Docker preparation and command failure use the production execution path",
  { timeout: 180_000 },
  async (t) => {
    const docker = new Docker({
      socketPath:
        process.platform === "win32"
          ? "//./pipe/docker_engine"
          : "/var/run/docker.sock",
    });
    await docker.ping();

    const deploymentId = Date.now();
    const builder = docker.getContainer(`builder-${deploymentId}`);
    const notFound = (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404;
    await assert.rejects(builder.inspect(), notFound);
    t.after(async () => {
      // Restrict fallback cleanup to this run's previously absent builder name.
      try {
        await builder.remove({ force: true });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    });

    const deployment = {
      appId: deploymentId,
      repoId: 1,
      branch: "fixture",
      commit: "0000000000000000000000000000000000000000",
      env: "production" as const,
      status: "queued",
      app: {
        appName: "ticket-9-smoke",
        projectId: deploymentId,
        appDomains: [
          { domain: "ticket-9-smoke.invalid", env: "production" as const },
        ],
        frameworkConfig: {
          port: 3000,
          rootDirectory: "./",
          installCommand: "true",
          buildCommand: "true",
          startCommand: "true",
        },
      },
    };
    const logs: string[] = [];
    const database = {
      getDeployment: async () => deployment,
      updateDeployment: async (params: { status: string }) => {
        deployment.status = params.status;
      },
      createDeploymentLogs: async (log: { message: string }) => {
        logs.push(log.message);
      },
    };
    const dependencies: DeploymentExecutionDependencies = {
      ...database,
      getDocker: async () => docker,
      ...createDockerCommandAdapter({
        ...database,
        getDocker: async () => docker,
      }),
      getCloneUrl: async () => `/ticket-9-missing-fixture-${deploymentId}`,
      fetchEnvVars: async () => [],
      registry: { username: "fixture", password: "fixture-only" },
    };

    await assert.rejects(
      createDeploymentExecutor(dependencies)({
        userId: "fixture-owner",
        deploymentId,
      }),
      /Clone repository failed \(exit code 128\)/,
    );

    assert.equal((await database.getDeployment()).status, "failed");
    assert.equal(
      logs.some((log) => log.includes("does not exist")),
      true,
    );
    await assert.rejects(builder.inspect(), notFound);
  },
);

test(
  "real Docker builder startup failure releases the container acquired during preparation",
  { timeout: 180_000 },
  async (t) => {
    const docker = new Docker({
      socketPath:
        process.platform === "win32"
          ? "//./pipe/docker_engine"
          : "/var/run/docker.sock",
    });
    await docker.ping();

    const deploymentId = Date.now();
    const builder = docker.getContainer(`builder-${deploymentId}`);
    const notFound = (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404;
    await assert.rejects(builder.inspect(), notFound);
    t.after(async () => {
      try {
        await builder.remove({ force: true });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    });

    // Inject an invalid executable at the Docker boundary. Creation and the
    // failing start still go to the real daemon through the production adapter.
    const createContainer = docker.createContainer.bind(docker);
    t.mock.method(
      docker,
      "createContainer",
      async (options: Docker.ContainerCreateOptions) =>
        createContainer({
          ...options,
          Cmd: ["/ticket-11-missing-builder-command"],
        }),
    );
    const deployment = {
      appId: deploymentId,
      repoId: 1,
      branch: "fixture",
      commit: "abc123",
      env: "production" as const,
      status: "queued",
      app: {
        appName: "ticket-11-smoke",
        projectId: deploymentId,
        appDomains: [
          { domain: "ticket-11-smoke.invalid", env: "production" as const },
        ],
        frameworkConfig: {
          port: 3000,
          rootDirectory: "./",
          installCommand: "true",
          buildCommand: "true",
          startCommand: "true",
        },
      },
    };
    const logs: string[] = [];
    const database = {
      getDeployment: async () => deployment,
      updateDeployment: async (params: { status: string }) => {
        deployment.status = params.status;
      },
      createDeploymentLogs: async (log: { message: string }) => {
        logs.push(log.message);
      },
    };
    const dependencies: DeploymentExecutionDependencies = {
      ...database,
      getDocker: async () => docker,
      ...createDockerCommandAdapter({
        ...database,
        getDocker: async () => docker,
      }),
      getCloneUrl: async () => {
        throw new Error("Preparation should fail before cloning");
      },
      fetchEnvVars: async () => [],
      registry: { username: "fixture", password: "fixture-only" },
    };

    await assert.rejects(
      createDeploymentExecutor(dependencies)({
        userId: "fixture-owner",
        deploymentId,
      }),
      /Prepare builder/,
    );
    assert.equal((await database.getDeployment()).status, "failed");
    assert.match(logs.at(-1)!, /Prepare builder/);
    assert.equal(
      logs.some((log) => log.includes("Cleanup failed")),
      false,
    );
    await assert.rejects(builder.inspect(), notFound);
  },
);
