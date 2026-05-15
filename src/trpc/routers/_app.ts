import { createTRPCRouter } from "../init";
import { githubRouter } from "./github.trpc";

export const appRouter = createTRPCRouter({
  github: githubRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
