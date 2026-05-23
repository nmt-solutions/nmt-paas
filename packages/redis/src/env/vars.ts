/// <reference types="node" />
import z from "zod";
import "dotenv/config";

const EnvVarsSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  DB_ENV: z.enum(["development", "production"]).default("development"),
  DEV_DATABASE_URL: z
    .string()
    .nonempty({ error: "DEV_DATABASE_URL is required." })
    .nonoptional({ error: "DEV_DATABASE_URL is required." }),
  PROD_DATABASE_URL: z
    .string()
    .nonempty({ error: "PROD_DATABASE_URL is required." })
    .nonoptional({ error: "PROD_DATABASE_URL is required." }),
  REDIS_HOST: z
    .string()
    .nonempty({ error: "REDIS_HOST is required." })
    .nonoptional({ error: "REDIS_HOST is required." }),
  REDIS_PORT: z
    .string()
    .nonempty({ error: "REDIS_PORT is required." })
    .nonoptional({ error: "REDIS_PORT is required." })
    .transform((val) => Number.parseInt(val, 10)),
  REDIS_PASSWORD: z
    .string()
    .nonempty({ error: "REDIS_PASSWORD is required." })
    .nonoptional({ error: "REDIS_PASSWORD is required." }),
});

const {
  success,
  data: variables,
  error,
} = EnvVarsSchema.safeParse(process.env);

if (!success) {
  const errorTree = z.treeifyError(error);

  const errorMessages = Object.entries(errorTree.properties ?? {}).map(
    ([key, value]) => {
      const messages = value.errors.map((err) => `${key}: ${err}`);
      return messages.join(", ");
    },
  );

  throw new Error(
    `Invalid environment variables:\n${errorMessages.join("\n")}`,
  );
}

const env = { variables };

export default env;

export type EnvVars = z.infer<typeof EnvVarsSchema>;
