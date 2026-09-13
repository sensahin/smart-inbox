export type AppEnv = {
  [K in keyof Env]: Env[K] extends string ? string : Env[K];
} & { ENCRYPTION_KEY?: string; LOCAL_DEV_AUTH?: string };
export type Job =
  | { type: "sync"; mailboxId: string }
  | { type: "send"; outgoingId: string }
  | { type: "ai-draft"; runId: string; conversationId: string }
  | { type: "ai-docs" }
  | { type: "backup" };
export type Bindings = { Bindings: AppEnv; Variables: { owner: string } };
