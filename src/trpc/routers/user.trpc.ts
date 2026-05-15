import { getWorkOS } from "@workos-inc/authkit-nextjs";
import z from "zod";
import { authorizedProdcedure, createTRPCRouter } from "../init";

export const userRouter = createTRPCRouter({
  getUsers: authorizedProdcedure("permission")
    .input(
      z.object({
        after: z.string(),
        before: z.string(),
        limit: z.number(),
        email: z.string(),
      }),
    )
    .query((opts) => {
      const {
        input: { limit, email, before, after },
      } = opts;

      const workos = getWorkOS();

      return workos.userManagement.listUsers({
        before,
        after,
        limit,
        order: "asc",
        email,
      });
    }),
});
