import { useEffect } from "react";
import { api, ApiError } from "./api";

export function useUnreadTitle(
  refresh: number,
  authenticated: boolean,
  title: string,
) {
  useEffect(() => {
    if (!authenticated) {
      document.title = title;
      return;
    }
    let disposed = false;
    let request: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      if (disposed || request) return;
      const controller = new AbortController();
      request = controller;
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const { unread_count: count } = await api<{ unread_count: number }>(
          "/conversations/unread-count",
          { signal: controller.signal },
        );
        if (
          !disposed &&
          !controller.signal.aborted &&
          Number.isSafeInteger(count) &&
          count >= 0
        )
          document.title = count ? `(${count}) - ${title}` : title;
      } catch (error) {
        // A temporary failure keeps the last known count; lost access clears it.
        if (
          !disposed &&
          error instanceof ApiError &&
          [401, 403].includes(error.status)
        )
          document.title = title;
      } finally {
        clearTimeout(timeout);
        request = undefined;
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void update();
    };
    void update();
    // Only this small count request continues when the inbox tab is hidden.
    const timer = setInterval(() => void update(), 30000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    return () => {
      disposed = true;
      request?.abort();
      clearTimeout(timeout);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
    };
  }, [refresh, authenticated, title]);
}
