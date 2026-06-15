#!/usr/bin/env node
// Merge every machine slice in data/machines/*.json into one public/usage.json
// that the GitHub profile card and the nanlives dashboard both read.
//
// Merge rules differ by tool:
//   - Claude: usage lives in per-machine local transcripts, so SUM across machines.
//   - Cursor / OpenRouter / Kimi / Codex: account-level (same numbers from any
//     machine), so take the MOST RECENT available slice. Never sum (double count).
//
// The OpenRouter adapter can also run cloud-side in CI, so a fresh openrouter
// reading is injected as a synthetic "cloud" machine before merge when the key
// is present.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectOpenRouter } from "../reporter/adapters/openrouter.mjs";
import { sanitizeForPublic } from "../reporter/lib/sanitize.mjs";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const machinesDir = path.join(repoRoot, "data", "machines");

function loadSlices() {
  if (!fs.existsSync(machinesDir)) return [];
  return fs
    .readdirSync(machinesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(machinesDir, f), "utf8")));
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function mergeClaude(slices) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0 };
  const models = new Map();
  const daily = new Map();
  let any = false;
  let tokens2026 = 0;
  let tokensMonth = 0;
  const byMachine = [];

  for (const s of slices) {
    const c = s.tools?.claude;
    if (!c?.available) continue;
    any = true;
    for (const k of Object.keys(totals)) totals[k] += c.totals?.[k] || 0;
    tokens2026 += c.totalTokens2026 || 0;
    tokensMonth += c.totalTokensMonth || 0;
    byMachine.push({ machine: s.machine.id, totalTokens: c.totals.totalTokens, costUsd: c.totals.costUsd });
    for (const m of c.models || []) {
      const p = models.get(m.model) || { model: m.model, totalTokens: 0, cost: 0 };
      p.totalTokens += m.totalTokens;
      p.cost += m.cost;
      models.set(m.model, p);
    }
    for (const d of c.daily || []) {
      if (!d.date) continue;
      const p = daily.get(d.date) || { date: d.date, totalTokens: 0, costUsd: 0 };
      p.totalTokens += d.totalTokens;
      p.costUsd += d.costUsd;
      daily.set(d.date, p);
    }
  }
  if (!any) return { available: false };
  return {
    available: true,
    totals: { ...totals, costUsd: round(totals.costUsd) },
    totalTokens2026: tokens2026,
    totalTokensMonth: tokensMonth,
    models: [...models.values()].map((m) => ({ ...m, cost: round(m.cost) })).sort((a, b) => b.totalTokens - a.totalTokens),
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    byMachine,
  };
}

function mostRecent(slices, tool) {
  let best = null;
  for (const s of slices) {
    const t = s.tools?.[tool];
    if (!t?.available) continue;
    if (!best || s.collectedAt > best.collectedAt) best = { ...t, collectedAt: s.collectedAt, machine: s.machine.id };
  }
  return best || { available: false };
}

const slices = loadSlices();

// Inject a fresh cloud OpenRouter reading when a key is available (CI path).
if (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PROVISIONING_KEY) {
  const or = await collectOpenRouter();
  if (or.available) {
    slices.push({ machine: { id: "cloud" }, collectedAt: new Date().toISOString(), tools: { openrouter: or } });
  }
}

const merged = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  machines: slices.map((s) => ({ id: s.machine.id, platform: s.machine.platform, collectedAt: s.collectedAt })),
  tools: {
    claude: mergeClaude(slices),
    cursor: mostRecent(slices, "cursor"),
    openrouter: mostRecent(slices, "openrouter"),
    kimi: mostRecent(slices, "kimi"),
    codex: mostRecent(slices, "codex"),
  },
};

// Token-centric headline across ALL tools (no dollars on public surfaces).
const claude = merged.tools.claude;
const cursor = merged.tools.cursor;
const claudeTok = claude.available ? claude.totals.totalTokens : 0;
const cursorTok = cursor.available ? cursor.totalTokens || 0 : 0;
const claudeOut = claude.available ? claude.totals.outputTokens : 0;
const cursorOut = cursor.available ? cursor.tokenTotals?.outputTokens || 0 : 0;
const modelNames = new Set([
  ...(claude.available ? claude.models.map((m) => m.model) : []),
  ...(cursor.available ? (cursor.models || []).map((m) => m.model) : []),
]);
const claude2026 = claude.available ? claude.totalTokens2026 || 0 : 0;
const cursor2026 = cursor.available ? cursor.totalTokens2026 || 0 : 0;
const claudeMonth = claude.available ? claude.totalTokensMonth || 0 : 0;
const cursorMonth = cursor.available ? cursor.totalTokensMonth || 0 : 0;
merged.headline = {
  tokensMonth: claudeMonth + cursorMonth,
  tokens2026: claude2026 + cursor2026,
  totalTokens: claudeTok + cursorTok, // all-time
  outputTokens: claudeOut + cursorOut,
  modelsUsed: modelNames.size,
  machineCount: merged.machines.length,
};

// public/usage.json is world-readable. Slices arrive already scrubbed; this is
// belt-and-suspenders for the cloud OpenRouter injection and any future tool.
// AI_USAGE_INCLUDE_COST=1 keeps dollars for a private mirror.
const publish = sanitizeForPublic(merged);

const outDir = path.join(repoRoot, "public");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "usage.json"), JSON.stringify(publish, null, 2) + "\n");
console.log(`merged ${slices.length} slice(s) -> public/usage.json`);
console.log(`  tokens ${merged.headline.totalTokens.toLocaleString()} | output ${merged.headline.outputTokens.toLocaleString()} | models ${merged.headline.modelsUsed} | machines ${merged.headline.machineCount}`);
