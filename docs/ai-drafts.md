# AI drafts

AI is disabled on new installations. It has no send-email tool and no automatic-send setting. Every generated response is saved as a versioned draft for human review.

## Configuration

1. Choose a supported Workers AI model, instructions, daily attempt limit, research limit, and customer eligibility in Settings → AI. The default eligibility requires an active paid Freemius customer; unconfigured, unavailable, free, trial, expired and unverified results are skipped. Installations without Freemius may explicitly choose All customers. Automated senders, bounces, mailing lists, and connected support addresses are always suppressed.
2. Enter your public documentation `llms.txt` or Markdown index URL. It must link to Markdown pages on the same HTTPS origin. Save settings with AI disabled, refresh documentation, and then enable AI. The importer handles up to 60 pages of at most 700 KB each. It is not a general HTML web crawler. A failed refresh keeps the previous index for that source; changing the source makes the old index ineligible immediately.
3. Optionally configure GitHub under Settings → Connections. Enter `owner/name`; Public is selected by default and needs no token. Selecting Private reveals the fine-grained token field. Restrict that token to this repository with Contents: Read-only and Metadata: Read-only, choose an expiry, and Test repository access. Then enable **Use GitHub as a reference** under AI. Connecting a repository alone does not opt AI in; disconnecting it disables the reference. Tokens remain encrypted and are never sent to the model. Reads are pinned to a default-branch commit. Public mode uses anonymous tree/content reads and ranks candidate file paths; GitHub's authenticated full-code search is used in Private mode. Both paths limit file reads and can encounter GitHub rate limits. Hidden files, symlinks in public tree listings, credentials, vendors, build artifacts and tests are excluded. PHP, JS/TS, JSX/TSX, CSS and Markdown are supported.
4. Optionally enable earlier human replies as references. They can be outdated; the prompt does not treat them as authoritative policy.

Changing AI settings invalidates queued work and prevents results from overwriting drafts generated against older settings. Enabling applies automatically only to subsequently received messages. Existing open tickets have a manual Generate draft action.

## Limits and safety

The AI queue is separate from mail synchronization and outgoing jobs. A per-conversation Agent coordinates generation. D1 stores jobs before enqueueing and guards duplicate delivery, incoming messages during generation, ticket status changes, Trash, owner replies, existing drafts, and disabling AI.

Provider eligibility checks happen before inference. Daily limits count attempts, including failed attempts. Calls use bounded timeouts and no automatic inference retry; interrupted runs need a manual retry. Limits do not guarantee a dollar cap. Model checks use synthetic requests and have a separate daily limit. Local development has no Workers AI binding.

Messages, code, documentation and earlier conversations are untrusted reference data. The agent does not execute code, follow arbitrary customer links, or inspect attachments. Sensitive reference fields are redacted, sources and uncertainty are shown to the reviewer, and customer-facing links are restricted to the documentation origin. Review drafts for incorrect or private details before sending.

A restore pauses both AI and sending. Reconcile Gmail first, then explicitly re-enable processing.
