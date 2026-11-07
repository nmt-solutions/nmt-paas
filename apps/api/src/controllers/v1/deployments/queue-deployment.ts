import z from "zod";
import { APIHandler } from "../../../models/api-handler.model.js";
import {
  DeploymentEnqueueConflict,
  enqueueDeployment,
  enqueuePublication,
} from "@repo/queues";
import {
  QueueDeploymentSchema,
  QueueDeploymentReqBody,
  ValidationErrors,
} from "@repo/api-sdk/models/deployment-queue";

const queueHandler =
  (
    publication: boolean,
  ): APIHandler<true, ValidationErrors | null, QueueDeploymentReqBody> =>
  async (req, res) => {
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

    console.log("Incoming:", data);

    let job;
    try {
      job = await (publication
        ? enqueuePublication(data)
        : enqueueDeployment(data));
    } catch (error) {
      if (error instanceof DeploymentEnqueueConflict) {
        res.status(409).send({
          status: "error",
          statusCode: 409,
          message: error.message,
          data: null,
          errors: null,
        });
        return;
      }
      res.status(503).send({
        status: "error",
        statusCode: 503,
        message: "Deployment queue is unavailable.",
        data: null,
        errors: null,
      });
      return;
    }

    console.log("Queued:", JSON.stringify(job.data));

    res.status(201).send({
      status: "success",
      statusCode: 201,
      message: publication ? "Publication Queued" : "Deployment Queued",
      data: true,
      errors: null,
    });
  };

export const queuePublication = queueHandler(true);
export default queueHandler(false);
