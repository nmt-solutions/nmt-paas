import { getEnvVars } from "@repo/database/access-layer/env-vars.dal";
import env from "../env/vars.js";
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Recommended for GCM

function getKey(): Buffer {
  const key = env.variables.ENV_ENCRYPTION_KEY;

  const buffer = Buffer.from(key, "hex");

  if (buffer.length !== 32) {
    throw new Error(
      "ENV_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars)",
    );
  }

  return buffer;
}

export function decrypt(payload: string): string {
  const key = getKey();

  const [ivB64, authTagB64, encryptedB64] = payload.split(":");

  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted payload");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export const fetchEnvVars = async (
  projectId: number,
  env: "production" | "preview",
): Promise<string> => {
  const envVars = await getEnvVars(projectId, env);

  return envVars
    .map((envVar) => `${envVar.key}=${decrypt(envVar.encryptedValue)}`)
    .join("\n");
};
