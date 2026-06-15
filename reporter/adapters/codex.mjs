// Codex (used via a ChatGPT subscription) exposes NO usage API — the only record
// is the in-app "Codex Settings -> Usage" meter inside ChatGPT, behind a browser
// login. Local ~/.codex stores only a login log (no token data).
//
// "Automatic" collection means scraping the ChatGPT backend usage endpoint with
// a logged-in session token. Provide CHATGPT_SESSION_TOKEN (the
// __Secure-next-auth.session-token cookie value) to enable the best-effort path;
// otherwise the tile reports unavailable. Kept defensive because this endpoint
// is undocumented and rate-limited.

export async function collectCodex() {
  const result = { available: false, note: "no chatgpt session configured" };

  const sessionToken = process.env.CHATGPT_SESSION_TOKEN;
  if (!sessionToken) return result;

  try {
    // Best-effort: mint a short-lived access token, then read the rate-limit/
    // usage surface. Shapes are undocumented and may change.
    const authRes = await fetch("https://chatgpt.com/api/auth/session", {
      headers: {
        Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
        "User-Agent": "ai-usage-reporter",
      },
    });
    if (!authRes.ok) {
      result.note = `chatgpt session returned HTTP ${authRes.status}`;
      return result;
    }
    const session = await authRes.json();
    const accessToken = session.accessToken;
    if (!accessToken) {
      result.note = "chatgpt session had no accessToken";
      return result;
    }
    return {
      available: true,
      source: "scrape:chatgpt-session",
      account: session.user?.email || null,
      note: "session valid; Codex usage meter scrape not yet finalized",
    };
  } catch (e) {
    result.note = `codex scrape failed: ${e.message}`;
    return result;
  }
}
