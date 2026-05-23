import { createProject } from "@repo/database/access-layer/project.dal";
import { createDeployment } from "@repo/database/access-layer/deployment.dal";
import { getUserGithubOctokit } from "./github";
import { tryCatch } from "@/utils/try-catch";
import { TRPCError } from "@trpc/server";
import { deploymentQueue } from "@repo/queues";
import { Octokit } from "octokit";

export const deployProject = async (params: {
  octokit?: Octokit;
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
  projectId: number;
}) => {
  const { projectId, userId, owner, repoId, repo, branch } = params;

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
    projectId: projectId,
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
    deploymentId: deployment.id,
  });
};

export const initializeNewProjectAndDeploy = async ({
  userId,
  repoId,
  owner,
  repo,
}: {
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
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
    name: repository.html_url.split("/").at(-1)?.toLowerCase() as string,
    gitProvider: "github",
    repoId: repoId,
    createdBy: userId,
    userId,
  });

  if (!project) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to create a project",
    });
  }

  await deployProject({
    octokit,
    userId,
    repoId,
    repo,
    owner,
    branch: repository.default_branch,
    projectId: project.id,
  });
};
