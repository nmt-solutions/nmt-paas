import { TRPCError } from "@trpc/server";
import z from "zod";
import { getGithubRepoFrameworkPreset } from "@/services/github";
import { authenticatedProcedure, createTRPCRouter } from "../init";

export const frameworkRouter = createTRPCRouter({
  getFrameworkPreset: authenticatedProcedure
    .input(
      z.object({
        provider: z.enum(["github"]),
        owner: z
          .string({ error: "Owner must be a string." })
          .nonoptional({ error: "Owner is required." }),
        repository: z
          .string({ error: "Repository must be a string." })
          .nonoptional({ error: "Repository is required." }),
        branch: z
          .string({ error: "Branch must be a string." })
          .nonoptional({ error: "Branch is required." }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;

      const { provider, owner, repository, branch } = input;

      if (provider === "github") {
        return getGithubRepoFrameworkPreset(userId, owner, repository, branch);
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Git provider not supported",
      });
    }),
});
