import { getUserProjects } from "@repo/database/access-layer/project.dal";
import { authenticatedProcedure, createTRPCRouter } from "../init";

export const projectRouter = createTRPCRouter({
  list: authenticatedProcedure.query(({ ctx }) =>
    getUserProjects(ctx.userInfo.user.id),
  ),
});
