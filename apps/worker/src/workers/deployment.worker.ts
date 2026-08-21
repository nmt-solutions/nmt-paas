import { Worker } from "bullmq";

import { redis } from "@repo/redis";
import { getDeployment } from "@repo/database/access-layer/deployment.dal";
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

const deploy = async (userId: string, deploymentId: number) => {
  const deployment = await getDeployment(deploymentId);

  if (!deployment) {
    throw new Error("Deployment not found");
  }

  const installCommand = deployment.app?.frameworkConfig?.installCommand ?? "";
  const buildCommand = deployment.app?.frameworkConfig?.buildCommand ?? "";
  const startCommand = deployment.app?.frameworkConfig?.startCommand ?? "";

  const container = await createBuilderContainer(deploymentId);

  await createDeploymentLogs({
    deploymentId,
    message: `Cloning repository for ${deployment.app?.appName}...`,
    createdBy: userId,
  });

  const cloneUrl = await getCloneUrl(userId, deployment.app?.appName ?? "");

  await executeCommand(container, ["sh", "-c", `git clone ${cloneUrl} .`]);

  await createDeploymentLogs({
    deploymentId,
    message: `${deployment.app?.appName} repository cloned successfully.`,
    createdBy: userId,
  });

  await createDeploymentLogs({
    deploymentId,
    message: `Installing project dependencies...`,
    createdBy: userId,
  });

  await executeCommand(container, ["sh", "-c", installCommand]);

  await createDeploymentLogs({
    deploymentId,
    message: `Project dependencies installed successfully.`,
    createdBy: userId,
  });

  const envVars = fetchEnvVars(deployment.app?.projectId ?? 0, "production");

  await executeCommand(container, [
    "sh",
    "-c",
    `cat > .env << 'EOF'
     ${envVars}
     EOF
    `,
  ]);

  await createDeploymentLogs({
    deploymentId,
    message: `Building application...`,
    createdBy: userId,
  });

  await executeCommand(container, ["sh", "-c", buildCommand]);

  await createDeploymentLogs({
    deploymentId,
    message: `Application built successfully.`,
    createdBy: userId,
  });

  const result = await container.commit({
    repo: `ghcr.io/${env.variables.GITHUB_USER_NAME}/${deploymentId}`,
    tag: deploymentId.toString(),
    changes: [
      "WORKDIR /app",
      `CMD ["sh","-c","${startCommand.replace(/"/g, '\\"')}"]`,
    ],
  });

  await container.remove({ force: true });

  console.log("Commit Result:", result);

  const docker = await getDocker();

  const image = await docker.getImage(
    `ghcr.io/${env.variables.GITHUB_USER_NAME}/${deploymentId}:${deploymentId}`,
  );

  const stream = await image.push({
    authconfig: {
      username: env.variables.GITHUB_USER_NAME,
      password: env.variables.GITHUB_PAT,
      serveraddress: "ghcr.io",
    },
  });

  await createDeploymentLogs({
    deploymentId,
    message: `Deploying application...`,
    createdBy: userId,
  });

  // Labels: {
  //   "traefik.enable": "true",

  //   "traefik.http.routers.app.rule": "Host(`myapp.novaai.app`)",

  //   "traefik.http.routers.app.entrypoints": "websecure",

  //   "traefik.http.routers.app.tls.certresolver": "letsencrypt",

  //   "traefik.http.services.app.loadbalancer.server.port": "3000",
  // },

  const deploymentContainer = await docker.createContainer({
    name: `deployment-${deploymentId}`,
    Image: `ghcr.io/${env.variables.GITHUB_USER_NAME}/${deploymentId}:${deploymentId}`,
    Labels: {
      "traefik.enable": "true",

      "traefik.http.routers.myapp.rule": "Host(`myapp.localhost`)",

      "traefik.http.routers.myapp.entrypoints": "web",

      "traefik.http.services.myapp.loadbalancer.server.port": "4173",
    },
    ExposedPorts: {
      "4173/tcp": {},
    },
    HostConfig: {
      NetworkMode: "app-network",
    },
  });

  await deploymentContainer.start();

  const deploymentStream = await deploymentContainer.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
  });

  deploymentStream.on("data", async (chunk: Buffer) => {
    const log = `${chunk.toString("utf8").replace(/\0/g, "")}\n`;

    console.log(log);

    await createDeploymentLogs({
      deploymentId,
      message: log,
      createdBy: userId,
    });
  });

  await createDeploymentLogs({
    deploymentId,
    message: `${deployment.app?.appName} deployed successfully at ${"myapp.localhost:3000"}.`,
    createdBy: userId,
  });
};

new Worker(
  "deployment-queue",

  async (job: { data: { userId: string; deploymentId: number } }) => {
    const deploymentId = job.data.deploymentId;
    const userId = job.data.userId;

    const { error } = await tryCatch(deploy(userId, deploymentId));

    if (error) {
      console.log(error);
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
