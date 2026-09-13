import type { AppEnv } from "./env";
import { AppError, setting, setSetting } from "./db";
export const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
export async function sha256(value: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
async function encryptionKey(env: AppEnv) {
  if (!env.ENCRYPTION_KEY)
    throw new AppError(503, "Encryption key is not configured.");
  const raw = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (raw.length !== 32)
    throw new AppError(503, "Encryption key must contain 32 bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(env: AppEnv, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(value),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}
export async function decrypt(env: AppEnv, value: string) {
  const [v, iv, data] = value.split(".");
  if (v !== "v1" || !iv || !data)
    throw new AppError(503, "Stored credential is invalid.");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
      await encryptionKey(env),
      Buffer.from(data, "base64url"),
    ),
  );
}
export async function secret(env: AppEnv, name: string) {
  const value = await setting(env, `secret:${name}`);
  return value ? decrypt(env, value) : "";
}
export async function saveSecret(env: AppEnv, name: string, value: string) {
  if (value) await setSetting(env, `secret:${name}`, await encrypt(env, value));
}
