import { getUserProjects } from "@repo/database/access-layer/project.dal";
import {
  retireProject,
  projectRetirementStatus,
  retiredProjects,
} from "../../services/project-retirement";
import { authenticatedProcedure, createTRPCRouter } from "../init";
import z from "zod";

export const projectRouter = createTRPCRouter({
  list: authenticatedProcedure.query(({ ctx }) =>
    getUserProjects(ctx.userInfo.user.id),
  ),

  retired: authenticatedProcedure.query(({ ctx }) =>
    retiredProjects(ctx.userInfo.user.id),
  ),

  retirementStatus: authenticatedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(({ ctx, input }) =>
      projectRetirementStatus(input.projectId, ctx.userInfo.user.id),
    ),

  deleteProject: authenticatedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      return retireProject(input.projectId, ctx.userInfo.user.id);
    }),
});
