// Kimi (Kimi Code subscription) exposes NO usage/quota API — only the kimi.com
// web dashboard, which is gated behind a browser login session. "Automatic"
// collection therefore means scraping the dashboard with the machine's logged-in
// session. That's fragile, so it is implemented as a best-effort optional step:
//
//  - If KIMI_COOKIE is provided (copied from a logged-in kimi.com session), we
//    call the dashboard's internal usage endpoint. Otherwise we report
//    unavailable and the tile shows "connect a session".
//
// A pay-as-you-go Moonshot API key (MOONSHOT_API_KEY) only exposes a money
// balance (not tokens), which we surface when present.

async function moonshotBalance(key) {
  const hosts = ["https://api.moonshot.ai", "https://api.moonshot.cn"];
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/v1/users/me/balance`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (r.ok) {
        const j = await r.json();
        const d = j.data || j;
        return { availableBalanceUsd: d.available_balance ?? null };
      }
    } catch {
      /* try next host */
    }
  }
  return null;
}

export async function collectKimi() {
  const result = { available: false, note: "no kimi session/key configured" };

  const apiKey = process.env.MOONSHOT_API_KEY;
  if (apiKey) {
    const bal = await moonshotBalance(apiKey);
    if (bal) {
      return { available: true, source: "cloud:moonshot-balance", ...bal, note: "balance only; no token usage API exists" };
    }
  }

  // Dashboard scrape path (subscription usage/quota). KIMI_COOKIE must be a full
  // Cookie header captured from a logged-in kimi.com session on this machine.
  const cookie = process.env.KIMI_COOKIE;
  if (cookie) {
    try {
      // Endpoint shape is best-effort and may need adjustment as kimi.com changes.
      const r = await fetch("https://www.kimi.com/api/user/usage", {
        headers: { Cookie: cookie, "User-Agent": "ai-usage-reporter" },
      });
      if (r.ok) {
        const j = await r.json();
        return { available: true, source: "scrape:kimi-dashboard", raw: j };
      }
      result.note = `kimi dashboard returned HTTP ${r.status}`;
    } catch (e) {
      result.note = `kimi scrape failed: ${e.message}`;
    }
  }
  return result;
}
