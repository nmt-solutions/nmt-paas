import IORedis from "ioredis";
import env from "./env/vars";

export const redis = new IORedis({
  host: env.variables.REDIS_HOST,
  port: env.variables.REDIS_PORT,
  password: env.variables.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
