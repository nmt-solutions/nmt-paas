import { redis } from "@repo/redis";
import "./workers/deployment.worker.js";
import { getDocker } from "./services/docker.js";

const bootstrap = async () => {
  redis
    .ping()
    .then(async (res) => {
      console.log(res);

      const docker = await getDocker();

      const info = await docker.info();

      console.log({
        containers: info.Containers,
        images: info.Images,
        architecture: info.Architecture,
      });

      console.log("Deployment worker started");
    })
    .catch((err) => {
      console.error(err);
    });
};

bootstrap();
