import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";
import { relations } from "./relations";
import env from "./env/vars";

const config: PoolConfig = {
  connectionString: env.variables.DEV_DATABASE_URL,
};

const pool = new Pool(config);

export const database = drizzle({
  client: pool,
  schema,
  relations,
});
