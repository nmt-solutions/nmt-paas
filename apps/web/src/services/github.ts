import { INT_32_MAX } from "@/constants/common";
import { FRAMEWORK_PRESETS } from "@/constants/frameworks";
import env from "@/env/vars";
import type { FrameworkConfigPreset } from "@/models/framework";
import { GithubApp, GithubUser } from "@/models/github";
import { Repository } from "@/models/repositories";
import { tryCatch } from "@/utils/try-catch";
import { getUserAppInstall } from "@repo/database/access-layer/github.dal";
import { TRPCError } from "@trpc/server";
import { App, Octokit, RequestError } from "octokit";

export async function getUserGithubAppInstallationId(userId: string) {
  const { data: appInstall, error: appInstallError } = await tryCatch(
    getUserAppInstall(userId),
  );

  if (appInstallError) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to get app installation",
    });
  }

  if (!appInstall) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "App Installation Not Found",
    });
  }

  if (!appInstall.installationId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "App Installation Id Not Found",
    });
  }

  return appInstall.installationId;
}

export async function getUserGithubOctokitByInstallationId(
  installationId: number,
): Promise<{
  app: App;
  octokit: Octokit;
  installedApp: GithubApp;
  user: GithubUser;
}> {
  const app = new App({
    appId: env.variables.GITHUB_APP_ID,
    privateKey: env.variables.GITHUB_APP_PRIVATE_KEY,
  });

  const { data: octokit, error } = await tryCatch(
    app.getInstallationOctokit(installationId),
  );

  if (error) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }

  const [
    { data: installedApp, error: installedAppError },
    { data: installation, error: installationError },
  ] = await Promise.all([
    tryCatch(
      octokit.request("GET /apps/{app_slug}", {
        app_slug: env.variables.GITHUB_APP_SLUG,
      }),
    ),
    tryCatch(
      octokit.request("GET /app/installations/{installation_id}", {
        installation_id: installationId,
      }),
    ),
  ]);

  if (installedAppError) {
    if (installedAppError instanceof RequestError) {
      throw new TRPCError({
        code: installedAppError.status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
        message:
          installedAppError.status === 404
            ? "Github App is not installed."
            : installedAppError.message,
      });
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: installedAppError.message,
    });
  }

  if (!installedApp.data) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Insatlled app data not available",
    });
  }

  if (installationError) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: installationError.message,
    });
  }

  if (!installation.data) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Installation data not available",
    });
  }

  if (!installation.data.account) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Installation account not available",
    });
  }

  if (installation.data.suspended_by) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Github App installation is suspended by ${installation.data.suspended_by}. Reason: ${installation.data.suspended_by.name}`,
    });
  }

  return {
    app,
    octokit,
    installedApp: {
      id: installedApp.data.id,
      appName: installedApp.data.name,
      slug: installedApp.data.slug,
      description: installedApp.data.description ?? undefined,
    },
    user: installation.data.account as GithubUser,
  };
}

export async function getUserGithubOctokit(userId: string): Promise<{
  app: App;
  octokit: Octokit;
  installationId: number;
  installedApp: GithubApp;
  user: GithubUser;
}> {
  const installationId = await getUserGithubAppInstallationId(userId);

  const { app, octokit, installedApp, user } =
    await getUserGithubOctokitByInstallationId(installationId);

  return { app, octokit, installationId, installedApp, user };
}

export async function getGithubRepositories(userId: string) {
  const { octokit, installationId } = await getUserGithubOctokit(userId);

  const { data: repositories, error: fetchUserReposError } = await tryCatch(
    octokit.request("GET /installation/repositories", {
      installation_id: installationId,
      page: 1,
      per_page: INT_32_MAX,
    }),
  );

  if (fetchUserReposError) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: fetchUserReposError.message,
    });
  }

  const repos: Repository[] = repositories.data.repositories
    .map(
      (repo) =>
        ({
          id: repo.id,
          defaultBranch: repo.default_branch,
          name: repo.name,
          owner: { id: repo.owner.id, name: repo.owner.login },
          private: repo.private,
          slug: repo.html_url.split("/").at(-1) as string,
          updatedAt: (repo.updated_at
            ? Date.parse(repo.updated_at)
            : repo.created_at
              ? Date.parse(repo.created_at)
              : null) as number,
          url: repo.html_url,
        }) as Repository,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return { ...repositories.data, repositories: repos };
}

export async function getGithubRepository({
  octokitApp,
  userId,
  owner,
  repo,
}: {
  octokitApp?: Octokit;
  userId: string;
  owner: string;
  repo: string;
}): Promise<Repository> {
  const octokit = octokitApp ?? (await getUserGithubOctokit(userId)).octokit;

  const { data: githubRepo, error: fetchRepoError } = await tryCatch(
    octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo,
    }),
  );

  if (fetchRepoError) {
    if (fetchRepoError instanceof RequestError) {
      throw new TRPCError({
        code: fetchRepoError.status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
        message:
          fetchRepoError.status === 404
            ? "Repository not found."
            : fetchRepoError.message,
      });
    }

    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: fetchRepoError.message,
    });
  }

  const repository: Repository = {
    id: githubRepo.data.id,
    defaultBranch: githubRepo.data.default_branch,
    name: githubRepo.data.name,
    owner: { id: githubRepo.data.owner.id, name: githubRepo.data.owner.login },
    private: githubRepo.data.private,
    slug: githubRepo.data.html_url.split("/").at(-1) as string,
    updatedAt: (githubRepo.data.updated_at
      ? Date.parse(githubRepo.data.updated_at)
      : githubRepo.data.created_at
        ? Date.parse(githubRepo.data.created_at)
        : null) as number,
    url: githubRepo.data.html_url,
  };

  return repository;
}

export async function getGithubRepoFrameworkPreset({
  octokitApp,
  userId,
  owner,
  repo,
  branch,
}: {
  octokitApp?: Octokit;
  userId: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<FrameworkConfigPreset> {
  const octokit = octokitApp ?? (await getUserGithubOctokit(userId)).octokit;

  const { data: rootContents, error: rootContentsError } = await tryCatch(
    octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: "",
      ref: branch,
    }),
  );

  if (rootContentsError) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: rootContentsError.name,
    });
  }

  if (!Array.isArray(rootContents.data)) {
    return FRAMEWORK_PRESETS("github").unknown;
  }

  const fileNames = rootContents.data.map((file) => file.name);

  if (fileNames.includes("Dockerfile")) {
    return FRAMEWORK_PRESETS("github").docker;
  }

  if (!fileNames.includes("package.json")) {
    return FRAMEWORK_PRESETS("github").unknown;
  }

  const { data: packageJsonResponse, error: packageJsonResponseError } =
    await tryCatch(
      octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: "package.json",
        ref: branch,
      }),
    );

  if (packageJsonResponseError) {
    console.log("ERROR", packageJsonResponseError);

    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: packageJsonResponseError.message,
    });
  }

  if (
    Array.isArray(packageJsonResponse.data) ||
    !("content" in packageJsonResponse.data)
  ) {
    return FRAMEWORK_PRESETS("github").node;
  }

  const packageJsonContent = Buffer.from(
    packageJsonResponse.data.content,
    "base64",
  ).toString("utf-8");

  const packageJson = JSON.parse(packageJsonContent);

  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  // Next.js
  if (
    dependencies.next ||
    fileNames.includes("next.config.js") ||
    fileNames.includes("next.config.ts")
  ) {
    return FRAMEWORK_PRESETS("github").nextjs;
  }

  // Vite
  if (
    dependencies.vite ||
    fileNames.includes("vite.config.ts") ||
    fileNames.includes("vite.config.js")
  ) {
    return FRAMEWORK_PRESETS("github").vite;
  }

  // React
  if (dependencies.react || dependencies["react-scripts"]) {
    return FRAMEWORK_PRESETS("github").react;
  }

  return FRAMEWORK_PRESETS("github").unknown;
}

export async function getGithubRepoAndFrameworkPreset({
  userId,
  repo,
  branch,
}: {
  userId: string;
  repo: string;
  branch: string;
}): Promise<{
  repository: Repository;
  frameworkPreset: FrameworkConfigPreset;
}> {
  const { octokit, user } = await getUserGithubOctokit(userId);

  const [repository, frameworkPreset] = await Promise.all([
    getGithubRepository({
      octokitApp: octokit,
      userId,
      owner: user.login,
      repo,
    }),
    getGithubRepoFrameworkPreset({
      octokitApp: octokit,
      userId,
      owner: user.login,
      repo,
      branch,
    }),
  ]);

  return { repository, frameworkPreset };
}
