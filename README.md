# ai-usage

Aggregate my AI coding-tool usage (Claude Code, Cursor, OpenRouter, Kimi, Codex)
from every machine I use into one dataset, an animated GitHub profile card, and a
dashboard on [nanlives](https://nanlives.vercel.app).

## Why it works the way it does

Most of these are **subscription plans**, and vendors only publish usage APIs for
pay-as-you-go API keys. So per-tool, the data lives in different places:

| Tool | Source | How |
|------|--------|-----|
| Claude Code | local `~/.claude` transcripts | parsed by `ccusage` (tokens + API-equivalent cost). No cloud API for Max subs. |
| Cursor | local auth token -> `cursor.com` dashboard API | token read from `state.vscdb`; unofficial endpoints. |
| OpenRouter | cloud API | `/credits` + `/key`; per-model `/activity` needs a provisioning key. Runs anywhere, incl. CI. |
| Kimi | kimi.com dashboard (no API) | best-effort scrape with a logged-in session cookie. |
| Codex | ChatGPT usage meter (no API) | best-effort scrape with a logged-in session token. |

Because Claude/Cursor data only exists on the machine that used them, collection
is split into two stages:

```
 each machine            hub (this repo)              renders
 ┌──────────────┐  push  ┌──────────────────┐  CI   ┌────────────────────┐
 │ reporter     │ ─────► │ data/machines/   │ ────► │ public/card.svg     │ → GitHub profile
 │ collect.mjs  │ slice  │   <machine>.json │ merge │ public/usage.json   │ → nanlives /usage
 └──────────────┘        └──────────────────┘       └────────────────────┘
```

- **Claude** is per-machine, so the merge **sums** across machines.
- **Cursor / OpenRouter / Kimi / Codex** are account-level, so the merge takes the
  **most recent** slice (never sums — that would double count).

## Run the reporter on a machine

```sh
# one-off
npm run collect            # writes data/machines/<machine>.json

# collect + commit + push the slice (used by the scheduled task)
npm run collect:push
```

Set `AI_USAGE_MACHINE=desktop-4070s` (etc.) so each machine has a stable name.
Optional env: `OPENROUTER_API_KEY`, `OPENROUTER_PROVISIONING_KEY`, `MOONSHOT_API_KEY`,
`KIMI_COOKIE`, `CHATGPT_SESSION_TOKEN`.

## Render locally

```sh
npm run merge && npm run render   # -> public/usage.json + public/card.svg
```

CI (`.github/workflows/render.yml`) re-runs merge+render every 6h and on each slice
push, refreshing the card embedded in the profile README.
