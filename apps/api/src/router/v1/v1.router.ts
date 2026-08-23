import { Router } from "express";
import healthRouter from "./health.router.js";

const v1Router = Router();

v1Router.use(healthRouter);

export default v1Router;
