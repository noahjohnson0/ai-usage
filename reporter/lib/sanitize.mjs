// Shared public-safety scrub. Both the per-machine slice AND the merged output
// are committed to a PUBLIC repo, so both must be free of dollar figures unless
// the operator explicitly opts in with AI_USAGE_INCLUDE_COST=1 (e.g. a private
// mirror). Tokens, request counts and plan limits stay; money goes.

// Keys that always mean money. "limit" is deliberately NOT here: Cursor's
// plan.limit is a request count. OpenRouter's money fields are handled by the
// targeted openrouter reduction below.
export const COST_KEYS = new Set([
  "costUsd", "cost", "spendUsd", "creditsUsd", "remainingUsd",
  "usageDaily", "usageWeekly", "usageMonthly", "availableBalanceUsd",
]);

export function stripCosts(v) {
  if (Array.isArray(v)) return v.map(stripCosts);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (COST_KEYS.has(k)) continue;
      out[k] = stripCosts(val);
    }
    return out;
  }
  return v;
}

// OpenRouter usage is dollar-only; reduce it to presence + per-model availability.
function reduceOpenRouter(or) {
  if (!or?.available) return or;
  return { available: true, source: or.source, hasPerModel: or.hasPerModel || false };
}

// Accepts either a slice ({tools:{...}}) or merged doc ({tools:{...}}).
export function sanitizeForPublic(root) {
  if (process.env.AI_USAGE_INCLUDE_COST) return root;
  const out = stripCosts(root);
  if (out.tools?.openrouter) out.tools.openrouter = reduceOpenRouter(out.tools.openrouter);
  return out;
}
