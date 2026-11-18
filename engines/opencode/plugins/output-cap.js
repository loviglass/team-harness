// Caps tool output that enters a model's context. Every step resends the whole
// history, so one 40K-char grep is paid for again on every later step.
// Uses only the public `tool.execute.after` hook.

// [chars, lines] for read/grep/glob/list, and [head chars, tail chars] for bash.
const LIMITS = {
  lead: { text: [8000, 200], bash: [2000, 4000] },
  scout: { text: [12000, 250], bash: [3000, 5000] },
  analyst: { text: [12000, 250], bash: [3000, 5000] },
  reviewer: { text: [12000, 250], bash: [3000, 5000] },
  default: { text: [24000, 400], bash: [4000, 12000] }, // worker, takeover: keep test failures visible
};
const TEXT_TOOLS = new Set(["read", "grep", "glob", "list"]);

function limitsFor(agent) {
  const base = { "lead-kimi": "lead", "reviewer-kimi": "reviewer", "advisor-kimi": "advisor", "takeover-astra": "takeover" }[agent] || agent;
  return LIMITS[base] || LIMITS.default;
}

export function capText(text, maxChars, maxLines, tool) {
  const lines = text.split("\n");
  if (text.length <= maxChars && lines.length <= maxLines) return null;
  const hint = tool === "read"
    ? "Read a narrower range with offset/limit."
    : "Narrow the pattern or path (include/glob filter).";
  const notice = `[output truncated: ${text.length} chars / ${lines.length} lines; showing the first part. ${hint}]`;
  let body = lines.slice(0, maxLines).join("\n");
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return `${body}\n${notice}`;
}

// Command output: errors and test summaries are usually at the end, so keep head and tail.
export function capBash(text, head, tail) {
  if (text.length <= head + tail + 200) return null;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted; redirect long output to a file and grep it …]\n${text.slice(-tail)}`;
}

export function capOutput(tool, agent, text) {
  if (typeof text !== "string") return null;
  const l = limitsFor(agent);
  if (TEXT_TOOLS.has(tool)) return capText(text, l.text[0], l.text[1], tool);
  if (tool === "bash") return capBash(text, l.bash[0], l.bash[1]);
  return null;
}

export default {
  id: "team-harness:output-cap",
  async server(ctx) {
    const agents = new Map();
    const agentOf = async (sessionID) => {
      if (agents.has(sessionID)) return agents.get(sessionID);
      let agent;
      try {
        const r = await ctx?.client?.session?.get({ path: { id: sessionID }, query: { directory: ctx?.directory } });
        agent = (r?.data ?? r)?.agent;
      } catch {}
      if (typeof agent === "string" && agent) agents.set(sessionID, agent);
      return agent;
    };
    return {
      "tool.execute.after": async (input, output) => {
        if (!TEXT_TOOLS.has(input?.tool) && input?.tool !== "bash") return;
        const capped = capOutput(input.tool, await agentOf(input.sessionID), output?.output);
        if (capped !== null) {
          output.output = capped;
          output.metadata = { ...output.metadata, outputCapped: true };
        }
      },
    };
  },
};
