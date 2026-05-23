import IORedis from "ioredis";
import env from "./env/vars";

export const redis = new IORedis({
  host: env.variables.REDIS_HOST,
  port: env.variables.REDIS_PORT,

  maxRetriesPerRequest: null,

  enableReadyCheck: false,
});
