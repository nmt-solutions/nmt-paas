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

  const container = await createBuilderContainer(deploymentId);

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

  const cloneUrl = await getCloneUrl(userId, deployment.app?.appName ?? "");

  await executeCommand(container, ["sh", "-c", `git clone ${cloneUrl} .`]);

  await createDeploymentLogs({
    deploymentId,
    message: `${deployment.app?.appName} repository cloned successfully.`,
    createdBy: userId,
  });

  await executeCommand(container, [
    "sh",
    "-c",
    `git checkout ${deployment.branch}`,
  ]);

  await createDeploymentLogs({
    deploymentId,
    message: `Git branch switched to ${deployment.branch}`,
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
    message: `Installing project dependencies...`,
    createdBy: userId,
  });

  const rootDirectory =
    frameworkConfig.rootDirectory === "./" ||
    frameworkConfig.rootDirectory === "/"
      ? "/app"
      : `/app/${frameworkConfig.rootDirectory.replace(/^\.?\//, "")}`;

  await executeCommand(container, ["sh", "-c", installCommand, rootDirectory]);

  await createDeploymentLogs({
    deploymentId,
    message: `Project dependencies installed successfully.`,
    createdBy: userId,
  });

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
    container,
    [
      "sh",
      "-c",
      `cat > .env << 'EOF'
       ${envVars}
       EOF
      `,
    ],
    rootDirectory,
  );

  await createDeploymentLogs({
    deploymentId,
    message: `Building application...`,
    createdBy: userId,
  });

  await executeCommand(container, ["sh", "-c", buildCommand], rootDirectory);

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

  await updateDeployment(
    {
      id: deploymentId,
      status: "starting",
    },
    userId,
  );

  await createDeploymentLogs({
    deploymentId,
    message: `Deploying application...`,
    createdBy: userId,
  });

  const deploymentContainer = await docker.createContainer({
    name: `deployment-${deploymentId}`,

    Image: `ghcr.io/${env.variables.GITHUB_USER_NAME}/${deploymentId}:${deploymentId}`,

    Labels: {
      "traefik.enable": "true",

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
};

new Worker(
  "deployment-queue",

  async (job: { data: { userId: string; deploymentId: number } }) => {
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
