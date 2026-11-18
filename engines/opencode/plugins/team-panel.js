// Sidebar panel for team-harness: who is on the team, who is working right now,
// what this session has spent per role, and provider quotas.
// Runs inside OpenCode's TUI (Bun + OpenTUI). Uses only the public TUI plugin API
// and the SDK client; no OpenCode internals, no npm dependencies.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 10000;
const QUOTA_MS = 60000;
const HIDDEN_AGENTS = new Set(["title", "summary", "compaction", "build", "plan", "general", "explore"]);

// ---------- pure helpers (exported for tests) ----------

export function clean(value, limit = 60) {
  if (typeof value !== "string") return "";
  const s = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(s);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : s;
}

export function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}

export function shortModel(id) {
  if (typeof id !== "string") return "?";
  const name = id.split("/").pop();
  const known = { "gpt-6-astra": "Astra", "k3.1-pro": "Kimi", "deepseek-flash": "DS Flash" };
  return known[name] || clean(name, 14);
}

// Roles = configured, enabled agents that are not internal helpers.
export function teamRoles(config) {
  const agents = config?.agent || {};
  return Object.entries(agents)
    .filter(([name, a]) => a && !a.disable && !HIDDEN_AGENTS.has(name))
    .map(([name, a]) => ({ name, model: a.model || config?.model, mode: a.mode || "all" }))
    .sort((a, b) => (a.mode === "primary" ? 0 : 1) - (b.mode === "primary" ? 0 : 1));
}

function sessionTokens(s) {
  const t = s?.tokens;
  if (!t) return { input: 0, output: 0 };
  return { input: (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0), output: (t.output || 0) + (t.reasoning || 0) };
}

// root: Session, children: Session[], statuses: {id: SessionStatus}
export function teamView({ roles, root, children = [], statuses = {}, leadContext = 0 }) {
  const byRole = new Map(roles.map((r) => [r.name, { ...r, working: [], done: 0, input: 0, output: 0, used: false }]));
  const ensure = (name, model) => {
    if (!byRole.has(name)) byRole.set(name, { name, model, mode: "subagent", working: [], done: 0, input: 0, output: 0, used: false });
    return byRole.get(name);
  };
  if (root) {
    const lead = ensure(root.agent || "lead", root.model ? `${root.model.providerID}/${root.model.id}` : undefined);
    const t = sessionTokens(root);
    lead.input += t.input; lead.output += t.output; lead.used = true; lead.isLead = true;
    if (statuses[root.id]?.type === "busy" || statuses[root.id]?.type === "retry") lead.working.push(statuses[root.id].type === "retry" ? "retrying" : "thinking");
  }
  for (const c of children) {
    const role = ensure(c.agent || "?", c.model ? `${c.model.providerID}/${c.model.id}` : undefined);
    const t = sessionTokens(c);
    role.input += t.input; role.output += t.output; role.used = true;
    const st = statuses[c.id]?.type;
    if (st === "busy" || st === "retry") role.working.push(clean(c.title, 34));
    else role.done += 1;
  }
  // Show only the lead actually driving this session; other primary agents are alternatives.
  const rows = [...byRole.values()].filter((r) => r.mode !== "primary" || r.isLead || !root);
  const total = rows.reduce((acc, r) => ({ input: acc.input + r.input, output: acc.output + r.output }), { input: 0, output: 0 });
  return { rows, total, leadContext };
}

export function renderTeam(view) {
  const lines = [];
  for (const r of view.rows) {
    const name = r.name.slice(0, 9).padEnd(10);
    const model = shortModel(r.model).slice(0, 8).padEnd(9);
    let state = "·";
    if (r.working.length) state = `● ${r.working.length > 1 ? r.working.length + "× " : ""}${r.working[0]}`;
    else if (r.done) state = `✓ ${r.done} done`;
    lines.push({ text: `${name}${model}${state}`, tone: r.working.length ? "active" : r.used ? "normal" : "muted" });
  }
  return lines;
}

export function renderSpend(view) {
  const lines = [];
  for (const r of view.rows.filter((x) => x.used)) {
    const name = r.name.slice(0, 9).padEnd(10);
    const share = view.total.input ? Math.round((100 * r.input) / view.total.input) : 0;
    lines.push(`${name}${fmtTokens(r.input)} in · ${fmtTokens(r.output)} out · ${share}%`);
  }
  if (view.leadContext) lines.push(`lead context now: ${fmtTokens(view.leadContext)}`);
  if (!lines.length) lines.push("nothing yet");
  return lines;
}

// ---------- quotas (same endpoints as the old Go collector) ----------
// Each provider yields windows {seconds, remaining, resetMs}; the panel shows them
// shortest first (5h -> Week -> Month), one line each, with the local reset time.

function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function windowName(seconds) {
  if (seconds >= 28 * 86400 && seconds <= 31 * 86400) return "Month";
  if (seconds === 7 * 86400) return "Week";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function resetText(ms) {
  if (!Number.isFinite(ms)) return "reset unknown";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function win(seconds, remaining, resetMs) {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(remaining)) return null;
  return { seconds, remaining: Math.max(0, Math.min(100, remaining)), resetMs };
}

function openaiWindows(rate) {
  return ["primary_window", "secondary_window"].map((k) => {
    const w = rate?.[k];
    const used = num(w?.used_percent);
    const reset = num(w?.reset_at);
    return used === undefined ? null : win(num(w?.limit_window_seconds), 100 - used, reset ? reset * 1000 : NaN);
  });
}

export function parseOpenAI(data) {
  const windows = openaiWindows(data?.rate_limit).filter(Boolean);
  // A model-specific allowance (e.g. Astra) is shown only if the provider reports one.
  for (const a of Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits.slice(0, 16) : []) {
    const name = shortModel(a?.limit_name || a?.metered_feature);
    for (const w of openaiWindows(a?.rate_limit).filter(Boolean)) windows.push({ ...w, prefix: name });
  }
  const blocked = data?.rate_limit?.limit_reached === true || data?.rate_limit?.allowed === false;
  return { windows, note: blocked ? "limit reached" : "" };
}

export function parseKimi(data) {
  const byLen = new Map();
  const put = (w) => { if (w && !byLen.has(w.seconds)) byLen.set(w.seconds, w); };
  const units = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400 };
  // Detailed counters first: they carry exact numbers.
  for (const item of Array.isArray(data?.limits) ? data.limits.slice(0, 16) : []) {
    const secs = num(item?.window?.duration) * (units[item?.window?.timeUnit] || NaN);
    const d = item?.detail || {};
    const limit = num(d.limit);
    const used = num(d.used);
    const remaining = num(d.remaining) ?? (limit !== undefined && used !== undefined ? limit - used : undefined);
    if (limit > 0 && remaining !== undefined) put(win(secs, (100 * remaining) / limit, Date.parse(d.resetTime)));
  }
  const u = data?.usage;
  if (num(u?.limit) > 0 && (num(u?.remaining) ?? num(u?.used)) !== undefined) {
    const remaining = num(u.remaining) ?? num(u.limit) - num(u.used);
    put(win(7 * 86400, (100 * remaining) / num(u.limit), Date.parse(u.resetTime)));
  }
  const summary = { limit_5h: 5 * 3600, limit_7d: 7 * 86400, limit_month_total: 30 * 86400 };
  for (const [key, secs] of Object.entries(summary)) {
    const ratio = num(data?.usages?.[key]?.used_ratio);
    if (ratio !== undefined && ratio >= 0 && ratio <= 1) put(win(secs, 100 * (1 - ratio), Date.parse(data.usages[key].reset_time)));
  }
  return { windows: [...byLen.values()], note: "" };
}

export function parseDeepSeek(data) {
  const balances = [];
  for (const b of Array.isArray(data?.balance_infos) ? data.balance_infos.slice(0, 4) : []) {
    if (typeof b?.total_balance === "string" && /^-?\d{1,20}(\.\d{1,8})?$/.test(b.total_balance) && /^[A-Z]{3}$/.test(b?.currency || "")) {
      balances.push(`${b.total_balance} ${b.currency}`);
    }
  }
  return { windows: [], balances, note: data?.is_available === false ? "unavailable" : "" };
}

const LOW_PERCENT = 20;

// -> [{text, tone}] for one provider: header line, then one line per window.
export function renderQuota(q) {
  const lines = [{ text: q.label + (q.stale ? "  (stale)" : ""), tone: q.stale ? "warning" : "heading" }];
  if (q.status !== "ok") return [...lines, { text: `  ${q.status}`, tone: q.status === "auth rejected" ? "warning" : "muted" }];
  const sorted = [...(q.windows || [])].sort((a, b) => (a.prefix ? 1 : 0) - (b.prefix ? 1 : 0) || a.seconds - b.seconds);
  for (const w of sorted) {
    const name = ((w.prefix ? w.prefix + " " : "") + windowName(w.seconds)).slice(0, 12).padEnd(12);
    const pct = `${Math.round(w.remaining)}%`.padStart(4);
    lines.push({ text: `  ${name}${pct}  ${resetText(w.resetMs)}`, tone: w.remaining <= LOW_PERCENT ? "warning" : "normal" });
  }
  for (const b of q.balances || []) lines.push({ text: `  ${"Balance".padEnd(12)}${b}`, tone: "normal" });
  if (q.note) lines.push({ text: `  ${q.note}`, tone: "warning" });
  if (lines.length === 1) lines.push({ text: "  no data", tone: "muted" });
  return lines;
}

const QUOTA_SOURCES = [
  { id: "openai", label: "GPT", url: "https://chatgpt.com/backend-api/wham/usage", parse: parseOpenAI,
    auth: (c) => c?.type === "oauth" && c.access ? { Authorization: `Bearer ${c.access}`, ...(c.accountId ? { "ChatGPT-Account-Id": c.accountId } : {}) } : null,
    expired: (c) => typeof c?.expires === "number" && c.expires <= Date.now() },
  { id: "kimi-code-plan-global", label: "Kimi", url: "https://api.kimi.ai/coding/v1/usages", parse: parseKimi,
    auth: (c) => c?.type === "api" && c.key ? { Authorization: `Bearer ${c.key}` } : null },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/user/balance", parse: parseDeepSeek,
    auth: (c) => c?.type === "api" && c.key ? { Authorization: `Bearer ${c.key}` } : null },
];

export async function fetchQuotas(previous) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  let auth = {};
  try {
    auth = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
  } catch {
    auth = {};
  }
  const keep = (i, status) => (previous?.[i]?.status === "ok" ? { ...previous[i], stale: true } : { label: QUOTA_SOURCES[i].label, status });
  return Promise.all(QUOTA_SOURCES.map(async (s, i) => {
    const cred = auth[s.id];
    const headers = s.auth(cred);
    if (!headers) return { label: s.label, status: "not connected" };
    if (s.expired?.(cred)) return keep(i, "login refresh pending");
    try {
      const res = await fetch(s.url, { headers: { ...headers, Accept: "application/json", "User-Agent": "team-harness/panel" }, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) return { label: s.label, status: "auth rejected" };
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      if (text.length > 262144) throw new Error("too large");
      return { label: s.label, status: "ok", ...s.parse(JSON.parse(text)) };
    } catch {
      return keep(i, "unavailable");
    }
  }));
}

// ---------- TUI ----------

export default {
  id: "team-harness:panel",
  async tui(api) {
    const { createElement, insert, setProp } = await import("@opentui/solid");
    const { createSignal, createEffect, createMemo } = await import("solid-js");

    const [rootId, setRootId] = createSignal(null);
    const [root, setRoot] = createSignal(null);
    const [children, setChildren] = createSignal([]);
    const [statuses, setStatuses] = createSignal({});
    const [quotas, setQuotas] = createSignal(QUOTA_SOURCES.map((s) => ({ label: s.label, status: "loading" })));
    let disposed = false;

    const data = (r) => (r && typeof r === "object" && "data" in r ? r.data : r);

    async function resolveRoot(id) {
      let s = api.state.session.get(id) || data(await api.client.session.get({ sessionID: id }).catch(() => null));
      for (let i = 0; s?.parentID && i < 4; i++) {
        s = api.state.session.get(s.parentID) || data(await api.client.session.get({ sessionID: s.parentID }).catch(() => null));
      }
      return s?.id || id;
    }

    async function pollSession() {
      const id = rootId();
      if (!id) return;
      const [r, kids, st] = await Promise.all([
        api.client.session.get({ sessionID: id }).then(data).catch(() => null),
        api.client.session.children({ sessionID: id }).then(data).catch(() => null),
        api.client.session.status().then(data).catch(() => null),
      ]);
      if (disposed) return;
      if (r) setRoot(r);
      if (Array.isArray(kids)) setChildren(kids);
      if (st && typeof st === "object") setStatuses(st);
    }

    async function pollQuotas() {
      const next = await fetchQuotas(quotas());
      if (!disposed) setQuotas(next);
    }

    let timer;
    const schedule = () => {
      if (disposed) return;
      const st = statuses();
      const active = Object.values(st).some((s) => s?.type === "busy" || s?.type === "retry");
      timer = setTimeout(async () => { await pollSession().catch(() => {}); schedule(); }, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    const quotaTimer = setInterval(() => { void pollQuotas(); }, QUOTA_MS);
    quotaTimer.unref?.();
    const unsubs = [
      api.event.on("session.status", () => { void pollSession(); }),
      api.event.on("session.created", () => { void pollSession(); }),
      api.event.on("session.error", (event) => {
        const cur = api.route.current;
        if (cur.name !== "session" || event.properties.sessionID !== cur.params?.sessionID) return;
        const name = clean(event.properties.error?.name || "error", 40);
        api.ui.toast({ variant: "error", title: "Work stopped", message: `${name}. Check Usage & limits, then send a message to continue.`, duration: 12000 });
      }),
    ];
    api.lifecycle.onDispose(() => { disposed = true; clearTimeout(timer); clearInterval(quotaTimer); unsubs.forEach((u) => u()); });

    const roles = createMemo(() => teamRoles(api.state.config));
    const leadContext = createMemo(() => {
      const id = rootId();
      if (!id) return 0;
      const msgs = api.state.session.messages(id) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const t = msgs[i]?.tokens;
        if (msgs[i]?.role === "assistant" && t && (t.input || t.cache?.read)) return (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      }
      return 0;
    });
    const view = createMemo(() => teamView({ roles: roles(), root: root(), children: children(), statuses: statuses(), leadContext: leadContext() }));

    function el(tag, props = {}) {
      const node = createElement(tag);
      for (const [k, v] of Object.entries(props)) setProp(node, k, v);
      return node;
    }
    function heading(text) {
      const t = el("text", { marginTop: 1 });
      const b = el("b");
      insert(b, text);
      insert(t, b);
      createEffect(() => setProp(t, "fg", api.theme.current.text));
      return t;
    }
    function line(content, toneFn) {
      const t = el("text", { width: "100%", minWidth: 0, wrapMode: "word" });
      insert(t, content);
      createEffect(() => {
        const th = api.theme.current;
        const tone = toneFn();
        setProp(t, "fg", { active: th.success, warning: th.warning, error: th.error, heading: th.text, normal: th.text }[tone] || th.textMuted);
      });
      return t;
    }

    api.slots.register({
      // After the native Context block (order 100).
      order: 105,
      slots: {
        sidebar_content: (_ctx, props) => {
          void resolveRoot(props.session_id).then((id) => {
            if (id !== rootId()) { setRootId(id); setRoot(null); setChildren([]); }
            clearTimeout(timer);
            void pollSession().finally(schedule);
          });
          const box = el("box", { width: "100%", minWidth: 0, flexDirection: "column", flexShrink: 0 });

          insert(box, heading("Team"));
          const team = createMemo(() => renderTeam(view()));
          for (let i = 0; i < 10; i++) {
            const t = line(() => team()[i]?.text || "", () => team()[i]?.tone);
            createEffect(() => setProp(t, "visible", i < team().length));
            insert(box, t);
          }

          insert(box, heading("Spend (this session)"));
          insert(box, line(() => renderSpend(view()).join("\n"), () => "muted"));

          insert(box, heading("Usage & limits"));
          insert(box, line(() => `${"".padEnd(14)}left  resets`, () => "muted"));
          const quotaLines = createMemo(() => quotas().flatMap(renderQuota));
          for (let i = 0; i < 16; i++) {
            const t = line(() => quotaLines()[i]?.text || "", () => quotaLines()[i]?.tone);
            createEffect(() => setProp(t, "visible", i < quotaLines().length));
            insert(box, t);
          }
          return box;
        },
      },
    });

    await pollQuotas();
  },
};
