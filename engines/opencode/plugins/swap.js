// Astra <-> Kimi swap. The lead agent chosen in the TUI (Tab: lead <-> lead-kimi)
// decides which vendor serves the other "smart" roles, so one key swaps everything.
// The session history stays; running subagents are not touched.
// Public hooks only: chat.params (current agent per call), tool.execute.before (task args).

export const SWAPPED = {
  reviewer: "reviewer-kimi",
  advisor: "advisor-kimi",
  takeover: "takeover-astra",
};
const SWAP_LEAD = "lead-kimi";

export function routeSubagent(leadAgent, requested) {
  const base = Object.entries(SWAPPED).find(([, alt]) => alt === requested)?.[0] || requested;
  if (!(base in SWAPPED)) return requested;
  return leadAgent === SWAP_LEAD ? SWAPPED[base] : base;
}

export default {
  id: "team-harness:swap",
  async server() {
    const current = new Map(); // sessionID -> agent of the latest model call
    return {
      "chat.params": async (input) => {
        if (input?.sessionID && typeof input.agent === "string") current.set(input.sessionID, input.agent);
      },
      "tool.execute.before": async (input, output) => {
        if (input?.tool !== "task" || typeof output?.args?.subagent_type !== "string") return;
        const lead = current.get(input.sessionID);
        if (lead !== "lead" && lead !== SWAP_LEAD) return;
        output.args.subagent_type = routeSubagent(lead, output.args.subagent_type);
      },
    };
  },
};
