import type { AppEnv } from "./env";
import type { Outgoing } from "../shared/types";
import { all, AppError, now, recordEvent, run, setSetting } from "./db";
import { synchronize } from "./sync";
import { reconcileOutgoing } from "./outbox";
export async function reconcileRestore(env: AppEnv) {
  await setSetting(env, "ai_paused", "true");
  await setSetting(env, "sending_enabled", "false");
  await setSetting(env, "acknowledgements_enabled", "false");
  await setSetting(env, "restore_reconciled", "false");
  const started = now();
  const mailboxes = await all<{ id: string; state: string }>(
    env.DB,
    "SELECT id,state FROM mailboxes",
  );
  for (const mailbox of mailboxes) {
    if (mailbox.state !== "connected")
      throw new AppError(
        409,
        "Reconnect every mailbox before completing restore reconciliation.",
      );
    await synchronize(env, mailbox.id);
  }
  const incomplete = await all(
    env.DB,
    "SELECT id FROM mailboxes WHERE last_sync_at<? OR last_sync_at IS NULL OR error IS NOT NULL",
    started,
  );
  if (incomplete.length)
    throw new AppError(
      409,
      "Mailbox synchronization is incomplete. Check connection health and try again.",
    );
  const jobs = await all<Outgoing>(
    env.DB,
    "SELECT * FROM outgoing WHERE state<>'sent' LIMIT 201",
  );
  if (jobs.length > 200)
    throw new AppError(
      409,
      "More than 200 jobs need reconciliation. Reconcile older jobs before completing recovery.",
    );
  let uncertain = 0;
  for (const job of jobs) {
    if (!(await reconcileOutgoing(env, job))) {
      await run(
        env.DB,
        "UPDATE outgoing SET state='uncertain',lease_owner=NULL,lease_until=0,error='Restored send was not found in Gmail. Verify Sent before retrying.',updated_at=? WHERE id=? AND state<>'sent'",
        now(),
        job.id,
      );
      uncertain++;
    }
  }
  await setSetting(env, "restore_reconciled", "true");
  await recordEvent(
    env,
    "restore_reconciled",
    null,
    `Gmail reconciliation completed. ${uncertain} unmatched sends remain quarantined for owner review.`,
  );
  return { uncertain };
}
