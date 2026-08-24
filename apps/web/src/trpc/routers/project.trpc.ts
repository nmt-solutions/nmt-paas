import {
  deleteProject,
  getUserProjects,
} from "@repo/database/access-layer/project.dal";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import z from "zod";

export const projectRouter = createTRPCRouter({
  list: authenticatedProcedure.query(({ ctx }) =>
    getUserProjects(ctx.userInfo.user.id),
  ),

  deleteProject: authenticatedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      return deleteProject(input.projectId, ctx.userInfo.user.id);
    }),
});
