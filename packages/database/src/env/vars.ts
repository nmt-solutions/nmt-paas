/// <reference types="node" />
import z from "zod";
import "dotenv/config";

const databaseUrl = (name: string) =>
  z
    .string({ error: `${name} is required.` })
    .nonempty({ error: `${name} is required.` })
    .nonoptional({ error: `${name} is required.` })
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return (
            ["postgres:", "postgresql:"].includes(url.protocol) &&
            url.hostname.length > 0
          );
        } catch {
          return false;
        }
      },
      {
        error: `${name} must be a PostgreSQL connection URL with a host.`,
      },
    );

const EnvVarsSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  DB_ENV: z.enum(["development", "production"]).default("development"),
  DEV_DATABASE_URL: databaseUrl("DEV_DATABASE_URL"),
  PROD_DATABASE_URL: databaseUrl("PROD_DATABASE_URL"),
  BASE_DOMAIN: z
    .string({ error: "BASE_DOMAIN is required." })
    .nonempty({ error: "BASE_DOMAIN is required." })
    .nonoptional({ error: "BASE_DOMAIN is required." }),
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

const env = {
  variables,
  databaseUrl:
    variables.DB_ENV === "production"
      ? variables.PROD_DATABASE_URL
      : variables.DEV_DATABASE_URL,
};

export default env;

export type EnvVars = z.infer<typeof EnvVarsSchema>;
