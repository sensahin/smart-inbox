# Backup and recovery

## Normal operation

The 01:00 UTC Cron exports a consistent D1 snapshot as JSON tables to private R2 bucket `smart-inbox-backups`, under `daily/YYYY-MM-DD/<export-id>/`. Each export uses a unique prefix, so an interrupted replacement cannot corrupt the previous export. The manifest is written last and lists row counts and table files. `messages.json`, `attachments.json`, and `message_attachments.json` are the body/attachment manifests; the immutable objects remain in the private `smart-inbox-files` bucket. This database export does not duplicate every attachment binary into a second bucket. Protect the files bucket from deletion; a database restore cannot recover a deleted original object.

Keep the `ENCRYPTION_KEY` in an independent password manager or secure offline backup. Encrypted Google/provider credentials cannot be recovered without the original key. The deployment helper keeps a mode-600 copy beside the external deployment credentials.

Settings → Activity & sending displays the most recent successful backup and queues an immediate backup. Older daily export prefixes are removed after 30 days. Cloudflare D1 Time Travel provides a separate short-term database recovery mechanism; confirm the retention available to the account before relying on it.

## Recover a failed or uncertain send

1. Open the ticket from Activity & sending.
2. Use Check Gmail Sent. The lookup uses the stable MIME Message-ID and never sends another email.
3. If found, the application records Gmail acceptance. A later inbound reply remains open.
4. If an uncertain send is not found, check the actual Gmail Sent folder and allow for indexing delay. Retry only after verifying the message was not sent. The stable ID is preserved across retry, but Gmail itself does not guarantee deduplication.
5. A bounce reopens the ticket and displays a delivery failure notice. Correct the address or issue before sending again.

## Recover a deleted conversation

Open Trash in the sidebar, select conversations, and choose Restore. Deletion affects this dashboard only and preserves the Gmail copies, message bodies, attachments, and drafts. No automatic purge runs. An incoming customer reply received after deletion restores the ticket as Open; duplicate synchronization and older recovered messages do not restore it. Tickets with pending, sending, or uncertain jobs must finish or reconcile before moving to Trash. Restore a trashed ticket before retrying a failed send.

Backups include Trash membership, ticket revisions, the status transition ledger used by Reports, and each message's Gmail thread ID. Older exports use the new columns' defaults when restored into the current schema.

## Restore a daily export into a new database

Use a new D1 database so the running application cannot write into a partially restored snapshot.

1. Turn off sending and acknowledgements in Activity & sending. Wait for active send requests to finish (at least two minutes), then stop editing tickets during the final switch.
2. Download one complete daily export prefix, including `manifest.json` and every listed JSON table, to a private local directory. Files contain support data and encrypted credentials. R2 objects are private; use Cloudflare's dashboard or authenticated Wrangler downloads.
3. Run:

   ```sh
   node scripts/prepare-restore.mjs /private/export/manifest.json /private/export/restore.sql
   node scripts/cloudflare.mjs wrangler d1 create smart-inbox-recovery
   ```

4. Create a temporary Wrangler config pointing its `DB` binding to the **new** database ID. Apply all migrations in `migrations/` to that target, then import `restore.sql` using `wrangler d1 execute DB --remote --config <temporary-config> --file /private/export/restore.sql`. Never run restore SQL against the active database.
5. Check table counts against the manifest. Check `PRAGMA foreign_key_check`. Verify representative body and attachment object keys exist in `smart-inbox-files`.
6. Change the production `DB` binding to the restored database and deploy. Retain the original database until validation is complete. Keep the same R2 bindings, Access audience, and encryption key.
7. Sending and acknowledgements are explicitly false, and `restore_reconciled` is false. All unsent restored jobs are quarantined as uncertain. OAuth state and expired processing leases are cleared.
8. In Activity & sending, choose Reconcile Gmail. This synchronizes all connected mailboxes from their restored cursors and checks every unsent job against Sent. Reconnect revoked mailboxes first. Unmatched jobs stay quarantined for deliberate review; they are never automatically retried.
9. After successful reconciliation, inspect recent conversations and attachments, then enable outgoing processing and acknowledgements as needed.
10. Retain the original database and downloaded snapshot until the restored system has been verified. Delete the private local exports when no longer needed.

For a large backlog, reconcile older jobs individually before the final recovery operation; the interactive recovery request is bounded at 200 outstanding jobs. Very large database snapshots will need a streamed export workflow as usage grows; monitor backup completion and D1 size rather than assuming backups succeeded.

## Restoration drill

The automated suite creates a local D1/R2 snapshot, runs the generated restore statements, validates the recovered message records, and confirms sending remains paused.

Run `node scripts/cloudflare.mjs restore-drill` to repeat this check against the latest completed export. It creates a separate temporary D1 database, runs the same recovery SQL, checks row counts, foreign keys, paused sending controls and referenced R2 objects, and deletes its temporary database in a finally block. It never changes the production database or its bindings. Large text values are restored in bounded Unicode-safe SQL chunks to stay below D1's statement-size limit.

## D1 Time Travel alternative

Before an in-place Time Travel restore, pause sending and disable the queue consumer/cron triggers until the restored database has explicitly been updated to set `sending_enabled=false`, `acknowledgements_enabled=false`, and `restore_reconciled=false`. An older database can otherwise restore an enabled flag. Re-enable background workers, then perform the same Gmail reconciliation. Prefer the new-database restore above when an export is available.

Source: [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

AI recovery: exports include the draft-run ledger and documentation index. Restore pauses AI and quarantines unfinished runs; complete Gmail reconciliation, then deliberately re-enable AI in Settings. Older exports without AI tables restore with empty AI data. See [AI drafts](ai-drafts.md).

Report recovery: exports preserve recorded status changes and the date resolution tracking began. Older exports without the status ledger restore with empty closure history and a new tracking start time. Restoring a snapshot does not create artificial closure events.
