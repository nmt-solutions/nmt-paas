import z from "zod";

export const QueueDeploymentSchema = z.object({
  userId: z
    .string()
    .nonempty({ error: "User id is required." })
    .nonoptional({ error: "User id is required." }),
  deploymentId: z
    .number({ error: "Deployment id must be a number." })
    .nonnegative({ error: "Deployment id must be a +ve int." })
    .nonoptional({ error: "Deployment id is required." }),
});

export type QueueDeploymentReqBody = z.infer<typeof QueueDeploymentSchema>;

export type ValidationErrors = ReturnType<
  typeof z.flattenError<QueueDeploymentReqBody>
>;
