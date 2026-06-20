import { saveEnvVars } from "./env-vars";
import { createProject } from "@repo/database/access-layer/project.dal";
import { createDeployment } from "@repo/database/access-layer/deployment.dal";
import { getUserGithubOctokit } from "./github";
import { tryCatch } from "@/utils/try-catch";
import { TRPCError } from "@trpc/server";
import { deploymentQueue } from "@repo/queues";
import { Octokit } from "octokit";
import { createApp } from "@repo/database/access-layer/apps.dal";
import { createFrameworkConfig } from "@repo/database/access-layer/framework-config.dal";

export const deployProject = async (params: {
  octokit?: Octokit;
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
  appId: number;
}) => {
  const { appId, userId, owner, repoId, repo, branch } = params;

  const octokit =
    params.octokit ?? (await getUserGithubOctokit(userId)).octokit;

  const { data: commitsData, error: commitsError } = await tryCatch(
    octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: branch,
    }),
  );

  if (commitsError) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Unable to get repository commit",
    });
  }

  const commit = commitsData.data;

  const deployment = await createDeployment({
    appId,
    branch: branch,
    commit: commit.sha,
    createdBy: userId,
    userId,
    repoId,
    env: "production",
  });

  if (!deployment) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create a deployment",
    });
  }

  await deploymentQueue.add("deployment-queue", {
    userId: params.userId,
    deploymentId: deployment.id,
  });
};

export const initializeNewProjectAndDeploy = async ({
  userId,
  repoId,
  owner,
  repo,
  envVars,
  frameworkConfig,
}: {
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  envVars: { key: string; value: string }[];
  frameworkConfig: {
    framework: string;
    rootDirectory: string;
    installCommand: string;
    buildCommand: string;
    startCommand: string;
    outputDirectory: string;
  };
}) => {
  const { octokit } = await getUserGithubOctokit(userId);

  const { data: repoData, error: repoError } = await tryCatch(
    octokit.request("GET /repos/{owner}/{repo}", { owner, repo }),
  );

  if (repoError) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Repository not found",
    });
  }

  const repository = repoData.data;

  const project = await createProject({
    name: `${repository.html_url.split("/").at(-1)?.toLowerCase() ?? ""}-project`,
    createdBy: userId,
    userId,
  });

  if (!project) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create a project",
    });
  }

  const { data: app, error } = await tryCatch(
    createApp({
      repoId,
      projectId: project.id,
      createdBy: userId,
      appName: repository.html_url.split("/").at(-1)?.toLowerCase() as string,
      gitProvider: "github",
    }),
  );

  if (!app) {
    console.error("Error creating app:", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create an app",
    });
  }

  const fc = await createFrameworkConfig({
    appId: app.id,
    framework: frameworkConfig.framework,
    rootDirectory: frameworkConfig.rootDirectory,
    installCommand: frameworkConfig.installCommand,
    buildCommand: frameworkConfig.buildCommand,
    startCommand: frameworkConfig.startCommand,
    outputDirectory: frameworkConfig.outputDirectory,
    createdBy: userId,
  });

  if (!fc) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create framework config",
    });
  }

  if (envVars.length > 0) {
    const savedEnvVars = await saveEnvVars(
      envVars,
      project.id,
      "production",
      userId,
    );

    if (savedEnvVars.length !== envVars.length) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to save all environment variables",
      });
    }
  }

  await deployProject({
    octokit,
    userId,
    repoId,
    repo,
    owner,
    branch: repository.default_branch,
    appId: app.id,
  });
};
