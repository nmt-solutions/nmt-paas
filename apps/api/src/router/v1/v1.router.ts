import { Router } from "express";
import healthRouter from "./health.router.js";
import { requireApiAuth } from "../../controllers/v1/authentication/auth.js";
import deploymentsRouter from "./deployments.router.js";
import adminRouter from "./admin.router.js";

const v1Router = Router();

v1Router.use("/health", healthRouter);

v1Router.use(requireApiAuth);

v1Router.use("/deployments", deploymentsRouter);
v1Router.use("/admin", adminRouter);

export default v1Router;
