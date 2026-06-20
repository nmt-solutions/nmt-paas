import env from "@/env/vars";
import crypto from "crypto";

import {
  createEnvVars,
  getEnvVars,
} from "@repo/database/access-layer/env-vars.dal";

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

export function encrypt(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  /**
   * Format:
   * iv:authTag:ciphertext
   */
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
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

export const saveEnvVars = async (
  envVars: { key: string; value: string }[],
  projectId: number,
  env: "production" | "preview",
  userId: string,
) => {
  const envVarsArray = envVars.map(({ key, value }) => ({
    key,
    projectId,
    encryptedValue: encrypt(value),
    env,
    createdBy: userId,
  }));

  const savedEnvVars = await createEnvVars(envVarsArray);

  return savedEnvVars;
};

export const fetchEnvVars = async (
  projectId: number,
  env: "production" | "preview",
): Promise<{ key: string; value: string }[]> => {
  const envVars = await getEnvVars(projectId, env);

  return envVars.map((envVar) => ({
    key: envVar.key,
    value: decrypt(envVar.encryptedValue),
  }));
};
