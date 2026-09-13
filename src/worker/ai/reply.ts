import { z } from "zod";
import { escapeHtml } from "../mail";

export const replySchema = z.object({
  reply_paragraphs: z
    .array(z.string().trim().min(1).max(2000))
    .min(2)
    .max(16)
    .describe(
      "Customer-facing email paragraphs in reading order. Put the greeting in its own paragraph, then use short paragraphs of one to three sentences, one topic per paragraph. Keep individual instructions or steps separate. Plain text only; no HTML, Markdown, subject, signature, or reviewer notes.",
    ),
  reviewer_notes: z.string().max(4000),
  source_ids: z.array(z.string()).max(12),
});

export const replyToHtml = (reply: string) =>
  reply
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[\t ]*\n+/)
    .filter((paragraph) => paragraph.trim())
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
