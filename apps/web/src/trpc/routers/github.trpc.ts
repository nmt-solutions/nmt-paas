import { TRPCError } from "@trpc/server";

import z from "zod";

import env from "@/env/vars";
import {
  getGithubRepositories,
  getUserGithubOctokit,
  getUserGithubOctokitByInstallationId,
} from "@/services/github";
import { tryCatch } from "@/utils/try-catch";
import {
  createUserAppInstall,
  getUserAppInstall,
  updateUserAppInstall,
} from "@repo/database/access-layer/github.dal";
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
        app: installedApp.appName,
      };
    }),

  getGithubConnected: authenticatedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    const { error } = await tryCatch(getUserGithubOctokit(userId));

    if (error) {
      return { connected: false };
    }

    return { connected: true };
  }),

  getGithubAppForUser: authenticatedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    const { installedApp } = await getUserGithubOctokit(userId);

    return {
      connected: installedApp.appName != null,
      appName: installedApp.appName,
    };
  }),

  getUserGithubRepos: authenticatedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;

    return getGithubRepositories(userId);
  }),
});
