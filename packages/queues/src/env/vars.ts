/// <reference types="node" />
import z from "zod";
import "dotenv/config";

const EnvVarsSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  REDIS_HOST: z.string().nonempty(),
  REDIS_PORT: z
    .string()
    .nonempty()
    .transform((value) => Number.parseInt(value, 10)),
  REDIS_PASSWORD: z.string().nonempty(),
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
