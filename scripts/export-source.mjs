import { parse } from "jsonc-parser";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Export an explicit source list. Never copy the workspace, local state, or instance config.
const entries = [
  "src",
  "scripts",
  "tests",
  "migrations",
  "docs",
  ".github",
  "LICENSE",
  "README.md",
  "package.json",
  "package-lock.json",
  "index.html",
  "wrangler.jsonc",
  "wrangler.tracking.jsonc",
  "worker-configuration.d.ts",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  ".gitignore",
];
const files = [];
async function inspect(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await inspect(join(path, name));
  } else {
    if (/\.(pem|env|log)$|client_secret.*\.json$|wrangler\.instance/.test(path))
      throw new Error(`Private file in source list: ${path}`);
    const content = await readFile(path, "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{60,}|ghp_[A-Za-z0-9]{36}|cfut_[A-Za-z0-9]{40,}/.test(
        content,
      )
    )
      throw new Error(`Possible credential in ${path}. Review before release.`);
    files.push(path);
  }
}
for (const path of entries) await inspect(path);
for (const path of ["wrangler.jsonc", "wrangler.tracking.jsonc"]) {
  const template = parse(await readFile(path, "utf8"));
  if (
    template.account_id ||
    Object.values(template.vars).some(Boolean) ||
    template.d1_databases.some((d) => d.database_id)
  )
    throw new Error(
      "Public Wrangler template contains instance configuration: " + path,
    );
}
if (process.argv.includes("--check"))
  console.log(
    `Source list checked: ${files.length} files. Private instance configuration and local data are excluded. Review third-party licenses and publication content before release.`,
  );
else {
  const destination = "release/smart-inbox";
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const path of entries)
    await cp(path, join(destination, path), { recursive: true });
  console.log(
    `Source exported to ${destination}. No repository was created or published.`,
  );
}
