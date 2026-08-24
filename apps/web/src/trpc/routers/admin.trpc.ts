import z from "zod";
import cpApiClient from "@/services/cp-api-client";
import { authorizedProdcedure, createTRPCRouter } from "../init";

const resource = z.enum(["containers", "images", "volumes"]);

export const adminRouter = createTRPCRouter({
  host: authorizedProdcedure("admin").query(() => cpApiClient.getAdminHost()),
  resources: authorizedProdcedure("admin")
    .input(z.object({ resource }))
    .query(({ input }) => cpApiClient.getDockerResources(input.resource)),
  deleteResource: authorizedProdcedure("admin")
    .input(z.object({ resource, id: z.string().min(1) }))
    .mutation(({ input }) =>
      cpApiClient.deleteDockerResource(input.resource, input.id),
    ),
});
