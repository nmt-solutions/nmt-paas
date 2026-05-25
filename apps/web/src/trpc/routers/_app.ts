import { createTRPCRouter } from "../init";
import { deploymentRouter } from "./deployment.trpcs";
import { frameworkRouter } from "./framework.trpc";
import { gitRouter } from "./git.trpc";
import { githubRouter } from "./github.trpc";

export const appRouter = createTRPCRouter({
  github: githubRouter,
  framework: frameworkRouter,
  deployment: deploymentRouter,
  git: gitRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
