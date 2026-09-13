import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
const configFile = process.env.SMART_INBOX_CONFIG || "wrangler.instance.jsonc";
import { parse } from "jsonc-parser";
import {
  recoveryStatements,
  tables as recoveryTables,
} from "./recovery-sql.mjs";
async function readConfig() {
  const errors = [];
  const config = parse(await readFile(configFile, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length) throw new Error("Invalid Wrangler configuration.");
  return config;
}
const credentialFile =
  process.env.SMART_INBOX_CREDENTIALS ||
  join(homedir(), ".config/smart-inbox/cloudflare.env");
const credentials = {
  ...Object.fromEntries(
    (
      await readFile(credentialFile, "utf8").catch((e) => {
        if (e.code === "ENOENT") return "";
        throw e;
      })
    )
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ),
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      key.startsWith("CLOUDFLARE_"),
    ),
  ),
};

const account = credentials.CLOUDFLARE_ACCOUNT_ID;
if (!account || !credentials.CLOUDFLARE_API_TOKEN)
  throw new Error("Missing Cloudflare account ID or token.");
async function api(path, method = "GET", body) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${credentials.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const d = await r.json();
  if (!r.ok || !d.success)
    throw new Error(
      `${method} ${path}: HTTP ${r.status}; ${d.errors?.map((e) => e.code + ": " + e.message).join("; ")}`,
    );
  return d.result;
}
const mode = process.argv[2];
if (mode === "provision") {
  const config = await readConfig();
  if (!config.vars.OWNER_EMAIL)
    throw new Error("Run npm run setup and choose an owner email first.");
  config.account_id = account;
  const databases = await api("/d1/database");
  let db = databases.find(
    (d) => d.name === config.d1_databases[0].database_name,
  );
  if (!db)
    db = await api("/d1/database", "POST", {
      name: config.d1_databases[0].database_name,
    });
  config.d1_databases[0].database_id = db.uuid;
  const r2 = await api("/r2/buckets");
  for (const name of config.r2_buckets.map((b) => b.bucket_name))
    if (!r2.buckets.some((b) => b.name === name))
      await api("/r2/buckets", "POST", { name });
  const queues = await api("/queues");
  for (const name of new Set([
    ...config.queues.producers.map((q) => q.queue),
    ...config.queues.consumers.map((q) => q.dead_letter_queue).filter(Boolean),
  ]))
    if (!queues.some((q) => q.queue_name === name))
      await api("/queues", "POST", { queue_name: name });
  const subdomain = await api("/workers/subdomain");
  config.vars.APP_ORIGIN = `https://${config.name}.${subdomain.subdomain}.workers.dev`;
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
  console.log(
    "Provisioned D1, private R2 buckets, and queues. Configured " +
      config.vars.APP_ORIGIN,
  );
} else if (mode === "setup-tracking") {
  const config = await readConfig();
  if (!config.d1_databases[0].database_id || !config.vars.APP_ORIGIN)
    throw new Error("Provision the main app before configuring tracking.");
  const tracking = parse(await readFile("wrangler.tracking.jsonc", "utf8"));
  tracking.name = `${config.name}-opens`;
  tracking.account_id = account;
  tracking.d1_databases = config.d1_databases;
  const subdomain = await api("/workers/subdomain");
  tracking.vars.APP_ORIGIN = `https://${tracking.name}.${subdomain.subdomain}.workers.dev`;
  const path = "wrangler.instance-tracking.jsonc";
  await writeFile(path, JSON.stringify(tracking, null, 2) + "\n", {
    mode: 0o600,
  });
  config.vars.OPEN_TRACKING_ORIGIN = tracking.vars.APP_ORIGIN;
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
  console.log(
    "Tracking configuration prepared. Apply migrations, deploy with SMART_INBOX_CONFIG=" +
      path +
      ", then deploy the main app. Tracking stays disabled until enabled in Settings.",
  );
} else if (mode === "setup-access") {
  const login = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], "utf8")).web
    : null;
  const config = await readConfig();
  if (!config.vars.OWNER_EMAIL || !config.vars.APP_ORIGIN)
    throw new Error(
      "Configure the owner email and provision the app URL first.",
    );
  const organization = await api("/access/organizations");
  if (
    login &&
    !login.redirect_uris?.includes(
      `https://${organization.auth_domain}/cdn-cgi/access/callback`,
    )
  )
    throw new Error(
      "The login client callback does not match the Access organization.",
    );
  const providers = await api("/access/identity_providers");
  const providerName = `${config.name} ${login ? "Google login" : "email PIN"}`;
  let provider = providers.find((p) =>
    login ? p.name === providerName : p.type === "onetimepin",
  );
  const providerBody = {
    name: providerName,
    type: login ? "google" : "onetimepin",
    config: login
      ? { client_id: login.client_id, client_secret: login.client_secret }
      : {},
  };
  if (login || !provider)
    provider = await api(
      "/access/identity_providers" + (provider ? "/" + provider.id : ""),
      provider ? "PUT" : "POST",
      providerBody,
    );
  const apps = await api("/access/apps");
  let app = apps.find(
    (a) => a.domain === new URL(config.vars.APP_ORIGIN).hostname,
  );
  const appBody = {
    name: config.name,
    type: "self_hosted",
    domain: new URL(config.vars.APP_ORIGIN).hostname,
    session_duration: "24h",
    allowed_idps: [provider.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: true,
    policies: [
      {
        name: "Owner only",
        decision: "allow",
        precedence: 1,
        include: [{ email: { email: config.vars.OWNER_EMAIL } }],
        require: [],
        exclude: [],
      },
    ],
  };
  app = await api(
    "/access/apps" + (app ? "/" + app.id : ""),
    app ? "PUT" : "POST",
    appBody,
  );
  config.vars.ACCESS_TEAM_DOMAIN = organization.auth_domain;
  config.vars.ACCESS_AUD = app.aud;
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
  const keyFile = join(dirname(credentialFile), "encryption-key");
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  let key;
  try {
    key = (await readFile(keyFile, "utf8")).trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const rows = await api(
      `/d1/database/${config.d1_databases[0].database_id}/query`,
      "POST",
      { sql: "SELECT COUNT(*) count FROM settings WHERE key LIKE 'secret:%'" },
    );
    if (rows[0]?.results[0]?.count)
      throw new Error(
        "The encryption-key backup is missing for an existing installation. Restore that key instead of creating a new one.",
      );
    key = randomBytes(32).toString("base64");
    await writeFile(keyFile, key + "\n", { mode: 0o600, flag: "wx" });
  }
  const child = spawn(
    "node",
    [
      "node_modules/wrangler/bin/wrangler.js",
      "--config",
      configFile,
      "secret",
      "put",
      "ENCRYPTION_KEY",
    ],
    {
      env: { ...process.env, ...credentials },
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  child.stdin.end(key + "\n");
  await new Promise((resolve, reject) =>
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Worker secret upload failed.")),
    ),
  );
  console.log(
    "Owner-only Access and encryption are configured. Deploy the updated instance configuration, then sign in and connect providers through Settings.",
  );
} else if (mode === "restore-drill") {
  const config = await readConfig();
  const current = await api(
    `/d1/database/${config.d1_databases[0].database_id}/query`,
    "POST",
    {
      sql: "SELECT value FROM settings WHERE key='last_backup'",
    },
  );
  const latest = JSON.parse(current[0]?.results[0]?.value || "null");
  if (!latest?.key) throw new Error("Run a successful backup first.");
  async function object(bucket, key) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.CLOUDFLARE_API_TOKEN}`,
        },
      },
    );
    if (!response.ok)
      throw new Error(`Cannot read backup object: HTTP ${response.status}`);
    return response;
  }
  const backupBucket = config.r2_buckets.find(
    (bucket) => bucket.binding === "BACKUPS",
  ).bucket_name;
  const filesBucket = config.r2_buckets.find(
    (bucket) => bucket.binding === "FILES",
  ).bucket_name;
  const manifest = await (await object(backupBucket, latest.key)).json();
  const snapshot = {};
  for (const table of recoveryTables) {
    const entry = manifest.tables.find((item) => item.table === table);
    if (!entry && table === "message_opens") {
      snapshot[table] = [];
      continue;
    }
    if (!entry) throw new Error(`Missing backup table: ${table}`);
    snapshot[table] = await (await object(backupBucket, entry.key)).json();
    if (snapshot[table].length !== entry.rows)
      throw new Error(`Incomplete backup table: ${table}`);
  }
  const name = `${config.name}-restore-check-${Date.now()}`;
  const database = await api("/d1/database", "POST", { name });
  const id = database.uuid;
  console.log(JSON.stringify({ drill_database: id, name, backup: latest.key }));
  try {
    for (const migration of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await api(`/d1/database/${id}/query`, "POST", {
        sql: await readFile(`migrations/${migration}`, "utf8"),
      });
    await api(`/d1/database/${id}/query`, "POST", {
      sql: recoveryStatements(snapshot).join(";\n") + ";",
    });
    const counts = await api(`/d1/database/${id}/query`, "POST", {
      sql:
        recoveryTables
          .map(
            (table) =>
              `SELECT '${table}' AS table_name,COUNT(*) AS count FROM ${table}`,
          )
          .join(";") +
        ";PRAGMA foreign_key_check;SELECT key,value FROM settings WHERE key IN ('sending_enabled','acknowledgements_enabled','restore_reconciled')",
    });
    for (let i = 0; i < recoveryTables.length; i++) {
      const table = recoveryTables[i];
      if (counts[i].results[0].count !== snapshot[table].length)
        throw new Error(`Restored row count mismatch: ${table}`);
    }
    if (counts[recoveryTables.length].results.length)
      throw new Error("Restored foreign key check failed.");
    if (
      counts.at(-1).results.some((row) => row.value !== "false") ||
      counts.at(-1).results.length !== 3
    )
      throw new Error("Restored sending controls are not paused.");
    const keys = [
      ...new Set(
        [
          ...snapshot.messages.flatMap((message) => [message.body_key]),
          ...snapshot.attachments.map((attachment) => attachment.object_key),
        ].filter(Boolean),
      ),
    ];
    for (const key of keys) {
      const response = await object(filesBucket, key);
      await response.body?.cancel();
    }
    console.log(
      JSON.stringify({
        restored: true,
        tables: recoveryTables.length,
        conversations: snapshot.conversations.length,
        messages: snapshot.messages.length,
        objects_verified: keys.length,
        foreign_keys: "valid",
        sending: "paused",
        reconciliation_required: true,
      }),
    );
  } finally {
    await api(`/d1/database/${id}`, "DELETE");
    const remaining = await api("/d1/database");
    if (remaining.some((item) => item.uuid === id))
      throw new Error("Restore-check database cleanup did not complete.");
    console.log("Temporary restoration database deleted and absence verified.");
  }
} else if (mode === "backup") {
  const config = await readConfig();
  const queue = (await api("/queues")).find(
    (q) =>
      q.queue_name ===
      config.queues.producers.find((p) => p.binding === "JOBS").queue,
  );
  if (!queue) throw new Error("Queue not found.");
  await api(`/queues/${queue.queue_id}/messages`, "POST", {
    body: { type: "backup" },
    content_type: "json",
  });
  console.log("Backup queued.");
} else if (mode === "health") {
  const config = await readConfig();
  console.log(
    JSON.stringify({
      schedules: await api(`/workers/scripts/${config.name}/schedules`),
    }),
  );
  const result = await api(
    `/d1/database/${config.d1_databases[0].database_id}/query`,
    "POST",
    {
      sql: "SELECT key,value FROM settings WHERE key IN ('sending_enabled','acknowledgements_enabled','restore_reconciled','last_backup','backup_error')",
    },
  );
  console.log(JSON.stringify(result.map((r) => r.results)));
  const mailboxes = await api(
    `/d1/database/${config.d1_databases[0].database_id}/query`,
    "POST",
    { sql: "SELECT email,state,last_sync_at,error FROM mailboxes" },
  );
  console.log(JSON.stringify(mailboxes.map((r) => r.results)));
  for (const name of config.r2_buckets.map((b) => b.bucket_name)) {
    const domains = await api(`/r2/buckets/${name}/domains/managed`);
    console.log(
      JSON.stringify({ bucket: name, public_access: domains.enabled }),
    );
  }
} else if (mode === "access-status") {
  for (const path of [
    "/access/organizations",
    "/access/identity_providers",
    "/access/apps",
  ]) {
    try {
      const r = await api(path);
      console.log(
        JSON.stringify({
          path,
          result: Array.isArray(r)
            ? r.map((x) => ({
                id: x.id,
                name: x.name,
                type: x.type,
                domain: x.domain,
              }))
            : { name: r.name, auth_domain: r.auth_domain },
        }),
      );
    } catch (e) {
      console.log(e.message);
    }
  }
} else if (mode === "wrangler") {
  const child = spawn(
    "node",
    [
      "node_modules/wrangler/bin/wrangler.js",
      "--config",
      configFile,
      ...process.argv.slice(3),
    ],
    { env: { ...process.env, ...credentials }, stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else
  throw new Error(
    "Use provision, setup-access [google-login.json], setup-tracking, access-status, health, backup, restore-drill, or wrangler <arguments>.",
  );
