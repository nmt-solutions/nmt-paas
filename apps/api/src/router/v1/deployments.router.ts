import { Router } from "express";
import queueDeployment, {
  queuePublication,
} from "../../controllers/v1/deployments/queue-deployment.js";

const deploymentsRouter = Router();

deploymentsRouter.post("/queue", queueDeployment);
deploymentsRouter.post("/publication", queuePublication);

export default deploymentsRouter;
