import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { parse } from "jsonc-parser";
const config = parse(await readFile("wrangler.jsonc", "utf8"));
// Workers AI has no local emulator. Keep UI/data tests offline; validate inference on Cloudflare.
delete config.ai;
config.main = resolve(config.main);
config.assets.directory = resolve(config.assets.directory);
for (const db of config.d1_databases)
  db.migrations_dir = resolve(db.migrations_dir);
const path = resolve(".wrangler/local-ui.json");
await mkdir(".wrangler", { recursive: true });
await writeFile(path, JSON.stringify(config));
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    path,
    "--local",
    "--persist-to",
    resolve(".wrangler/state"),
    "--ip",
    "127.0.0.1",
    "--port",
    "8787",
    "--var",
    "LOCAL_DEV_AUTH:1",
    "--var",
    "APP_ORIGIN:http://127.0.0.1:5173",
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", async (code) => {
  await rm(path, { force: true });
  process.exit(code || 0);
});
