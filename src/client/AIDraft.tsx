import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { AIRun, AISource } from "../shared/ai";
import { api, useResource } from "./api";
export function AIDraft({
  conversationId,
  lastInboundId,
  loadedRun,
  onLoad,
  beforeGenerate,
  notify,
}: {
  conversationId: string;
  lastInboundId: string | null;
  loadedRun?: string;
  onLoad: () => Promise<void>;
  beforeGenerate: () => Promise<unknown>;
  notify: (s: string) => void;
}) {
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false);
  const state = useResource<{
    enabled: boolean;
    draft_available: boolean;
    run: AIRun | null;
  }>(
    `/ai/conversations/${conversationId}${loadedRun ? `?run=${encodeURIComponent(loadedRun)}` : ""}`,
    refresh,
  );
  useEffect(() => {
    const t = setInterval(() => setRefresh((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const run = state.data?.run;
  async function generate() {
    setBusy(true);
    try {
      await beforeGenerate();
      await api(`/ai/conversations/${conversationId}/generate`, {
        method: "POST",
      });
      setRefresh((v) => v + 1);
      notify("AI draft requested. Paid-license checks run before generation.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!state.data?.enabled && !run) return null;
  const pending = run && ["queued", "running"].includes(run.state);
  const sources: AISource[] = run ? JSON.parse(run.sources) : [];
  return (
    <div className="ai-draft-panel">
      <div className="ai-actions">
        <span className="ai-label">
          <Sparkles size={15} />
          {pending
            ? "Preparing AI draft…"
            : run?.state === "draft" && state.data?.draft_available
              ? "AI draft · Review before sending"
              : "AI reply"}
        </span>
        <button
          className="button"
          disabled={
            busy ||
            !!pending ||
            !state.data?.enabled ||
            state.data?.draft_available
          }
          onClick={() => void generate()}
        >
          Generate draft
        </button>
        {run?.state === "draft" &&
          state.data?.draft_available &&
          loadedRun !== run.id && (
            <button
              className="button"
              onClick={() => void onLoad().catch((e) => notify(e.message))}
            >
              Load saved draft
            </button>
          )}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {run?.reason && <p>{run.reason}</p>}
      {run?.state === "draft" && run.input_id !== lastInboundId && (
        <p role="alert">
          A newer customer message arrived after this draft. Review it before
          sending.
        </p>
      )}
      {run && (run.notes || sources.length > 0) && (
        <details>
          <summary>References & review notes</summary>
          {run.notes && <p className="ai-review-notes">{run.notes}</p>}
          {sources.map((s) => (
            <details key={s.id} className="ai-source">
              <summary>{s.title}</summary>
              <a href={s.url} target="_blank" rel="noreferrer">
                Open source
              </a>
              <pre>{s.excerpt}</pre>
            </details>
          ))}
        </details>
      )}
    </div>
  );
}
