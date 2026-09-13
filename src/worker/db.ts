import type { AppEnv } from "./env";
export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export async function all<T>(
  db: D1Database,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export async function one<T>(
  db: D1Database,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...args)
    .first<T>();
}
export async function run(db: D1Database, sql: string, ...args: unknown[]) {
  return db
    .prepare(sql)
    .bind(...args)
    .run();
}
export async function setting(env: AppEnv, key: string, fallback = "") {
  return (
    (
      await one<{ value: string }>(
        env.DB,
        "SELECT value FROM settings WHERE key=?",
        key,
      )
    )?.value ?? fallback
  );
}
export async function setSetting(env: AppEnv, key: string, value: string) {
  await run(
    env.DB,
    "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    value,
  );
}
export async function recordEvent(
  env: AppEnv,
  kind: string,
  entity: string | null,
  detail: string,
) {
  await run(
    env.DB,
    "INSERT INTO events VALUES (?,?,?,?,?)",
    uid(),
    kind,
    entity,
    detail,
    now(),
  );
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};
