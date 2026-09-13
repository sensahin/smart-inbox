import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const { sidebarFixtures } =
  await import("../tests/fixtures/customer-sidebar.ts");
const temp = await mkdtemp(join(tmpdir(), "smart-inbox-fixtures-"));
const wrangler = (...args) =>
  execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { stdio: "pipe" },
  );
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
try {
  wrangler("d1", "migrations", "apply", "DB", "--local");
  const at = Date.now();
  const rows = [
    [
      "demo-elena",
      "Elena Martin",
      "elena@example.test",
      "Chatbot stops responding after updating",
      "Hello! After updating Northstar, our website chatbot no longer returns a response. The chat window opens normally, but the loading indicator keeps spinning. We are using WordPress 6.9 and PHP 8.3. Could you help us investigate?",
      "open",
    ],
    [
      "demo-david",
      "David Chen",
      "david@example.test",
      "Can I use my license on a staging site?",
      "We are preparing a new version of our website on a staging subdomain. Can I activate the same license there while keeping our production site active?",
      "open",
    ],
    [
      "demo-sophia",
      "Sophia Reed",
      "sophia@example.test",
      "Question about embedding PDF documents",
      "Is there a recommended file size for PDF uploads? I have a few product manuals I would like the chatbot to use.",
      "waiting",
    ],
    [
      "demo-jordan",
      "Jordan Smith",
      "jordan.smith@example.test",
      "Setting up my first AI chatbot",
      "Hi, I installed the plugin today and would appreciate some guidance with the initial chatbot settings. Thank you!",
      "open",
    ],
  ];
  const sql = [
    `INSERT OR IGNORE INTO mailboxes(id,email,refresh_token,history_id,cutover_at,aliases,state,created_at) VALUES ('demo-mailbox','support@example.com','','0',${at},'[]','disconnected',${at})`,
    `INSERT OR IGNORE INTO inboxes(id,mailbox_id,name,address,from_name,signature,created_at) VALUES ('demo-inbox','demo-mailbox','Northstar Support','support@example.com','Northstar Support','Kind regards,\nNorthstar Support',${at})`,
  ];
  for (let i = 0; i < rows.length; i++) {
    const [id, name, email, subject, body, status] = rows[i],
      time = at - i * 900000;
    sql.push(
      `INSERT OR IGNORE INTO contacts(id,email,name,created_at) VALUES (${quote(id)},${quote(email)},${quote(name)},${time})`,
      `INSERT OR IGNORE INTO conversations(id,number,inbox_id,contact_id,mailbox_id,subject,status,snippet,last_inbound_id,created_at,updated_at) VALUES (${quote(id)},${i + 1},'demo-inbox',${quote(id)},'demo-mailbox',${quote(subject)},${quote(status)},${quote(body)},${quote(id + "-message")},${time},${time})`,
      `INSERT OR IGNORE INTO messages(id,conversation_id,mailbox_id,rfc_message_id,direction,sender,sender_name,recipients,subject,body_key,search_text,sent_at) VALUES (${quote(id + "-message")},${quote(id)},'demo-mailbox',${quote("<" + id + "@example.test>")},'inbound',${quote(email)},${quote(name)},'["support@example.com"]',${quote(subject)},${quote("demo/" + id + ".json")},${quote(body)},${time})`,
    );
    const file = join(temp, id + ".json");
    await writeFile(
      file,
      JSON.stringify({ text: body, html: "<p>" + body + "</p>" }),
    );
    wrangler(
      "r2",
      "object",
      "put",
      "smart-inbox-files/demo/" + id + ".json",
      "--file",
      file,
      "--local",
    );
  }
  for (const [contactId, providers] of Object.entries(sidebarFixtures)) {
    for (const [provider, result] of Object.entries(providers)) {
      sql.push(
        `INSERT INTO integration_snapshots(contact_id,provider,payload,fetched_at) VALUES (${quote(contactId)},${quote(provider)},${quote(JSON.stringify({ ...result, fetched_at: at }))},${at}) ON CONFLICT(contact_id,provider) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at`,
      );
    }
  }
  sql.push("UPDATE counters SET value=MAX(value,100) WHERE name='ticket'");
  const path = join(temp, "fixtures.sql");
  await writeFile(path, sql.join(";\n") + ";");
  wrangler("d1", "execute", "DB", "--local", "--file", path);
  console.log(
    "Local-only fixtures loaded. No remote records or provider credentials were used.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
