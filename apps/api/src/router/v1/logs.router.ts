import { Router } from "express";
import { streamRuntimeLogs } from "../../controllers/v1/logs/stream-runtime-logs.js";

const logsRouter = Router();

logsRouter.get("/stream/:deploymentId", streamRuntimeLogs);

export default logsRouter;
