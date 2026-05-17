import { TRPCError } from "@trpc/server";
import { App, RequestError } from "octokit";
import z from "zod";
import {
  createUserAppInstall,
  getUserAppInstall,
  updateUserAppInstall,
} from "@/database/access-layer/github.dal";
import env from "@/env/vars";
import { tryCatch } from "@/utils/try-catch";
import { authenticatedProcedure, createTRPCRouter } from "../init";

export const githubRouter = createTRPCRouter({
  connectGithub: authenticatedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    const appInstall = await getUserAppInstall(userId);

    if (!appInstall) {
      const appInstalls = await createUserAppInstall(userId);

      const appInstall = appInstalls.at(0);

      if (!appInstall) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error occured while initiating github connect.",
        });
      }

      return {
        url: `https://github.com/apps/${env.variables.GITHUB_APP_SLUG}/installations/new?state=${appInstall.id}`,
        redirect: true,
        message: "Redirecting to Github App Install Wizard.",
      };
    }

    return {
      url: `https://github.com/apps/${env.variables.GITHUB_APP_SLUG}/installations/new?state=${appInstall.id}`,
      redirect: true,
      message: "Redirecting to Github App Install Wizard.",
    };
  }),

  verifyGithubInstall: authenticatedProcedure
    .input(
      z.object({
        installationId: z
          .string()
          .nonempty({ error: "Installation Id is required." })
          .nonoptional({ error: "Installation Id is required." })
          .transform((val) => Number.parseInt(val, 10)),
        state: z
          .string()
          .nonempty({ error: "State is required." })
          .nonoptional({ error: "State is required." })
          .transform((val) => Number.parseInt(val, 10)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;

      const { installationId, state } = input;
      const appInstallId = state;

      const { installedApp } =
        await getUserGithubOctokitByInstallationId(installationId);

      await updateUserAppInstall(
        {
          id: appInstallId,
          installationId,
        },
        userId,
      );

      return {
        message: "Github Connected!",
        app: installedApp.data?.name,
      };
    }),

  getGithubAppForUser: authenticatedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    const { installedApp } = await getUserGithubOctokit(userId);

    return { app: installedApp };
  }),

  getUserGithubRepos: authenticatedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    const { octokit, installationId } = await getUserGithubOctokit(userId);

    const { data: repositories, error: fetchUserReposError } = await tryCatch(
      octokit.request("GET /installation/repositories", {
        installation_id: installationId,
      }),
    );

    if (fetchUserReposError) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: fetchUserReposError.message,
      });
    }

    return repositories.data;
  }),
});

async function getUserGithubAppInstallationId(userId: string) {
  const { data: appInstall, error: appInstallError } = await tryCatch(
    getUserAppInstall(userId),
  );

  if (appInstallError) {
    console.error(appInstallError);

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

async function getUserGithubOctokitByInstallationId(installationId: number) {
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

async function getUserGithubOctokit(userId: string) {
  const installationId = await getUserGithubAppInstallationId(userId);

  const { app, octokit, installedApp } =
    await getUserGithubOctokitByInstallationId(installationId);

  return { app, octokit, installationId, installedApp };
}
