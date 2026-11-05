import { json, Router } from "express";
import type { ErrorRequestHandler } from "express";
import healthRouter from "./health.router.js";
import { requireApiAuth } from "../../controllers/v1/authentication/auth.js";
import deploymentsRouter from "./deployments.router.js";
import adminRouter from "./admin.router.js";
import logsRouter from "./logs.router.js";

const v1Router = Router();

v1Router.use("/health", healthRouter);
v1Router.use(requireApiAuth);
v1Router.use(json({ strict: false }));

const invalidJSON: ErrorRequestHandler = (error, _req, res, next) => {
  if (
    !(error instanceof SyntaxError) ||
    !("type" in error) ||
    error.type !== "entity.parse.failed"
  ) {
    next(error);
    return;
  }
  res.status(400).json({
    status: "error",
    statusCode: 400,
    message: "Validation Errors",
    data: null,
    errors: {
      formErrors: ["Invalid input: expected object, received invalid"],
      fieldErrors: {},
    },
  });
};
v1Router.use(invalidJSON);
v1Router.use("/deployments", deploymentsRouter);
v1Router.use("/admin", adminRouter);
v1Router.use("/logs", logsRouter);

export default v1Router;
