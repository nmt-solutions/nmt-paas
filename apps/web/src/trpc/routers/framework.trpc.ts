import { TRPCError } from "@trpc/server";
import z from "zod";
import { getGithubRepoFrameworkPreset } from "@/services/github";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import { FRAMEWORK_PRESETS } from "@/constants/frameworks";

export const frameworkRouter = createTRPCRouter({
  getFrameworks: authenticatedProcedure.query(async () => {
    const presets = FRAMEWORK_PRESETS("github");

    return Object.entries(presets).map(([, preset]) => preset);
  }),

  getFrameworkPreset: authenticatedProcedure
    .input(
      z.object({
        provider: z.enum(["github"]),
        owner: z
          .string({ error: "Owner must be a string." })
          .nonoptional({ error: "Owner is required." }),
        repo: z
          .string({ error: "Repository must be a string." })
          .nonoptional({ error: "Repository is required." }),
        branch: z
          .string({ error: "Branch must be a string." })
          .nonoptional({ error: "Branch is required." }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;

      const { provider, owner, repo, branch } = input;

      if (provider === "github") {
        return getGithubRepoFrameworkPreset({
          userId,
          owner,
          repo,
          branch,
        });
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Git provider not supported",
      });
    }),
});
