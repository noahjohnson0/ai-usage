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

// Codex rollouts are local per machine, so sum tokens across hosts (like Claude).
// The rate-limit % is account-level, so take the most recent snapshot.
function mergeCodex(slices) {
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const models = new Map();
  let any = false;
  let totalTokens2026 = 0;
  let totalTokensMonth = 0;
  let sessions = 0;
  let limitPercent = null;
  let weeklyPercent = null;
  let bestTs = "";
  for (const s of slices) {
    const c = s.tools?.codex;
    if (!c?.available) continue;
    any = true;
    for (const k of Object.keys(totals)) totals[k] += c.totals?.[k] || 0;
    totalTokens2026 += c.totalTokens2026 || 0;
    totalTokensMonth += c.totalTokensMonth || 0;
    sessions += c.sessions || 0;
    for (const m of c.models || []) {
      const p = models.get(m.model) || { model: m.model, totalTokens: 0 };
      p.totalTokens += m.totalTokens;
      models.set(m.model, p);
    }
    if ((s.collectedAt || "") >= bestTs) {
      bestTs = s.collectedAt || "";
      if (c.limitPercent != null) limitPercent = c.limitPercent;
      if (c.weeklyPercent != null) weeklyPercent = c.weeklyPercent;
    }
  }
  if (!any) return { available: false };
  return {
    available: true,
    totals,
    totalTokens: totals.totalTokens,
    totalTokens2026,
    totalTokensMonth,
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    limitPercent,
    weeklyPercent,
    sessions,
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
    codex: mergeCodex(slices),
  },
};

// Token-centric headline across ALL tools (no dollars on public surfaces).
const claude = merged.tools.claude;
const cursor = merged.tools.cursor;
const codex = merged.tools.codex;
const tokTool = (t) => (t.available ? t.totalTokens || t.totals?.totalTokens || 0 : 0);
const p2026 = (t) => (t.available ? t.totalTokens2026 || 0 : 0);
const pMonth = (t) => (t.available ? t.totalTokensMonth || 0 : 0);
const claudeOut = claude.available ? claude.totals.outputTokens : 0;
const cursorOut = cursor.available ? cursor.tokenTotals?.outputTokens || 0 : 0;
const codexOut = codex.available ? codex.totals?.outputTokens || 0 : 0;
const modelNames = new Set([
  ...(claude.available ? claude.models.map((m) => m.model) : []),
  ...(cursor.available ? (cursor.models || []).map((m) => m.model) : []),
  ...(codex.available ? (codex.models || []).map((m) => m.model) : []),
]);
merged.headline = {
  tokensMonth: pMonth(claude) + pMonth(cursor) + pMonth(codex),
  tokens2026: p2026(claude) + p2026(cursor) + p2026(codex),
  totalTokens: tokTool(claude) + tokTool(cursor) + tokTool(codex), // all-time
  outputTokens: claudeOut + cursorOut + codexOut,
  modelsUsed: modelNames.size,
  machineCount: merged.machines.length,
};

// Monotonic live-ticker anchor: every client computes value + ratePerSec*(now-atMs),
// a pure function of wall-clock time, so the number is identical for all viewers
// and only ever climbs. The published anchor itself never decreases either: it is
// floored at the previous anchor's projection, so a data refresh can only step it
// UP (even if a quiet period means real growth lagged the estimate).
const nowMs = Date.now();
const since2026Sec = Math.max(1, (nowMs - Date.parse("2026-01-01T00:00:00Z")) / 1000);
// ~85% of the realized 2026 average tokens/sec: visibly ticking, conservative
// enough that real growth normally stays ahead of the projection.
const ratePerSec = Math.max(1, Math.round((merged.headline.tokens2026 / since2026Sec) * 0.85));
let prevAnchor = null;
try {
  prevAnchor = JSON.parse(fs.readFileSync(path.join(repoRoot, "public", "usage.json"), "utf8")).headline?.tokenAnchor || null;
} catch {
  /* first run */
}
const projectedFloor = prevAnchor
  ? prevAnchor.value + prevAnchor.ratePerSec * Math.max(0, (nowMs - prevAnchor.atMs) / 1000)
  : 0;
merged.headline.tokenAnchor = {
  value: Math.round(Math.max(merged.headline.tokens2026, projectedFloor)),
  atMs: nowMs,
  ratePerSec,
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
