import env from "@/env/vars";
import "dotenv/config";
import { type Config, defineConfig } from "drizzle-kit";

const config: Config & { dbCredentials: { url: string } } = {
  out: "./database/development",
  schema: "./src/database/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.variables.DEV_DATABASE_URL,
  },
};

if (env.variables.DB_ENV === "production") {
  config.out = "./database/production";
  config.dbCredentials.url = env.variables.PROD_DATABASE_URL;
}

console.log("Drizzle Config:");
console.table(config);

export default defineConfig(config);
