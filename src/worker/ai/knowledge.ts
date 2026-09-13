import type { AppEnv } from "../env";
import type { AISource } from "../../shared/ai";
import { all, AppError, now, run, setting, setSetting, uid } from "../db";
import { secret } from "../secrets";
import { redactReference } from "./eligibility";
import { readJson } from "../google";
import { publicHttpsUrl, documentationLink } from "../../shared/workspace";
import { aiConfig } from "./config";
export function terms(query: string) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,40}/g) || [])]
    .filter(
      (v) =>
        ![
          "this",
          "that",
          "with",
          "from",
          "have",
          "what",
          "when",
          "your",
          "please",
          "support",
          "hello",
          "would",
          "could",
        ].includes(v),
    )
    .slice(0, 8);
}
async function docText(url: string, indexUrl: string) {
  const u = new URL(url);
  if (
    !publicHttpsUrl(url) ||
    u.origin !== new URL(indexUrl).origin ||
    !/^\/[a-zA-Z0-9_./-]+\.(md|txt)$/.test(u.pathname) ||
    u.search
  )
    throw new AppError(400, "Invalid documentation URL.");
  const r = await fetch(u, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw new AppError(502, `Documentation returned HTTP ${r.status}.`);
  const reader = r.body!.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 700000) {
      await reader.cancel();
      throw new AppError(502, "Documentation page is too large.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export async function syncDocumentation(env: AppEnv) {
  const lease = String(now() + 600000);
  const claimed = await run(
    env.DB,
    "INSERT INTO settings(key,value) VALUES ('ai_docs_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?",
    lease,
    now(),
  );
  if (!claimed.meta.changes) return;
  const generation = uid();
  await setSetting(env, "ai_docs_error", "");
  try {
    const indexUrl = (await aiConfig(env)).documentation_index_url;
    if (!indexUrl)
      throw new AppError(
        409,
        "Configure a documentation index in AI settings first.",
      );
    const index = await docText(indexUrl, indexUrl);
    const candidates = [...index.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(
      (m) => m[1],
    );
    candidates.push(...(index.match(/https:\/\/[^\s<>)]*\.md/g) || []));
    const urls = [
      ...new Set(
        candidates.flatMap((raw) => {
          try {
            const url = new URL(raw, indexUrl);
            return documentationLink(url.href, indexUrl) &&
              /\.md$/.test(url.pathname) &&
              !url.search
              ? [url.href]
              : [];
          } catch {
            return [];
          }
        }),
      ),
    ].slice(0, 60);
    if (!urls.length)
      throw new AppError(502, "Documentation index has no pages.");
    for (const url of urls) {
      if ((await aiConfig(env)).documentation_index_url !== indexUrl)
        throw new AppError(
          409,
          "Documentation source changed during indexing. Refresh the new source.",
        );
      const content = await docText(url, indexUrl);
      const title = content.match(/^# (.+)$/m)?.[1] || new URL(url).pathname;
      // Overlapping bounded passages preserve local context without loading a whole manual.
      for (let start = 0; start < content.length; start += 4500) {
        await run(
          env.DB,
          "INSERT INTO ai_documents VALUES (?,?,?,?,?,?)",
          uid(),
          title,
          url.replace(/\/index\.md$/, "/").replace(/\.md$/, ""),
          redactReference(content.slice(start, start + 5000)),
          generation,
          now(),
        );
      }
    }
    const values = [
      ["ai_docs_generation", generation],
      ["ai_docs_index_url", indexUrl],
      ["ai_docs_updated", String(now())],
      ["ai_docs_error", ""],
    ];
    await env.DB.batch([
      ...values.map(([key, value]) =>
        env.DB.prepare(
          "INSERT INTO settings(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key='ai_config' AND json_extract(value,'$.documentation_index_url')=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(key, value, indexUrl),
      ),
      env.DB.prepare(
        "DELETE FROM ai_documents WHERE generation<>COALESCE((SELECT value FROM settings WHERE key='ai_docs_generation'),'')",
      ),
    ]);
  } catch (e) {
    await run(
      env.DB,
      "DELETE FROM ai_documents WHERE generation=?",
      generation,
    );
    await setSetting(
      env,
      "ai_docs_error",
      e instanceof AppError
        ? e.message
        : "Documentation refresh failed; the previous index is retained.",
    );
  } finally {
    await run(
      env.DB,
      "UPDATE settings SET value='0' WHERE key='ai_docs_lease' AND value=?",
      lease,
    );
  }
}
export async function searchDocs(
  env: AppEnv,
  query: string,
): Promise<AISource[]> {
  const config = await aiConfig(env);
  if (
    !config.documentation_index_url ||
    (await setting(env, "ai_docs_index_url")) !== config.documentation_index_url
  )
    return [];
  const words = terms(query);
  if (!words.length) return [];
  const docs = await all<{
    id: string;
    title: string;
    url: string;
    content: string;
  }>(
    env.DB,
    `SELECT d.* FROM ai_documents_fts f JOIN ai_documents d ON d.rowid=f.rowid WHERE ai_documents_fts MATCH ? AND generation=? ORDER BY rank LIMIT 3`,
    words.map((t) => '"' + t + '"').join(" OR "),
    await setting(env, "ai_docs_generation"),
  );
  return docs.map((d) => ({
    id: "doc:" + d.id,
    title: d.title,
    url: d.url,
    excerpt: d.content.slice(0, 5000),
  }));
}
export async function searchHistory(
  env: AppEnv,
  query: string,
  conversationId: string,
): Promise<AISource[]> {
  const indexUrl = (await aiConfig(env)).documentation_index_url;
  const words = terms(query).slice(0, 4);
  if (!words.length) return [];
  const matches = await all<{
    id: string;
    number: number;
    subject: string;
    search_text: string;
    customer_name: string;
  }>(
    env.DB,
    `SELECT m.id,c.number,c.subject,m.search_text,p.name customer_name FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts p ON p.id=c.contact_id WHERE c.id<>? AND c.deleted_at IS NULL AND c.status='closed' AND m.direction='outbound' AND (${words.map(() => "m.search_text LIKE ?").join(" OR ")}) ORDER BY m.sent_at DESC LIMIT 3`,
    conversationId,
    ...words.map((v) => "%" + v + "%"),
  );
  return matches.map((m) => ({
    id: "history:" + m.id,
    title: `Previous reply #${m.number}`,
    url: `/api/ai/sources/history/${m.id}`,
    excerpt: redactReference(
      m.customer_name
        ? m.search_text.split(m.customer_name).join("[customer]")
        : m.search_text,
    )
      .replace(/https?:\/\/[^\s<>]+/g, (url) =>
        documentationLink(url, indexUrl) ? url : "[private link]",
      )
      .slice(0, 3500),
  }));
}
export async function githubJson<T>(
  env: AppEnv,
  path: string,
  access: "public" | "private",
): Promise<T> {
  const token = access === "private" ? await secret(env, "github_token") : null;
  if (access === "private" && !token)
    throw new AppError(
      409,
      "Add a read-only token under Connections → GitHub.",
    );
  const r = await fetch("https://api.github.com" + path, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Smart-Inbox",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new AppError(
      502,
      `GitHub returned HTTP ${r.status}. Check repository access and rate limits.`,
    );
  }
  return readJson<T>(r, 3 * 1024 * 1024);
}
export function allowedCodePath(path: string) {
  return (
    !/(^|\/)(\.|vendor\/|node_modules\/|tests?\/|dist\/|build\/|logs?\/|backups?\/)/i.test(
      path,
    ) &&
    !/(secret|credential|\.min\.|lock\b)/i.test(path) &&
    /^[a-zA-Z0-9_./-]+\.(php|js|ts|tsx|jsx|css|md)$/.test(path) &&
    !path.includes("..")
  );
}
export async function githubHead(
  env: AppEnv,
  repo: string,
  access: "public" | "private",
) {
  if (!repo)
    throw new AppError(
      409,
      "Configure a repository under Connections → GitHub first.",
    );
  const info = await githubJson<{ default_branch: string }>(
    env,
    `/repos/${repo}`,
    access,
  );
  const head = await githubJson<{ sha: string }>(
    env,
    `/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`,
    access,
  );
  if (!/^[0-9a-f]{40}$/.test(head.sha))
    throw new AppError(502, "Invalid GitHub revision.");
  return head.sha;
}
export async function searchCode(
  env: AppEnv,
  repo: string,
  sha: string,
  query: string,
  access: "public" | "private",
): Promise<AISource[]> {
  const words = terms(query).slice(0, 4);
  if (!words.length) return [];
  // Search is restricted to the configured repository; file reads use this run's commit.
  let matches: { path: string }[];
  if (access === "private") {
    const response = await githubJson<{ items: { path: string }[] }>(
      env,
      "/search/code?q=" +
        encodeURIComponent(words.join(" ") + ` repo:${repo}`) +
        "&per_page=5",
      access,
    );
    matches = response.items || [];
  } else {
    // GitHub code search requires authentication. Public mode ranks the bounded tree
    // by path, then reads only candidate files at the pinned commit without a token.
    const files = await githubFiles(env, repo, sha, access);
    const score = (path: string) =>
      words.reduce(
        (n, word) => n + (path.toLowerCase().includes(word) ? 1 : 0),
        0,
      );
    matches = files
      .filter((file) => score(file.path) > 0)
      .sort((a, b) => score(b.path) - score(a.path));
    if (!matches.length)
      matches = files.filter((file) => /(?:^|\/)readme\.md$/i.test(file.path));
  }
  const results: AISource[] = [];
  for (const match of matches
    .filter((m) => allowedCodePath(m.path))
    .slice(0, 2)) {
    const file = await githubJson<{
      encoding: string;
      content: string;
      size: number;
    }>(
      env,
      `/repos/${repo}/contents/${match.path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
      access,
    );
    if (file.encoding !== "base64" || file.size > 300000) continue;
    const content = redactReference(
      Buffer.from(file.content, "base64").toString("utf8"),
    );
    const position = Math.max(0, content.toLowerCase().indexOf(words[0]) - 700);
    results.push({
      id: `code:${sha}:${match.path}`,
      title: match.path,
      url: `https://github.com/${repo}/blob/${sha}/${match.path}`,
      excerpt: content.slice(position, position + 5000),
    });
  }
  return results;
}

export async function githubFiles(
  env: AppEnv,
  repo: string,
  sha: string,
  access: "public" | "private",
) {
  const result = await githubJson<{
    tree: { path: string; type: string; mode: string; size?: number }[];
    truncated?: boolean;
  }>(env, `/repos/${repo}/git/trees/${sha}?recursive=1`, access);
  if (!Array.isArray(result.tree) || result.truncated)
    throw new AppError(
      502,
      "Repository file listing is incomplete or too large. Use a smaller reference repository.",
    );
  return result.tree.filter(
    (file) =>
      file.type === "blob" &&
      file.mode !== "120000" &&
      (file.size ?? 0) <= 300000 &&
      allowedCodePath(file.path),
  );
}
