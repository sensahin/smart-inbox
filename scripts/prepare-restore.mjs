import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { recoveryStatements, tables } from "./recovery-sql.mjs";
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath)
  throw new Error(
    "Usage: node scripts/prepare-restore.mjs /private/export/manifest.json /private/export/restore.sql",
  );
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== 1) throw new Error("Unsupported export version.");
const snapshot = {};
for (const name of tables) {
  const entry = manifest.tables.find((t) => t.table === name);
  if (!entry && name === "message_opens") {
    snapshot[name] = [];
    continue;
  }
  if (!entry) throw new Error("Export is missing " + name);
  const rows = JSON.parse(
    await readFile(resolve(dirname(manifestPath), basename(entry.key)), "utf8"),
  );
  if (rows.length !== entry.rows) throw new Error("Incomplete table " + name);
  snapshot[name] = rows;
}
await writeFile(outputPath, recoveryStatements(snapshot).join(";\n") + ";\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  "Prepared restore SQL with sending and acknowledgements paused. Import into a NEW database as described in docs/recovery.md.",
);
