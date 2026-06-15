// OpenRouter is the one true cloud API here: usage is keyed to the API key, so
// this adapter works identically on any machine OR in the cloud (the GitHub
// Action runs it directly). /credits + /key always work; /activity (per-model,
// which isolates Kimi and anything else routed through OpenRouter) needs a
// provisioning/management key.

async function orGet(pathname, key) {
  const r = await fetch(`https://openrouter.ai/api/v1${pathname}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.data ?? j;
}

export async function collectOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PROVISIONING_KEY;
  if (!key) return { available: false, note: "OPENROUTER_API_KEY not set" };

  try {
    const credits = await orGet("/credits", key);
    let keyInfo = {};
    try {
      keyInfo = await orGet("/key", key);
    } catch {
      /* optional */
    }

    // Per-model breakdown requires a management key; degrade quietly otherwise.
    let activity = null;
    const mgmtKey = process.env.OPENROUTER_PROVISIONING_KEY;
    if (mgmtKey) {
      try {
        activity = await orGet("/activity", mgmtKey);
      } catch (e) {
        activity = { error: e.message };
      }
    }

    const totalUsage = credits.total_usage ?? 0;
    const totalCredits = credits.total_credits ?? 0;

    return {
      available: true,
      source: "cloud:openrouter-api",
      spendUsd: round(totalUsage),
      creditsUsd: round(totalCredits),
      remainingUsd: round(totalCredits - totalUsage),
      limit: keyInfo.limit ?? null,
      limitRemaining: keyInfo.limit_remaining ?? null,
      usageDaily: keyInfo.usage_daily ?? null,
      usageWeekly: keyInfo.usage_weekly ?? null,
      usageMonthly: keyInfo.usage_monthly ?? null,
      hasPerModel: Array.isArray(activity),
      activity: Array.isArray(activity) ? activity : undefined,
    };
  } catch (e) {
    return { available: false, note: `openrouter api failed: ${e.message}` };
  }
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
