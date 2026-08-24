import cpApiClient from "@/services/cp-api-client";
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
import { deleteProject } from "@repo/database/access-layer/project.dal";

const appIdInput = z.object({ appId: z.number().int().positive() });

const requireApp = async (appId: number, userId: string) => {
  const app = await getUserApp(appId, userId);
  if (!app)
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  return app;
};

export const appRouter = createTRPCRouter({
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
      const app = await requireApp(input.appId, ctx.userInfo.user.id);
      const activeDeployment = [...app.deployments]
        .filter((deployment) => deployment.status === "success")
        .sort((a, b) => b.id - a.id)[0];
      if (activeDeployment) {
        try {
          await cpApiClient.deleteDockerResource(
            "containers",
            `deployment-${activeDeployment.id}`,
          );
        } catch (error) {
          console.warn(
            "Unable to remove the app container during deletion",
            error,
          );
        }
      }
      await updateApp(input.appId, ctx.userInfo.user.id, {
        resourceStatus: "inactive",
      });
      await deleteProject(app.projectId, ctx.userInfo.user.id);
      return { success: true };
    }),
  getLatestSuccessDeployment: authenticatedProcedure
    .input(appIdInput)
    .query(async ({ ctx, input }) => {
      const appId = input.appId;
      const userId = ctx.userInfo.user.id;

      return getAppLatestDeployment(appId, userId);
    }),
});
