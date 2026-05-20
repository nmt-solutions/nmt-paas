import { TRPCError } from "@trpc/server";
import { App, RequestError } from "octokit";
import { FRAMEWORK_DEFAULT_CONFIGS } from "@/constants/frameworks";
import { getUserAppInstall } from "@/database/access-layer/github.dal";
import env from "@/env/vars";
import type { FrameworkDefaultConfig } from "@/models/framework";
import { tryCatch } from "@/utils/try-catch";

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
) {
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

  const { data: installedApp, error: installedAppError } = await tryCatch(
    octokit.request("GET /apps/{app_slug}", {
      app_slug: env.variables.GITHUB_APP_SLUG,
    }),
  );

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

  return { app, octokit, installedApp };
}

export async function getUserGithubOctokit(userId: string) {
  const installationId = await getUserGithubAppInstallationId(userId);

  const { app, octokit, installedApp } =
    await getUserGithubOctokitByInstallationId(installationId);

  return { app, octokit, installationId, installedApp };
}

export async function getGithubRepoFrameworkPreset(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<FrameworkDefaultConfig> {
  const { octokit } = await getUserGithubOctokit(userId);

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
    return FRAMEWORK_DEFAULT_CONFIGS.node;
  }

  const fileNames = rootContents.data.map((file) => file.name);

  if (fileNames.includes("Dockerfile")) {
    return FRAMEWORK_DEFAULT_CONFIGS.docker;
  }

  if (!fileNames.includes("package.json")) {
    return FRAMEWORK_DEFAULT_CONFIGS.node;
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
    return FRAMEWORK_DEFAULT_CONFIGS.node;
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
    return FRAMEWORK_DEFAULT_CONFIGS.nextjs;
  }

  // Vite
  if (
    dependencies.vite ||
    fileNames.includes("vite.config.ts") ||
    fileNames.includes("vite.config.js")
  ) {
    return FRAMEWORK_DEFAULT_CONFIGS.vite;
  }

  // React
  if (dependencies.react || dependencies["react-scripts"]) {
    return FRAMEWORK_DEFAULT_CONFIGS.react;
  }

  // Generic Node.js
  return FRAMEWORK_DEFAULT_CONFIGS.node;
}
