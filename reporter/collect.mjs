#!/usr/bin/env node
// Universal reporter: run on each machine (and in the cloud). Collects whatever
// usage data that machine can see, tags it with the machine id, and writes a
// per-machine slice to data/machines/<id>.json. With --push it commits + pushes
// that slice so the GitHub Action can merge + render.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { machineMeta } from "./lib/machine.mjs";
import { sanitizeForPublic } from "./lib/sanitize.mjs";
import { collectClaude } from "./adapters/claude.mjs";
import { collectCursor } from "./adapters/cursor.mjs";
import { collectOpenRouter } from "./adapters/openrouter.mjs";
import { collectKimi } from "./adapters/kimi.mjs";
import { collectCodex } from "./adapters/codex.mjs";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const push = process.argv.includes("--push");

// Optional local secrets (gitignored) so scrapers can run without exporting env
// vars: { "KIMI_COOKIE": "...", "CHATGPT_SESSION_TOKEN": "...",
//         "MOONSHOT_API_KEY": "...", "OPENROUTER_PROVISIONING_KEY": "..." }
try {
  const secretsPath = path.join(repoRoot, "reporter", "secrets.local.json");
  if (fs.existsSync(secretsPath)) {
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    for (const [k, v] of Object.entries(secrets)) if (!process.env[k]) process.env[k] = v;
  }
} catch (e) {
  console.error("could not load secrets.local.json:", e.message);
}

async function safe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return { available: false, note: `${name} adapter threw: ${e.message}` };
  }
}

const meta = machineMeta();
console.log(`ai-usage reporter -> machine "${meta.id}" (${meta.platform})`);

const [claude, cursor, openrouter, kimi, codex] = await Promise.all([
  safe("claude", collectClaude),
  safe("cursor", collectCursor),
  safe("openrouter", collectOpenRouter),
  safe("kimi", collectKimi),
  safe("codex", collectCodex),
]);

const slice = {
  schema: 1,
  machine: meta,
  collectedAt: new Date().toISOString(),
  tools: { claude, cursor, openrouter, kimi, codex },
};

const outDir = path.join(repoRoot, "data", "machines");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${meta.id}.json`);
// The slice lands in a public repo, so scrub dollars before writing to disk.
// The console summary below still shows local $ from the in-memory data.
fs.writeFileSync(outFile, JSON.stringify(sanitizeForPublic(slice), null, 2) + "\n");

for (const [name, t] of Object.entries(slice.tools)) {
  const status = t.available ? "ok" : `-- ${t.note || "unavailable"}`;
  console.log(`  ${name.padEnd(11)} ${status}`);
}
console.log(`wrote ${path.relative(repoRoot, outFile)}`);

if (push) {
  try {
    const git = (...a) => execFileSync("git", a, { cwd: repoRoot, stdio: "pipe" }).toString().trim();
    git("add", path.relative(repoRoot, outFile));
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString().trim();
    if (!changed) {
      console.log("no changes to push");
    } else {
      git("commit", "-m", `data: usage from ${meta.id}`);
      // The cloud Action pushes to public/ on a schedule, so the local clone
      // drifts behind. Rebase before pushing (slice vs public/ never conflict).
      try {
        git("pull", "--rebase", "origin", "main");
      } catch (e) {
        console.error("pull --rebase warning:", e.message);
      }
      git("push");
      console.log("pushed slice to hub");
    }
  } catch (e) {
    console.error("push failed:", e.message);
    process.exitCode = 1;
  }
}
