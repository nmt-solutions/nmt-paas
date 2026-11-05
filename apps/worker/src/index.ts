import { redis } from "@repo/redis";
import "./workers/deployment.worker.js";
import { safeDiagnosticError } from "./services/diagnostics.js";

const bootstrap = async () => {
  redis
    .ping()
    .then(async (res) => {
      console.log(res);

      console.log("Deployment worker started");
    })
    .catch((err) => {
      console.error(safeDiagnosticError(err));
    });
};

bootstrap();
