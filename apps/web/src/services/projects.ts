import { tryCatch } from "@/utils/try-catch";
import {
  admitDeployment,
  type Submission,
} from "@repo/database/access-layer/deployment-dispatch.dal";
import { createProjectImport } from "@repo/database/access-layer/project-import.dal";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import { encrypt } from "./env-vars";
import { getUserGithubOctokit } from "./github";
import { admissionError } from "./deployment-dispatch";

export const deployProject = async (params: {
  octokit?: Octokit;
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
  appId: number;
  submission: Submission;
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

  const { data: deployment, error: admissionFailure } = await tryCatch(
    admitDeployment(
      {
        appId,
        branch: branch,
        commit: commit.sha,
        createdBy: userId,
        userId,
        repoId,
        env: "production",
      },
      params.submission,
    ),
  );

  if (admissionFailure) throw admissionError(admissionFailure);

  if (!deployment) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create a deployment",
    });
  }

  return deployment;
};

/** Queue a new production deployment using the repository already linked to an app. */
export const redeployApp = async ({
  userId,
  appId,
  repoId,
  branch,
  submission,
}: {
  userId: string;
  appId: number;
  repoId: number;
  branch: string;
  submission: Submission;
}) => {
  const { octokit } = await getUserGithubOctokit(userId);
  const { data: repository, error } = await tryCatch(
    octokit.request("GET /repositories/{repository_id}", {
      repository_id: repoId,
    }),
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
    submission,
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
  submission,
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
  submission: Submission;
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
        submission,
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
    throw admissionError(
      setupError,
      "Unable to initialize project. Check your projects before retrying.",
    );
  }

  return initialized;
};
