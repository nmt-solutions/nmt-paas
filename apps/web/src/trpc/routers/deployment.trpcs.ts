import z from "zod";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import {
  getAppByRepoId,
  getUserApp,
  hasUserAppForRepo,
} from "@repo/database/access-layer/apps.dal";
import {
  getDeploymentSubmission,
  getAppDispatches,
} from "@repo/database/access-layer/deployment-dispatch.dal";
import {
  deployProject,
  initializeNewProjectAndDeploy,
} from "@/services/projects";
import { TRPCError } from "@trpc/server";
import { getDeployment } from "@repo/database/access-layer/deployment.dal";
import {
  deploymentSubmission,
  dispatchSubmission,
  existingSubmission,
  submissionResult,
} from "@/services/deployment-dispatch";

export const deploymentRouter = createTRPCRouter({
  submission: authenticatedProcedure
    .input(z.object({ submissionId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const accepted = await getDeploymentSubmission(
        ctx.userInfo.user.id,
        input.submissionId,
      );
      return accepted &&
        (await getDeployment(accepted.deployment.id, ctx.userInfo.user.id))
        ? submissionResult(accepted)
        : null;
    }),
  dispatches: authenticatedProcedure
    .input(z.object({ appId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      if (!(await getUserApp(input.appId, ctx.userInfo.user.id)))
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      return getAppDispatches(input.appId, ctx.userInfo.user.id);
    }),
  deploy: authenticatedProcedure
    .input(
      z.object({
        submissionId: z.uuid().optional(),
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
        branch: z
          .string({ error: "Branch must be a string" })
          .trim()
          .min(1, "Branch is required")
          .optional(),
        projectName: z.string().trim().min(1).max(80).optional(),
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
            port: z
              .number({ error: "Port is required" })
              .nonnegative({ error: "Port must be a +ve int." })
              .nonoptional({ error: "Port is required" }),
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
      const { submissionId, ...request } = input;
      const submission = deploymentSubmission(userId, submissionId, {
        operation: "deploy",
        ...request,
      });
      if (await existingSubmission(submission))
        return dispatchSubmission(submission);
      const { repoId, repo, owner, branch, envVars, frameworkConfig } = input;

      const app = await getAppByRepoId(repoId, userId);

      if (!app) {
        if (await hasUserAppForRepo(repoId, userId)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
        }
        if (!frameworkConfig) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Framework configuration is required for first time deployment",
          });
        }

        await initializeNewProjectAndDeploy({
          submission,
          userId,
          repoId,
          repo,
          owner,
          projectName: input.projectName,
          branch,
          envVars,
          frameworkConfig,
        });

        return dispatchSubmission(submission);
      }

      if (!branch?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Branch is required",
        });
      }

      await deployProject({
        submission,
        userId,
        repoId,
        repo,
        owner,
        branch,
        appId: app.id,
      });

      return dispatchSubmission(submission);
    }),
});
