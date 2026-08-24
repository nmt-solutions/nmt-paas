import { createTRPCRouter } from "../init";
import { deploymentRouter } from "./deployment.trpcs";
import { frameworkRouter } from "./framework.trpc";
import { gitRouter } from "./git.trpc";
import { githubRouter } from "./github.trpc";
import { appRouter as applicationsRouter } from "./app.trpc";
import { projectRouter } from "./project.trpc";
import { adminRouter } from "./admin.trpc";

export const appRouter = createTRPCRouter({
  github: githubRouter,
  framework: frameworkRouter,
  deployment: deploymentRouter,
  git: gitRouter,
  app: applicationsRouter,
  project: projectRouter,
  admin: adminRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
