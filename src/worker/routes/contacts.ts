import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import type { ContactSummary, Conversation } from "../../shared/types";
import { all, AppError, one } from "../db";

export const contactRoutes = new Hono<Bindings>();
const pageSize = 50;
const pageQuery = z.object({
  inbox: z.string().max(160).default(""),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const listQuery = pageQuery.extend({
  q: z.string().trim().max(150).default(""),
  sort: z
    .enum(["name", "email", "conversation_count", "last_activity_at"])
    .default("last_activity_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
// Keep contacts and their recorded history when conversations move to Trash.
// The same inbox scope applies to membership, counts, activity, and history.
const contactStats = (inbox: string) => `WITH activity AS (
  SELECT contact_id, COUNT(*) conversation_count, MAX(updated_at) last_activity_at
  FROM conversations ${inbox ? "WHERE inbox_id=?" : ""} GROUP BY contact_id
)`;
const contactSelect = `SELECT p.id,p.name,p.email,p.created_at,
  COALESCE(a.conversation_count,0) conversation_count,a.last_activity_at
  FROM contacts p LEFT JOIN activity a ON a.contact_id=p.id`;

contactRoutes.get("/contacts", async (c) => {
  const { inbox, q, offset, sort, direction } = listQuery.parse(c.req.query());
  const where = [inbox ? "a.contact_id IS NOT NULL" : "1=1"];
  const params: string[] = inbox ? [inbox] : [];
  if (q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')");
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(pattern, pattern);
  }
  const filter = ` WHERE ${where.join(" AND ")}`;
  // Only validated enum values enter ORDER BY; all user values are bound.
  const column =
    sort === "name" || sort === "email" ? `p.${sort} COLLATE NOCASE` : sort;
  const [count, page] = await c.env.DB.batch<Record<string, unknown>>(
    [
      `${contactStats(inbox)} SELECT COUNT(*) total FROM contacts p LEFT JOIN activity a ON a.contact_id=p.id${filter}`,
      `${contactStats(inbox)} ${contactSelect}${filter} ORDER BY ${column} ${direction},p.id ASC LIMIT ${pageSize + 1} OFFSET ?`,
    ].map((sql, index) =>
      c.env.DB.prepare(sql).bind(...params, ...(index ? [offset] : [])),
    ),
  );
  return c.json({
    items: page.results.slice(0, pageSize),
    total: Number(count.results[0].total),
    has_more: page.results.length > pageSize,
  });
});

contactRoutes.get("/contacts/:id", async (c) => {
  const { inbox, offset } = pageQuery.parse(c.req.query());
  const id = c.req.param("id");
  const contact = await one<ContactSummary>(
    c.env.DB,
    `${contactStats(inbox)} ${contactSelect} WHERE p.id=?`,
    ...(inbox ? [inbox] : []),
    id,
  );
  if (!contact) throw new AppError(404, "Contact not found.");
  const items = await all<Conversation>(
    c.env.DB,
    `SELECT c.*,p.name contact_name,p.email contact_email,i.name inbox_name
     FROM conversations c JOIN contacts p ON p.id=c.contact_id JOIN inboxes i ON i.id=c.inbox_id
     WHERE c.contact_id=?${inbox ? " AND c.inbox_id=?" : ""}
     ORDER BY c.updated_at DESC,c.id ASC LIMIT ${pageSize + 1} OFFSET ?`,
    id,
    ...(inbox ? [inbox] : []),
    offset,
  );
  return c.json({
    contact,
    items: items.slice(0, pageSize),
    has_more: items.length > pageSize,
  });
});
