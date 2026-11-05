import "dotenv/config";
import { type Config, defineConfig } from "drizzle-kit";
import env from "./src/env/vars";

const config: Config & { dbCredentials: { url: string } } = {
  out: `./database/${env.variables.DB_ENV}`,
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.databaseUrl,
  },
};

export default defineConfig(config);
