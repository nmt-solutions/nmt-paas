import {
  createUserAppInstall,
  getUserAppInstall,
  updateUserAppInstall,
} from "@/database/access-layer/github.dal";
import env from "@/env/vars";
import { tryCatch } from "@/utils/try-catch";
import { TRPCError } from "@trpc/server";
import { App } from "octokit";
import z from "zod";
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

    if (appInstall.state === "completed") {
      return {
        url: `https://github.com/apps/${env.variables.GITHUB_APP_SLUG}/installations/new?state=${appInstall.id}`,
        redirect: false,
        message: "Github Account Connected.",
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

      const appInstall = await getUserAppInstall(userId);

      if (!appInstall) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Malformed Request",
        });
      }

      const appInstallId = state;

      if (appInstallId !== appInstall.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Malformed Request",
        });
      }

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

      const { data: user, error: userError } = await tryCatch(
        octokit.rest.apps.getAuthenticated(),
      );

      if (userError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: userError.message,
        });
      }

      await updateUserAppInstall(
        {
          id: appInstallId,
          installationId,
        },
        userId,
      );

      return {
        message: "Github Connected!",
        user,
      };
    }),
});
