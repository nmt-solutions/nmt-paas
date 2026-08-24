import { Router } from "express";
import getHealth from "../../controllers/v1/health/get-health.js";

const healthRouter = Router();

healthRouter.get("/", getHealth);

export default healthRouter;
