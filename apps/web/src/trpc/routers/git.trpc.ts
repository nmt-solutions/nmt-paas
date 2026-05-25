import z from "zod";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import {
  getGithubRepoAndFrameworkPreset,
  getGithubRepositories,
} from "@/services/github";
import { TRPCError } from "@trpc/server";

export const gitRouter = createTRPCRouter({
  getRepositories: authenticatedProcedure
    .input(
      z.object({
        gitProvider: z.enum(["github"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;
      const { gitProvider } = input;

      if (gitProvider === "github") {
        return getGithubRepositories(userId);
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Git provider not supported.",
      });
    }),
  getRepository: authenticatedProcedure
    .input(
      z.object({
        gitProvider: z.enum(["github"]),
        repoId: z.string().nonempty({ error: "Repository Id is required." }),
        repo: z.string().nonempty({ error: "Repository Name is required." }),
        branch: z.string().nonempty({ error: "Branch is required." }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;
      const { gitProvider, repo, branch } = input;

      if (gitProvider === "github") {
        const repoAndPreset = await getGithubRepoAndFrameworkPreset({
          userId,
          repo,
          branch,
        });

        return repoAndPreset;
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Git provider not supported.",
      });
    }),
});
