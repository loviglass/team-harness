// Token report for OpenCode sessions (read-only): how much context the lead (root
// session) consumed and on what — hands-on work, delegation, or talk. Works on any
// OpenCode 1.x database, so the old harness and team-harness compare directly.
import { Database } from "bun:sqlite";

const HANDS_ON = new Set(["bash", "read", "edit", "write", "grep", "glob", "list", "patch", "apply_patch", "multiedit"]);
const DELEGATION = new Set(["task", "background_task"]);
const AUX = new Set(["compaction", "title", "summary"]);

export function load(dbPath, sinceMs = 0) {
  const db = new Database(dbPath, { readonly: true });
  const sessions = new Map();
  for (const r of db.query("select id, parent_id, title, time_created from session").all()) {
    sessions.set(r.id, { id: r.id, parent: r.parent_id, title: r.title, created: r.time_created });
  }
  const messages = new Map();
  for (const r of db.query("select id, session_id, data from message").all()) messages.set(r.id, [r.session_id, JSON.parse(r.data)]);
  const steps = [];
  const current = new Map();
  for (const r of db.query("select message_id, data from part order by message_id, id").all()) {
    const [sid, msg] = messages.get(r.message_id) || [null, {}];
    if (msg.role !== "assistant") continue;
    const p = JSON.parse(r.data);
    if (p.type === "step-start") current.set(r.message_id, []);
    else if (p.type === "tool") (current.get(r.message_id) || current.set(r.message_id, []).get(r.message_id)).push(p.tool);
    else if (p.type === "step-finish") {
      const t = p.tokens || {};
      const c = t.cache || {};
      steps.push({ session: sid, agent: msg.agent, model: msg.modelID, input: t.input || 0, cacheRead: c.read || 0, cacheWrite: c.write || 0, output: (t.output || 0) + (t.reasoning || 0), tools: current.get(r.message_id) || [] });
      current.delete(r.message_id);
    }
  }
  db.close();
  const rootOf = (sid) => {
    for (let i = 0; sessions.get(sid)?.parent && i < 16; i++) sid = sessions.get(sid).parent;
    return sid;
  };
  return {
    sessions,
    steps: steps
      .filter((s) => sessions.has(s.session) && sessions.get(rootOf(s.session)).created >= sinceMs)
      .map((s) => ({ ...s, root: rootOf(s.session), isRoot: rootOf(s.session) === s.session, ctx: s.input + s.cacheRead + s.cacheWrite })),
  };
}

function kind(tools) {
  if (tools.some((t) => DELEGATION.has(t))) return "delegation";
  if (tools.some((t) => HANDS_ON.has(t))) return "hands_on";
  return tools.length ? "other_tool" : "text";
}

const inc = (obj, k, v = 1) => { obj[k] = (obj[k] || 0) + v; };

export function report({ sessions, steps }) {
  const roots = new Map();
  for (const s of steps) {
    if (!roots.has(s.root)) roots.set(s.root, { id: s.root, title: sessions.get(s.root).title, leadModels: {}, leadSteps: 0, leadCtx: 0, leadMax: 0, byKind: {}, leadTools: {}, children: new Set(), childCtx: {}, compactions: 0 });
    const r = roots.get(s.root);
    const key = `${s.agent}/${s.model}`;
    if (AUX.has(s.agent)) {
      if (s.agent === "compaction") r.compactions++;
      inc(r.childCtx, key, s.ctx);
    } else if (s.isRoot) {
      inc(r.leadModels, key);
      r.leadSteps++;
      r.leadCtx += s.ctx;
      r.leadMax = Math.max(r.leadMax, s.ctx);
      inc(r.byKind, kind(s.tools), s.ctx);
      for (const t of s.tools) inc(r.leadTools, t);
    } else {
      r.children.add(s.session);
      inc(r.childCtx, key, s.ctx);
    }
  }
  const byAgent = {};
  for (const s of steps) {
    const k = `${s.isRoot ? "root" : "child"}:${s.agent}/${s.model}`;
    byAgent[k] ||= { steps: 0, ctx: 0, input: 0, cacheRead: 0, output: 0 };
    const a = byAgent[k];
    a.steps++; a.ctx += s.ctx; a.input += s.input; a.cacheRead += s.cacheRead; a.output += s.output;
  }
  const rootsOut = [...roots.values()].filter((r) => r.leadSteps).map((r) => ({
    id: r.id, title: r.title, leadModels: r.leadModels, leadSteps: r.leadSteps, leadCtx: r.leadCtx,
    leadAvgCtx: Math.floor(r.leadCtx / r.leadSteps), leadMaxCtx: r.leadMax,
    leadCtxShare: Object.fromEntries(Object.entries(r.byKind).map(([k, v]) => [k, r.leadCtx ? Math.round((1000 * v) / r.leadCtx) / 1000 : 0])),
    leadTools: r.leadTools, delegations: (r.leadTools.task || 0) + (r.leadTools.background_task || 0),
    childSessions: r.children.size, childCtx: r.childCtx, compactions: r.compactions,
  })).sort((a, b) => b.leadCtx - a.leadCtx);
  const leadTotal = rootsOut.reduce((n, r) => n + r.leadCtx, 0);
  const hands = rootsOut.reduce((n, r) => n + r.leadCtx * (r.leadCtxShare.hands_on || 0), 0);
  return {
    summary: { rootSessions: rootsOut.length, leadCtxTotal: leadTotal, leadHandsOnShare: leadTotal ? Math.round((1000 * hands) / leadTotal) / 1000 : null, allCtxTotal: steps.reduce((n, s) => n + s.ctx, 0) },
    byAgentModel: Object.fromEntries(Object.entries(byAgent).sort((a, b) => b[1].ctx - a[1].ctx).map(([k, v]) => [k, { ...v, cacheHit: v.ctx ? Math.round((1000 * v.cacheRead) / v.ctx) / 1000 : null }])),
    roots: rootsOut,
  };
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}K`);

export function printText(rep) {
  const s = rep.summary;
  console.log(`Root sessions: ${s.rootSessions}   lead ctx: ${fmt(s.leadCtxTotal)}   lead hands-on share: ${s.leadHandsOnShare}   all ctx: ${fmt(s.allCtxTotal)}\n`);
  console.log(`${"agent/model".padEnd(48)} ${"steps".padStart(6)} ${"ctx".padStart(8)} ${"avg".padStart(6)} ${"cache".padStart(6)}`);
  for (const [k, v] of Object.entries(rep.byAgentModel)) {
    console.log(`${k.padEnd(48)} ${String(v.steps).padStart(6)} ${fmt(v.ctx).padStart(8)} ${fmt(v.ctx / Math.max(v.steps, 1)).padStart(6)} ${`${Math.round(100 * (v.cacheHit || 0))}%`.padStart(6)}`);
  }
  console.log();
  for (const r of rep.roots) {
    const share = Object.entries(r.leadCtxShare).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${Math.round(v * 100)}%`).join(" ");
    console.log(`• ${r.title.slice(0, 70)}`);
    console.log(`  lead ${Object.keys(r.leadModels).join(",")}: ${r.leadSteps} steps, ${fmt(r.leadCtx)} ctx (avg ${fmt(r.leadAvgCtx)}, max ${fmt(r.leadMaxCtx)}), ${share}`);
    console.log(`  delegations ${r.delegations}, children ${r.childSessions}: ${Object.entries(r.childCtx).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}${r.compactions ? `, compactions ${r.compactions}` : ""}`);
  }
}

export function metricsMain(args) {
  let db, since = 0, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") db = args[++i];
    else if (args[i] === "--since") since = Date.parse(`${args[++i]}T00:00:00Z`);
    else if (args[i] === "--json") json = true;
  }
  if (!db) throw new Error("--db is required");
  const rep = report(load(db, since || 0));
  if (json) console.log(JSON.stringify(rep, null, 1));
  else printText(rep);
}

if (import.meta.main) metricsMain(process.argv.slice(2));
