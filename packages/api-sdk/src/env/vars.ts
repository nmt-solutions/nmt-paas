/// <reference types="node" />
import z from "zod";
import "dotenv/config";

const EnvVarsSchema = z.object({
  API_KEY: z
    .string()
    .nonempty({ error: "API_KEY is required." })
    .nonoptional({ error: "API_KEY is required." }),
  API_BASE_URL: z
    .string()
    .nonempty({ error: "API_BASE_URL is required." })
    .nonoptional({ error: "API_BASE_URL is required." }),
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
