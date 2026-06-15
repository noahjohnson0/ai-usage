import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Kimi (Kimi For Coding subscription) has no usage API, but the Kimi Code CLI
// writes per-turn usage into session "wire" logs under ~/.kimi-code/sessions/**.
// Each usage.record turn carries {inputOther, output, inputCacheRead,
// inputCacheCreation}. So — like Claude/Codex — Kimi usage is a pure LOCAL read:
// no API, no cookie. Per-machine, so the merge sums across hosts.

function sessionsDir() {
  const base = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  return path.join(base, "sessions");
}

function* walkWire(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkWire(p);
    else if (e.name === "wire.jsonl") yield p;
  }
}

export async function collectKimi() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return { available: false, note: "no kimi-code sessions on this machine" };
  const files = [...walkWire(dir)];
  if (!files.length) return { available: false, note: "no kimi wire logs" };

  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  const byModel = new Map();
  const byDay = new Map();
  let totalTokens2026 = 0;
  let totalTokensMonth = 0;
  let turns = 0;

  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes("usage.record")) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type !== "usage.record" || j.usageScope !== "turn") continue; // turn-scoped only (avoid double count)
      const u = j.usage || {};
      const input = u.inputOther || 0;
      const output = u.output || 0;
      const cacheRead = u.inputCacheRead || 0;
      const cacheCreate = u.inputCacheCreation || 0;
      const total = input + output + cacheRead + cacheCreate;
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheReadTokens += cacheRead;
      totals.cacheCreationTokens += cacheCreate;
      totals.totalTokens += total;
      turns += 1;
      const day = j.time ? new Date(j.time).toISOString().slice(0, 10) : "";
      if (day >= "2026-01-01") totalTokens2026 += total;
      if (day >= monthStart) totalTokensMonth += total;
      const model = (j.model || "kimi-for-coding").replace(/^kimi-code\//, "");
      const p = byModel.get(model) || { model, totalTokens: 0 };
      p.totalTokens += total;
      byModel.set(model, p);
      if (day) byDay.set(day, (byDay.get(day) || 0) + total);
    }
  }

  if (!turns) return { available: false, note: "no kimi usage records yet" };
  return {
    available: true,
    source: "local:kimi-code-wire",
    totals,
    totalTokens: totals.totalTokens,
    totalTokens2026,
    totalTokensMonth,
    models: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    daily: [...byDay.entries()].map(([date, totalTokens]) => ({ date, totalTokens })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    turns,
  };
}
