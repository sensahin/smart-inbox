export const AI_MODELS = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash" },
  { id: "@cf/openai/gpt-oss-120b", name: "GPT OSS 120B" },
] as const;
export type AIConfig = {
  enabled: boolean;
  model: string;
  instructions: string;
  daily_limit: number;
  max_steps: number;
  use_history: boolean;
  use_github: boolean;
  documentation_index_url: string;
  eligibility: "paid_freemius" | "all_customers";
  revision: string;
  enabled_at: number;
};
export const DEFAULT_AI: AIConfig = {
  enabled: false,
  model: AI_MODELS[0].id,
  instructions:
    "Write concise, friendly support replies. Use the customer’s language. Give clear steps supported by our documentation. If information is missing, ask a focused question. Do not promise fixes, refunds, or actions that have not happened.",
  daily_limit: 20,
  max_steps: 3,
  use_history: true,
  use_github: false,
  documentation_index_url: "",
  eligibility: "paid_freemius",
  revision: "",
  enabled_at: 0,
};
export type AISource = {
  id: string;
  title: string;
  url: string;
  excerpt: string;
};
export type AIRun = {
  id: string;
  conversation_id: string;
  input_id: string;
  attempt: number;
  state: "queued" | "running" | "draft" | "skipped" | "failed";
  reason: string;
  model: string;
  config_revision: string;
  ticket_status: string;
  result: string | null;
  sources: string;
  notes: string;
  input_tokens: number;
  output_tokens: number;
  started_at: number | null;
  created_at: number;
  updated_at: number;
};
