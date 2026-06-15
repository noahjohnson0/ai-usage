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
    let perModel = {};
    try {
      perModel = await cursorGet(`https://cursor.com/api/usage?user=${userId}`, cookie);
    } catch {
      /* per-model endpoint optional */
    }

    const ind = summary.individualUsage || {};
    const plan = ind.plan || {};
    const onDemand = ind.onDemand || {};

    const models = Object.entries(perModel)
      .filter(([, v]) => v && typeof v === "object" && "numRequests" in v)
      .map(([name, v]) => ({
        model: name,
        requests: v.numRequests || 0,
        totalTokens: v.numTokens || 0,
      }))
      .filter((m) => m.requests || m.totalTokens);

    return {
      available: true,
      source: "local-token:cursor-dashboard-api",
      membership: summary.membershipType || null,
      billingCycle: {
        start: summary.billingCycleStart || null,
        end: summary.billingCycleEnd || null,
      },
      plan: { used: plan.used || 0, limit: plan.limit || 0, remaining: plan.remaining ?? null },
      onDemand: { used: onDemand.used || 0, limit: onDemand.limit || 0 },
      percentUsed: plan.totalPercentUsed ?? null,
      models,
    };
  } catch (e) {
    return { available: false, note: `cursor api call failed: ${e.message}` };
  }
}
