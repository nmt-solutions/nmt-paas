import { createTRPCRouter } from "../init";
import { frameworkRouter } from "./framework.trpc";
import { githubRouter } from "./github.trpc";

export const appRouter = createTRPCRouter({
  github: githubRouter,
  framework: frameworkRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
