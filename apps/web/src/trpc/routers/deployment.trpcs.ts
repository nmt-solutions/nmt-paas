import z from "zod";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import { getProjectByRepoId } from "@repo/database/access-layer/project.dal";
import {
  deployProject,
  initializeNewProjectAndDeploy,
} from "@/services/projects";
import { TRPCError } from "@trpc/server";

export const deploymentRouter = createTRPCRouter({
  deploy: authenticatedProcedure
    .input(
      z.object({
        repoId: z
          .number({ error: "Repo Id must be a positive integer" })
          .nonnegative({ error: "Repo Id must be a positive integer" })
          .nonoptional({ error: "Repo Id is required" }),
        repo: z
          .string({ error: "Repo must be a valid name string" })
          .nonempty({ error: "Repo is required" })
          .nonoptional({ error: "Repo is required" }),
        owner: z
          .string({ error: "Owner must be a valid string" })
          .nonempty({ error: "Owner is required" })
          .nonoptional({ error: "Owner is required" }),
        branch: z.string({ error: "Branch must be a string" }).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;
      const { repoId, repo, owner, branch } = input;

      const project = await getProjectByRepoId(repoId);

      if (!project) {
        await initializeNewProjectAndDeploy({ userId, repoId, repo, owner });

        return { message: "Deployment Queued" };
      }

      if (!branch?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Branch is required",
        });
      }

      await deployProject({
        userId,
        repoId,
        repo,
        owner,
        branch,
        projectId: project.id,
      });
    }),
});
