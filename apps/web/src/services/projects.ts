import { tryCatch } from "@/utils/try-catch";
import { createAppDomains } from "@repo/database/access-layer/app-domains.dal";
import { createApp } from "@repo/database/access-layer/apps.dal";
import { createDeployment } from "@repo/database/access-layer/deployment.dal";
import { createFrameworkConfig } from "@repo/database/access-layer/framework-config.dal";
import { createProject } from "@repo/database/access-layer/project.dal";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import { saveEnvVars } from "./env-vars";
import { getUserGithubOctokit } from "./github";
import cpApiClient from "./cp-api-client";

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

  const response = await cpApiClient.queueDeployment(
    deployment.id,
    params.userId,
  );

  console.log("response", response);

  if (response.status === "error") {
    throw new Error(response.message);
  }

  return deployment;
};

/** Queue a new production deployment using the repository already linked to an app. */
export const redeployApp = async ({
  userId,
  appId,
  repoId,
  branch,
}: {
  userId: string;
  appId: number;
  repoId: number;
  branch: string;
}) => {
  const { octokit } = await getUserGithubOctokit(userId);
  const { data: repository, error } = await tryCatch(
    octokit.request("GET /repositories/{repository_id}", { repository_id: repoId }),
  );

  if (error || !repository.data.owner?.login) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Unable to access the connected GitHub repository.",
    });
  }

  return deployProject({
    octokit,
    userId,
    appId,
    repoId,
    owner: repository.data.owner.login,
    repo: repository.data.name,
    branch,
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
    port: number;
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
      appName: repository.html_url
        .split("/")
        .at(-1)
        ?.toLowerCase()
        ?.replace(" ", "-") as string,
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

  const { error: appDomainError } = await tryCatch(
    createAppDomains(app.id, app.appName, userId),
  );

  if (appDomainError) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to generate a domain",
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
    port: frameworkConfig.port,
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

  const deployment = await deployProject({
    octokit,
    userId,
    repoId,
    repo,
    owner,
    branch: repository.default_branch,
    appId: app.id,
  });

  return { app, project, deployment };
};
