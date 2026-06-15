import { spawn } from "node:child_process";

// Claude Code usage has no cloud API for personal Pro/Max subscriptions.
// The only record is the local ~/.claude JSONL transcripts, which `ccusage`
// parses (tokens + API-equivalent cost). We shell out to it via npx so the
// reporter carries no heavy dependency.
//
// Returns null fields (available:false) when ccusage can't run, so the rest of
// the pipeline degrades gracefully on machines that never used Claude Code.

function runCcusage(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npx.cmd" : "npx";
    const child = spawn(cmd, ["-y", "ccusage@latest", ...args], {
      shell: isWin, // npx.cmd needs a shell on Windows
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        resolve({ ok: false, error: err.trim() || `ccusage exited ${code}` });
        return;
      }
      try {
        resolve({ ok: true, json: JSON.parse(out) });
      } catch (e) {
        resolve({ ok: false, error: `parse failed: ${e.message}` });
      }
    });
  });
}

export async function collectClaude() {
  // --since 20200101 forces all-time totals rather than the default window.
  const res = await runCcusage(["--json", "--since", "20200101"]);
  if (!res.ok) {
    return { available: false, note: res.error };
  }
  const j = res.json;
  const daily = Array.isArray(j.daily) ? j.daily : [];
  const t = j.totals || {};

  // Aggregate per-model across all days from modelBreakdowns.
  const modelMap = new Map();
  for (const day of daily) {
    for (const m of day.modelBreakdowns || []) {
      const name = m.modelName || "unknown";
      const prev = modelMap.get(name) || { model: name, totalTokens: 0, cost: 0 };
      prev.totalTokens +=
        (m.inputTokens || 0) +
        (m.outputTokens || 0) +
        (m.cacheCreationTokens || 0) +
        (m.cacheReadTokens || 0);
      prev.cost += m.cost || 0;
      modelMap.set(name, prev);
    }
  }

  // Period scoping: daily entries are dated YYYY-MM-DD, so string compares work.
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const sumSince = (cut) =>
    daily.filter((d) => (d.date || d.period || "") >= cut).reduce((a, d) => a + (d.totalTokens || 0), 0);

  return {
    available: true,
    source: "local:ccusage",
    totals: {
      inputTokens: t.inputTokens || 0,
      outputTokens: t.outputTokens || 0,
      cacheCreationTokens: t.cacheCreationTokens || 0,
      cacheReadTokens: t.cacheReadTokens || 0,
      totalTokens: t.totalTokens || 0,
      costUsd: round(t.totalCost || 0), // API-equivalent value on a subscription
    },
    totalTokens2026: sumSince("2026-01-01"),
    totalTokensMonth: sumSince(monthStart),
    models: [...modelMap.values()]
      .map((m) => ({ ...m, cost: round(m.cost) }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    daily: daily.map((d) => ({
      date: d.date || d.period || null,
      totalTokens: d.totalTokens || 0,
      costUsd: round(d.totalCost || 0),
    })),
    days: daily.length,
  };
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
