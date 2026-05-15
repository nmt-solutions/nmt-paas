import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import env from "@/env/vars";
import * as schema from "./schema";

const config: PoolConfig = {
  connectionString: env.variables.DEV_DATABASE_URL,
};

const pool = new Pool(config);

export const database = drizzle({ client: pool, schema });
