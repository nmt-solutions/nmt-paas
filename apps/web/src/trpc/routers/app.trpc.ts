import { saveEnvVars } from "@/services/env-vars";
import {
  getAppLatestDeployment,
  getUserApp,
  updateApp,
} from "@repo/database/access-layer/apps.dal";
import {
  deactivateEnvVar,
  getEnvVarKeys,
} from "@repo/database/access-layer/env-vars.dal";
import { updateFrameworkConfig } from "@repo/database/access-layer/framework-config.dal";
import { TRPCError } from "@trpc/server";
import z from "zod";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import { retireApp, retirementStatus } from "@/services/apps";
import { redeployApp } from "@/services/projects";
import { readDeploymentLogs } from "@repo/database/access-layer/deployment-logs.dal";
import {
  DEPLOYMENT_LOG_MAX_PAGE_SIZE,
  DEPLOYMENT_LOG_PAGE_SIZE,
} from "@repo/database/access-layer/deployment-log-limits";

const appIdInput = z.object({ appId: z.number().int().positive() });

const withTimeout = <T>(operation: Promise<T>, milliseconds: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TRPCError({
          code: "TIMEOUT",
          message:
            "The deployment service did not respond in time. Please try again.",
        }),
      );
    }, milliseconds);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const requireApp = async (appId: number, userId: string) => {
  const app = await getUserApp(appId, userId);
  if (!app)
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  return app;
};

export const appRouter = createTRPCRouter({
  deploymentLogs: authenticatedProcedure
    .input(
      appIdInput
        .extend({
          deploymentId: z.number().int().positive(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(DEPLOYMENT_LOG_MAX_PAGE_SIZE)
            .default(DEPLOYMENT_LOG_PAGE_SIZE),
          before: z.number().int().positive().optional(),
          after: z.number().int().nonnegative().optional(),
        })
        .refine(
          (input) => input.before === undefined || input.after === undefined,
          {
            message: "Choose either before or after",
          },
        ),
    )
    .query(async ({ ctx, input }) => {
      const page = await readDeploymentLogs({
        ...input,
        userId: ctx.userInfo.user.id,
      });
      if (!page)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deployment not found",
        });
      return page;
    }),
  get: authenticatedProcedure
    .input(appIdInput)
    .query(async ({ ctx, input }) => {
      const app = await requireApp(input.appId, ctx.userInfo.user.id);
      return { ...app, envVars: await getEnvVarKeys(app.projectId) };
    }),
  updateConfig: authenticatedProcedure
    .input(
      appIdInput.extend({
        appName: z.string().min(1).max(80),
        rootDirectory: z.string().min(1),
        installCommand: z.string().min(1),
        buildCommand: z.string().min(1),
        startCommand: z.string().min(1),
        outputDirectory: z.string().min(1),
        port: z.number().int().min(1).max(65535),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireApp(input.appId, ctx.userInfo.user.id);
      await updateApp(input.appId, ctx.userInfo.user.id, {
        appName: input.appName,
      });
      await updateFrameworkConfig(input.appId, ctx.userInfo.user.id, input);
      return { success: true };
    }),
  addEnvVar: authenticatedProcedure
    .input(
      appIdInput.extend({
        key: z.string().min(1),
        value: z.string(),
        env: z.enum(["production", "preview"]).default("production"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const app = await requireApp(input.appId, ctx.userInfo.user.id);
      await saveEnvVars(
        [{ key: input.key, value: input.value }],
        app.projectId,
        input.env,
        ctx.userInfo.user.id,
      );
      return { success: true };
    }),
  deleteEnvVar: authenticatedProcedure
    .input(
      z.object({
        appId: z.number().int().positive(),
        envVarId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const app = await requireApp(input.appId, ctx.userInfo.user.id);
      const keys = await getEnvVarKeys(app.projectId);
      if (!keys.some((item) => item.id === input.envVarId))
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Environment variable not found",
        });
      await deactivateEnvVar(input.envVarId, ctx.userInfo.user.id);
      return { success: true };
    }),
  delete: authenticatedProcedure
    .input(appIdInput)
    .mutation(async ({ ctx, input }) => {
      return retireApp(input.appId, ctx.userInfo.user.id);
    }),
  retirementStatus: authenticatedProcedure
    .input(appIdInput)
    .query(({ ctx, input }) =>
      retirementStatus(input.appId, ctx.userInfo.user.id),
    ),
  redeploy: authenticatedProcedure
    .input(appIdInput)
    .mutation(async ({ ctx, input }) => {
      const app = await requireApp(input.appId, ctx.userInfo.user.id);
      const previousDeployment = [...app.deployments].sort(
        (a, b) => b.id - a.id,
      )[0];
      if (!previousDeployment) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This app has no previous deployment to redeploy.",
        });
      }
      const deployment = await withTimeout(
        redeployApp({
          userId: ctx.userInfo.user.id,
          appId: app.id,
          repoId: app.repoId,
          branch: previousDeployment.branch,
        }),
        20_000,
      );
      return { deploymentId: deployment.id, branch: previousDeployment.branch };
    }),
  getLatestSuccessDeployment: authenticatedProcedure
    .input(appIdInput)
    .query(async ({ ctx, input }) => {
      const appId = input.appId;
      const userId = ctx.userInfo.user.id;

      return getAppLatestDeployment(appId, userId);
    }),
});
