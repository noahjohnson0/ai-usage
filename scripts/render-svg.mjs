#!/usr/bin/env node
// Render public/usage.json into an animated SVG stat card for the GitHub profile
// README. Pure string templating (no deps). CSS @keyframes animate when GitHub
// serves the file as image/svg+xml via its camo proxy: bars grow, rows fade up,
// the header gradient shimmers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "public", "usage.json"), "utf8"));

const W = 495;
const H = 220;

function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const t = data.tools;
// Build the tool rows with a comparable magnitude for bar scaling.
const rows = [];
if (t.claude?.available) rows.push({ label: "Claude Code", display: human(t.claude.totals.totalTokens) + " tok", color: "#d97757", weight: t.claude.totals.totalTokens });
if (t.cursor?.available) rows.push({ label: "Cursor", display: (t.cursor.plan?.used || 0) + " / " + (t.cursor.plan?.limit || 0) + " req", color: "#3ec6b8", weight: Math.max(0.04, (t.cursor.percentUsed || 0) / 100) * (t.claude?.totals?.totalTokens || 1e9) });
if (t.openrouter?.available) rows.push({ label: "OpenRouter", display: "active", color: "#6e7bf2", weight: 0.06 * (t.claude?.totals?.totalTokens || 1e9) });
if (t.kimi?.available) rows.push({ label: "Kimi", display: "active", color: "#b07bf2", weight: 0.04 * (t.claude?.totals?.totalTokens || 1e9) });
if (t.codex?.available) rows.push({ label: "Codex", display: "active", color: "#9aa0a6", weight: 0.04 * (t.claude?.totals?.totalTokens || 1e9) });

const maxW = Math.max(...rows.map((r) => r.weight), 1);
const barX = 150;
const barMax = W - barX - 90;
const updated = (data.generatedAt || "").slice(0, 10);

const rowSvg = rows
  .map((r, i) => {
    const y = 92 + i * 26;
    const w = Math.max(6, (r.weight / maxW) * barMax);
    const delay = 0.15 + i * 0.12;
    return `
    <g class="row" style="animation-delay:${delay}s">
      <text x="20" y="${y + 4}" class="lbl">${esc(r.label)}</text>
      <rect x="${barX}" y="${y - 9}" width="${barMax}" height="13" rx="6.5" fill="#ffffff10"/>
      <rect x="${barX}" y="${y - 9}" width="${w}" height="13" rx="6.5" fill="${r.color}" class="bar" style="--bw:${w}px;animation-delay:${delay}s"/>
      <text x="${W - 18}" y="${y + 4}" class="val" text-anchor="end">${esc(r.display)}</text>
    </g>`;
  })
  .join("");

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI usage stats">
  <defs>
    <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d97757"/>
      <stop offset="0.5" stop-color="#b07bf2"/>
      <stop offset="1" stop-color="#6e7bf2"/>
    </linearGradient>
    <style>
      .card{font-family:'Segoe UI',Ubuntu,Helvetica,Arial,sans-serif}
      .title{fill:url(#hdr);font-size:19px;font-weight:700;background-size:200% auto;animation:shimmer 6s linear infinite}
      .sub{fill:#8b949e;font-size:10.5px}
      .big{fill:#e6edf3;font-size:26px;font-weight:800}
      .biglbl{fill:#8b949e;font-size:9.5px;letter-spacing:.5px}
      .lbl{fill:#c9d1d9;font-size:12px}
      .val{fill:#e6edf3;font-size:12px;font-weight:600}
      .row{animation:fadeUp .6s ease backwards}
      .bar{transform-origin:left;animation:grow 1s cubic-bezier(.2,.8,.2,1) backwards}
      @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes grow{from{width:0}to{width:var(--bw)}}
      @keyframes shimmer{to{background-position:200% center}}
      .pop{animation:fadeUp .7s ease backwards}
    </style>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#0d1117" stroke="#30363d"/>
  <g class="card">
    <text x="20" y="32" class="title">AI Coding Usage</text>
    <text x="${W - 18}" y="20" class="sub" text-anchor="end">updated ${updated}</text>
    <text x="${W - 18}" y="33" class="sub" text-anchor="end">${data.headline.machineCount} machine${data.headline.machineCount === 1 ? "" : "s"}</text>

    <g class="pop" style="animation-delay:.05s">
      <text x="20" y="64" class="big">${human(data.headline.totalTokens)}</text>
      <text x="20" y="76" class="biglbl">TOTAL TOKENS</text>
    </g>
    <g class="pop" style="animation-delay:.12s">
      <text x="190" y="64" class="big">${human(data.headline.outputTokens)}</text>
      <text x="190" y="76" class="biglbl">GENERATED</text>
    </g>
    <g class="pop" style="animation-delay:.19s">
      <text x="350" y="64" class="big">${data.headline.modelsUsed}</text>
      <text x="350" y="76" class="biglbl">MODELS</text>
    </g>
    ${rowSvg}
  </g>
</svg>`;

fs.writeFileSync(path.join(repoRoot, "public", "card.svg"), svg);
console.log("wrote public/card.svg");
