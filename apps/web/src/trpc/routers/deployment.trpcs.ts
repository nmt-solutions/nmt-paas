import z from "zod";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import { getAppByRepoId } from "@repo/database/access-layer/apps.dal";
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
        frameworkConfig: z
          .object({
            framework: z
              .string({ error: "Framework is required" })
              .nonempty({ error: "Framework is required" }),
            rootDirectory: z
              .string({ error: "Root directory is required" })
              .nonempty({ error: "Root directory is required" }),
            installCommand: z
              .string({ error: "Install command is required" })
              .nonempty({ error: "Install command is required" }),
            buildCommand: z
              .string({ error: "Build command is required" })
              .nonempty({ error: "Build command is required" }),
            startCommand: z
              .string({ error: "Start command is required" })
              .nonempty({ error: "Start command is required" }),
            outputDirectory: z
              .string({ error: "Output directory is required" })
              .nonempty({ error: "Output directory is required" }),
          })
          .optional(),
        envVars: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .optional()
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userInfo.user.id;
      const { repoId, repo, owner, branch, envVars, frameworkConfig } = input;

      const app = await getAppByRepoId(repoId);

      if (!app) {
        if (!frameworkConfig) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Framework configuration is required for first time deployment",
          });
        }

        await initializeNewProjectAndDeploy({
          userId,
          repoId,
          repo,
          owner,
          envVars,
          frameworkConfig,
        });

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
        appId: app.id,
      });

      return { message: "Deployment Queued" };
    }),
});
