import { defineRelations } from "drizzle-orm";

import {
  Apps,
  DeploymentLogs,
  Deployments,
  EnvVars,
  AppDomains,
  Projects,
  FrameworkConfig,
  GithubAppInstallations,
} from "./schema";

export const relations = defineRelations(
  {
    Apps,
    AppDomains,
    Deployments,
    DeploymentLogs,
    EnvVars,
    FrameworkConfig,
    GithubAppInstallations,
    Projects,
  },
  (r) => ({
    Projects: {
      apps: r.many.Apps(),
      envVars: r.many.EnvVars(),
    },

    Apps: {
      project: r.one.Projects({
        from: r.Apps.projectId,
        to: r.Projects.id,
      }),

      appDomains: r.many.AppDomains(),

      deployments: r.many.Deployments(),

      frameworkConfig: r.one.FrameworkConfig(), // or one() if appId is unique
    },

    AppDomains: {
      app: r.one.Apps({
        from: r.AppDomains.appId,
        to: r.Apps.id,
      }),
    },

    Deployments: {
      app: r.one.Apps({
        from: r.Deployments.appId,
        to: r.Apps.id,
      }),

      deploymentLogs: r.many.DeploymentLogs(),
    },

    DeploymentLogs: {
      deployment: r.one.Deployments({
        from: r.DeploymentLogs.deploymentId,
        to: r.Deployments.id,
      }),
    },

    EnvVars: {
      project: r.one.Projects({
        from: r.EnvVars.projectId,
        to: r.Projects.id,
      }),
    },

    FrameworkConfig: {
      app: r.one.Apps({
        from: r.FrameworkConfig.appId,
        to: r.Apps.id,
      }),
    },
  }),
);
