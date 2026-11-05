import { tryCatch } from "@/utils/try-catch";
import { createDeployment } from "@repo/database/access-layer/deployment.dal";
import { createProjectImport } from "@repo/database/access-layer/project-import.dal";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import { encrypt } from "./env-vars";
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
  projectName,
  branch,
  envVars,
  frameworkConfig,
}: {
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  projectName?: string;
  branch?: string;
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

  const selectedBranch = branch ?? repository.default_branch;
  const { data: commitsData, error: commitsError } = await tryCatch(
    octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: repository.owner.login,
      repo: repository.name,
      ref: selectedBranch,
    }),
  );
  if (commitsError) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Unable to get repository commit",
    });
  }

  const { data: initialized, error: setupError } = await tryCatch(
    // Keep the established encrypted format; plaintext never enters persistence.
    Promise.resolve().then(() =>
      createProjectImport({
        userId,
        repoId,
        projectName: projectName ?? `${repository.name.toLowerCase()}-project`,
        appName: repository.name.toLowerCase().replace(" ", "-"),
        branch: selectedBranch,
        commit: commitsData.data.sha,
        frameworkConfig,
        envVars: envVars.map(({ key, value }) => ({
          key,
          encryptedValue: encrypt(value),
        })),
      }),
    ),
  );
  if (setupError) {
    // Database errors can include SQL parameters and encrypted configuration.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Unable to initialize project. Check your projects before retrying.",
    });
  }

  const response = await cpApiClient.queueDeployment(
    initialized.deployment.id,
    userId,
  );
  if (response.status === "error") throw new Error(response.message);
  return initialized;
};
