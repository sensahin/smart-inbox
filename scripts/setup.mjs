import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parse } from "jsonc-parser";

const destination = "wrangler.instance.jsonc";
try {
  await readFile(destination);
  throw new Error(
    `${destination} already exists. Edit it to change deployment settings; setup will not overwrite it.`,
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const rl = createInterface({ input: stdin, output: stdout });
try {
  const name =
    (await rl.question("Cloudflare Worker name [smart-inbox]: ")).trim() ||
    "smart-inbox";
  const owner = (await rl.question("Owner login email (required): "))
    .trim()
    .toLowerCase();
  const domain = (
    await rl.question(
      "Allowed mailbox domain (optional, blank allows any domain): ",
    )
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name))
    throw new Error(
      "Use a lowercase Worker name with letters, numbers and hyphens, up to 41 characters.",
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))
    throw new Error(
      "A valid owner login email is required. Nothing was written.",
    );
  if (domain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain))
    throw new Error("Invalid mailbox domain.");
  const config = parse(await readFile("wrangler.jsonc", "utf8"));
  config.name = name;
  config.vars.OWNER_EMAIL = owner;
  config.vars.WORKSPACE_DOMAIN = domain;
  config.d1_databases[0].database_name = name;
  for (const bucket of config.r2_buckets)
    bucket.bucket_name = `${name}-${bucket.binding.toLowerCase()}`;
  for (const queue of config.queues.producers)
    queue.queue = queue.queue.replace(/^smart-inbox/, name);
  for (const queue of config.queues.consumers) {
    queue.queue = queue.queue.replace(/^smart-inbox/, name);
    queue.dead_letter_queue = queue.dead_letter_queue.replace(
      /^smart-inbox/,
      name,
    );
  }
  await writeFile(destination, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Private instance configuration saved. Follow docs/deployment.md to provision resources and enable owner-only Access. Integrations remain unconfigured.",
  );
} finally {
  rl.close();
}
