import z from "zod";
import "dotenv/config";

const EnvVarsSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  DB_ENV: z.enum(["development", "production"]).default("development"),
  WORKOS_CLIENT_ID: z
    .string()
    .nonempty({ error: "WORKOS_CLIENT_ID is required." })
    .nonoptional({ error: "WORKOS_CLIENT_ID is required." }),
  WORKOS_API_KEY: z
    .string()
    .nonempty({ error: "WORKOS_API_KEY is required." })
    .nonoptional({ error: "WORKOS_API_KEY is required." }),
  WORKOS_COOKIE_PASSWORD: z
    .string()
    .nonempty({ error: "WORKOS_COOKIE_PASSWORD is required." })
    .nonoptional({ error: "WORKOS_COOKIE_PASSWORD is required." }),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: z
    .string()
    .nonempty({ error: "NEXT_PUBLIC_WORKOS_REDIRECT_URI is required." })
    .nonoptional({ error: "NEXT_PUBLIC_WORKOS_REDIRECT_URI is required." }),
  GITHUB_APP_ID: z
    .string()
    .nonempty({})
    .nonoptional({})
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
