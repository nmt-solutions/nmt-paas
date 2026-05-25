import { redis } from "@repo/redis";
import "./workers/deployment.worker";

redis
  .ping()
  .then((res) => {
    console.log(res);
    console.log("Deployment worker started");
  })
  .catch((err) => {
    console.error(err);
  });
