import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Codex (ChatGPT plan) has no usage API, BUT the Codex CLI writes session
// "rollout" JSONL under ~/.codex/sessions/**, and each carries cumulative
// total_token_usage plus the live rate_limits snapshot. So — exactly like Claude
// via ccusage — Codex usage is a pure LOCAL read: no API call, no cookie, no
// quota burned. Per-machine (rollouts are local), so the merge sums across hosts.

function sessionsDir() {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "sessions");
}

function* walkJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

export async function collectCodex() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return { available: false, note: "no codex sessions on this machine" };
  const files = [...walkJsonl(dir)];
  if (!files.length) return { available: false, note: "no codex rollout files" };

  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const byModel = new Map();
  let totalTokens2026 = 0;
  let totalTokensMonth = 0;
  let latestTs = "";
  let limitPercent = null; // 5h primary window
  let weeklyPercent = null; // secondary window if present

  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    let sessionDate = "";
    let model = "gpt-5-codex";
    let cum = null; // last cumulative total_token_usage in this session

    for (const line of lines) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = j.timestamp || "";
      if (j.type === "session_meta") {
        sessionDate = j.payload?.timestamp || ts || sessionDate;
        if (j.payload?.model) model = j.payload.model;
      }
      if (j.type === "turn_context" && j.payload?.model) model = j.payload.model;
      if (j.payload?.type === "token_count" && j.payload?.info?.total_token_usage) {
        cum = j.payload.info.total_token_usage;
        if (!sessionDate) sessionDate = ts;
        const rl = j.payload.rate_limits;
        if (rl && ts >= latestTs) {
          latestTs = ts;
          if (rl.primary?.used_percent != null) limitPercent = rl.primary.used_percent;
          if (rl.secondary?.used_percent != null) weeklyPercent = rl.secondary.used_percent;
        }
      }
    }
    if (!cum) continue;
    const day = (sessionDate || "").slice(0, 10);
    totals.inputTokens += cum.input_tokens || 0;
    totals.cachedInputTokens += cum.cached_input_tokens || 0;
    totals.outputTokens += cum.output_tokens || 0;
    totals.reasoningOutputTokens += cum.reasoning_output_tokens || 0;
    totals.totalTokens += cum.total_tokens || 0;
    if (day >= "2026-01-01") totalTokens2026 += cum.total_tokens || 0;
    if (day >= monthStart) totalTokensMonth += cum.total_tokens || 0;
    const p = byModel.get(model) || { model, totalTokens: 0 };
    p.totalTokens += cum.total_tokens || 0;
    byModel.set(model, p);
  }

  return {
    available: true,
    source: "local:codex-rollouts",
    totals,
    totalTokens: totals.totalTokens,
    totalTokens2026,
    totalTokensMonth,
    models: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    limitPercent, // % of rolling 5h window used (latest snapshot)
    weeklyPercent,
    sessions: files.length,
  };
}
