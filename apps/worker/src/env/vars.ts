/// <reference types="node" />
import z from "zod";
import "dotenv/config";

const EnvVarsSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  BASE_DOMAIN: z
    .string()
    .nonempty({ error: "BASE_DOMAIN is required." })
    .nonoptional({ error: "BASE_DOMAIN is required." }),
  DB_ENV: z.enum(["development", "production"]).default("development"),
  DEV_DATABASE_URL: z
    .string()
    .nonempty({ error: "DEV_DATABASE_URL is required." })
    .nonoptional({ error: "DEV_DATABASE_URL is required." }),
  PROD_DATABASE_URL: z
    .string()
    .nonempty({ error: "PROD_DATABASE_URL is required." })
    .nonoptional({ error: "PROD_DATABASE_URL is required." }),
  GITHUB_APP_ID: z
    .string()
    .nonempty({ error: "GITHUB_APP_ID is required." })
    .nonoptional({ error: "GITHUB_APP_ID is required." })
    .transform((val) => Number.parseInt(val, 10)),
  GITHUB_APP_SLUG: z
    .string()
    .nonempty({ error: "GITHUB_APP_SLUG is required." })
    .nonoptional({ error: "GITHUB_APP_SLUG is required." }),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .nonempty({ error: "GITHUB_APP_PRIVATE_KEY is required." })
    .nonoptional({ error: "GITHUB_APP_PRIVATE_KEY is required." })
    .transform((val) => val.replace(/\\n/g, "\n")),
  GITHUB_PAT: z
    .string()
    .nonempty({ error: "GITHUB_PAT is required." })
    .nonoptional({
      error: "GITHUB_PAT is required.",
    }),
  GITHUB_USER_NAME: z
    .string()
    .nonempty({ error: "GITHUB_USER_NAME is required." })
    .nonoptional({
      error: "GITHUB_USER_NAME is required.",
    }),
  ENV_ENCRYPTION_KEY: z
    .string()
    .nonempty({ error: "ENV_ENCRYPTION_KEY is required." })
    .nonoptional({
      error: "ENV_ENCRYPTION_KEY is required.",
    }),
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
