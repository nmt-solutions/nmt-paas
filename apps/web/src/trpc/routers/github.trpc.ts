import { TRPCError } from "@trpc/server";
import { createHash, randomBytes } from "node:crypto";

import z from "zod";

import env from "@/env/vars";
import {
  getGithubRepositories,
  getUserGithubOctokit,
  getUserGithubOctokitByInstallationId,
  requireGithubUserAuthorization,
  verifyGithubInstallationAccess,
} from "@/services/github";
import { tryCatch } from "@/utils/try-catch";
import {
  startUserGithubConnection,
  getPendingUserGithubConnection,
  completeUserGithubConnection,
} from "@repo/database/access-layer/github.dal";
import { authenticatedProcedure, createTRPCRouter } from "../init";

const hashState = (state: string) =>
  createHash("sha256").update(state).digest("hex");
const invalidState = () =>
  new TRPCError({
    code: "BAD_REQUEST",
    message:
      "Invalid or expired GitHub connection. Start Connect Github again.",
  });

export const githubRouter = createTRPCRouter({
  connectGithub: authenticatedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.userInfo.user.id;
    requireGithubUserAuthorization();

    const state = randomBytes(32).toString("hex");
    await startUserGithubConnection(
      userId,
      hashState(state),
      new Date(Date.now() + 15 * 60 * 1000),
    );

    return {
      url: `https://github.com/apps/${env.variables.GITHUB_APP_SLUG}/installations/new?state=${state}`,
      redirect: true,
      message: "Redirecting to Github App Install Wizard.",
    };
  }),

  verifyGithubInstall: authenticatedProcedure
    .input(
      z.object({
        installationId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
        state: z.string().regex(/^[a-f0-9]{64}$/),
        code: z.string().min(1).max(512),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;

      const { installationId, state } = input;
      const connectionStateHash = hashState(state);
      if (!(await getPendingUserGithubConnection(userId, connectionStateHash)))
        throw invalidState();

      await verifyGithubInstallationAccess(installationId, input.code);

      const { installedApp } =
        await getUserGithubOctokitByInstallationId(installationId);

      const completed = await completeUserGithubConnection(
        userId,
        connectionStateHash,
        installationId,
      );
      if (!completed.length) throw invalidState();

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
