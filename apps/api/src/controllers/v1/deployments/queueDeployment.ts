import z from "zod";
import { APIHandler } from "../../../models/api-handler.model.js";
import { deploymentQueue } from "@repo/queues";
import {
  QueueDeploymentSchema,
  QueueDeploymentReqBody,
  ValidationErrors,
} from "@repo/api-sdk/models/deployment-queue";

const queueDeployment: APIHandler<
  true,
  ValidationErrors,
  QueueDeploymentReqBody
> = async (req, res) => {
  const { success, error, data } = QueueDeploymentSchema.safeParse(req.body);

  if (!success) {
    res.status(400).send({
      status: "error",
      statusCode: 400,
      message: "Validation Errors",
      data: null,
      errors: z.flattenError(error),
    });

    return;
  }

  await deploymentQueue.add("deployment-queue", data);

  res.status(201).send({
    status: "success",
    statusCode: 201,
    message: "Deployment Queued",
    data: true,
    errors: null,
  });
};

export default queueDeployment;
