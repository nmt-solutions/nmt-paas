import { relations } from "drizzle-orm/_relations";
import {
  Apps,
  DeploymentLogs,
  Deployments,
  EnvVars,
  AppDomains,
  Projects,
} from "./schema";
import { FrameworkConfig } from "./tables/framework-config";

export const ProjectsRelations = relations(Projects, ({ many }) => ({
  apps: many(Apps, {
    relationName: "ProjectApps",
  }),
  envVars: many(EnvVars, {
    relationName: "ProjectEnvVars",
  }),
}));

export const AppsRelations = relations(Apps, ({ one, many }) => ({
  project: one(Projects, {
    relationName: "ProjectApps",
    fields: [Apps.projectId],
    references: [Projects.id],
  }),
  appDomains: many(AppDomains, {
    relationName: "AppDomains",
  }),
  deployments: many(Deployments, {
    relationName: "AppDeployments",
  }),
}));

export const AppDomainsRelations = relations(AppDomains, ({ one }) => ({
  app: one(Apps, {
    relationName: "AppDomains",
    fields: [AppDomains.appId],
    references: [Apps.id],
  }),
}));

export const DeploymentsRelations = relations(Deployments, ({ one, many }) => ({
  app: one(Apps, {
    relationName: "AppDeployments",
    fields: [Deployments.appId],
    references: [Apps.id],
  }),
  deploymentLogs: many(DeploymentLogs, {
    relationName: "DeploymentLogs",
  }),
}));

export const DeploymentLogsRelations = relations(DeploymentLogs, ({ one }) => ({
  deployment: one(Deployments, {
    relationName: "DeploymentLogs",
    fields: [DeploymentLogs.deploymentId],
    references: [Deployments.id],
  }),
}));

export const EnvVarsRelations = relations(EnvVars, ({ one }) => ({
  project: one(Projects, {
    relationName: "ProjectEnvVars",
    fields: [EnvVars.projectId],
    references: [Projects.id],
  }),
}));

export const FrameworkConfigRelations = relations(
  FrameworkConfig,
  ({ one }) => ({
    app: one(Apps, {
      relationName: "AppFrameworkConfig",
      fields: [FrameworkConfig.appId],
      references: [Apps.id],
    }),
  }),
);
