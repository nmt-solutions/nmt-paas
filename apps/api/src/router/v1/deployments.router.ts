import { Router } from "express";
import queueDeployment from "../../controllers/v1/deployments/queueDeployment.js";

const deploymentsRouter = Router();

deploymentsRouter.post("/queue", queueDeployment);

export default deploymentsRouter;
