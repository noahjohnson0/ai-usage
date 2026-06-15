import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Cursor has no official usage API for individual Pro accounts, but the desktop
// app stores an auth JWT locally (ItemTable key cursorAuth/accessToken). We
// decode it to derive the userId, build the dashboard session cookie, and call
// the same private endpoints cursor.com itself uses. Unofficial + may change,
// so everything is wrapped defensively.

function stateDbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const home = os.homedir();
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function readToken(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("select value from ItemTable where key = ?").get("cursorAuth/accessToken");
    return row?.value || null;
  } finally {
    db.close();
  }
}

function decodeJwt(token) {
  const part = token.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
}

async function cursorGet(url, cookie) {
  const r = await fetch(url, {
    headers: {
      Cookie: cookie,
      Origin: "https://cursor.com",
      "User-Agent": "ai-usage-reporter",
    },
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function cursorPost(url, cookie, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://cursor.com",
      "Content-Type": "application/json",
      "User-Agent": "ai-usage-reporter",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

const num = (x) => Number(x || 0);

// Cursor's aggregated-usage endpoint refuses a window that crosses its internal
// storage boundaries, but the 400 body names the boundary dates ("Split the
// query at one of those dates"). Recursively split on those and collect every
// servable sub-window so we capture full history, not just the last segment.
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function aggWindow(cookie, startMs, endMs, depth = 0) {
  const url = "https://cursor.com/api/dashboard/get-aggregated-usage-events";
  let j;
  // Retry transient failures (429/5xx/network) with backoff — multiple period
  // windows fire in sequence and Cursor will rate-limit a burst otherwise.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://cursor.com", "Content-Type": "application/json", "User-Agent": "ai-usage-reporter" },
        body: JSON.stringify({ startDate: String(Math.round(startMs)), endDate: String(Math.round(endMs)) }),
      });
      j = await r.json();
      if (r.ok && Array.isArray(j.aggregations)) return [j];
      // A 400 "split the query" is not transient — break out to the split logic.
      if (r.status === 400) break;
      await sleep(400 * (attempt + 1));
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  if (!j) return [];
  if (depth >= 6) return [];
  const detail = j?.error?.details?.[0]?.details?.detail || "";
  const bounds = [...detail.matchAll(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/g)]
    .map((m) => Date.parse(m[1]))
    .filter((t) => t > startMs + 1 && t < endMs - 1)
    .sort((a, b) => a - b);
  if (!bounds.length) return [];
  const b = bounds[0];
  const left = await aggWindow(cookie, startMs, b - 1, depth + 1);
  const right = await aggWindow(cookie, b, endMs, depth + 1);
  return [...left, ...right];
}

export async function collectCursor() {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) {
    return { available: false, note: "cursor state.vscdb not found on this machine" };
  }
  let token;
  try {
    token = readToken(dbPath);
  } catch (e) {
    return { available: false, note: `could not read cursor db: ${e.message}` };
  }
  if (!token) return { available: false, note: "no cursor auth token (not signed in?)" };

  let userId;
  try {
    const sub = decodeJwt(token).sub || "";
    userId = sub.includes("|") ? sub.split("|").pop() : sub;
  } catch (e) {
    return { available: false, note: `could not decode cursor token: ${e.message}` };
  }
  const cookie = `WorkosCursorSessionToken=${userId}%3A%3A${token}`;

  try {
    const summary = await cursorGet("https://cursor.com/api/usage-summary", cookie);

    // Token-level history (per-model, all-time-ish). This is the real volume —
    // the plan used/limit below only reflects the current billing cycle.
    let tokenTotals = null;
    let models = [];
    try {
      const end = Date.now();
      const start = end - 800 * 24 * 60 * 60 * 1000; // ~2.2 years back; split as needed
      const responses = await aggWindow(cookie, start, end, 0);
      const byModel = new Map();
      for (const j of responses) {
        for (const a of j.aggregations || []) {
          const k = a.modelIntent || "default";
          const p = byModel.get(k) || { model: k, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
          p.inputTokens += num(a.inputTokens);
          p.outputTokens += num(a.outputTokens);
          p.cacheCreationTokens += num(a.cacheWriteTokens);
          p.cacheReadTokens += num(a.cacheReadTokens);
          byModel.set(k, p);
        }
      }
      if (byModel.size) {
        tokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
        models = [...byModel.values()]
          .map((m) => {
            const totalTokens = m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens;
            tokenTotals.inputTokens += m.inputTokens;
            tokenTotals.outputTokens += m.outputTokens;
            tokenTotals.cacheCreationTokens += m.cacheCreationTokens;
            tokenTotals.cacheReadTokens += m.cacheReadTokens;
            tokenTotals.totalTokens += totalTokens;
            return { model: m.model, totalTokens };
          })
          .sort((a, b) => b.totalTokens - a.totalTokens);
      }
    } catch {
      /* aggregated endpoint optional */
    }

    // Period totals (2026 year-to-date + current calendar month). Each window is
    // split across Cursor's storage boundaries by aggWindow, then summed.
    const periodTotal = async (startMs) => {
      const resp = await aggWindow(cookie, startMs, Date.now(), 0);
      let total = 0;
      for (const j of resp)
        for (const a of j.aggregations || [])
          total += num(a.inputTokens) + num(a.outputTokens) + num(a.cacheWriteTokens) + num(a.cacheReadTokens);
      return total;
    };
    let totalTokens2026 = 0;
    let totalTokensMonth = 0;
    try {
      const monthStartIso = new Date().toISOString().slice(0, 7) + "-01T00:00:00Z";
      totalTokens2026 = await periodTotal(Date.parse("2026-01-01T00:00:00Z"));
      totalTokensMonth = await periodTotal(Date.parse(monthStartIso));
    } catch {
      /* period windows optional */
    }

    const ind = summary.individualUsage || {};
    const plan = ind.plan || {};
    const onDemand = ind.onDemand || {};

    return {
      available: true,
      source: "local-token:cursor-dashboard-api",
      totalTokens2026,
      totalTokensMonth,
      membership: summary.membershipType || null,
      billingCycle: {
        start: summary.billingCycleStart || null,
        end: summary.billingCycleEnd || null,
      },
      plan: { used: plan.used || 0, limit: plan.limit || 0, remaining: plan.remaining ?? null },
      onDemand: { used: onDemand.used || 0, limit: onDemand.limit || 0 },
      percentUsed: plan.totalPercentUsed ?? null,
      totalTokens: tokenTotals ? tokenTotals.totalTokens : 0,
      tokenTotals,
      models,
    };
  } catch (e) {
    return { available: false, note: `cursor api call failed: ${e.message}` };
  }
}
