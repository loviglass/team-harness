// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as p from "../engines/opencode/plugins/team-panel.js";

test("quota windows are ordered shortest first with reset times", () => {
  const q = { label: "Kimi", status: "ok", ...p.parseKimi({ usages: {
    limit_month_total: { used_ratio: 0.28, reset_time: "2026-12-15T00:00:00Z" },
    limit_5h: { used_ratio: 0.5, reset_time: "2026-11-18T12:00:00Z" },
  } }) };
  const lines = p.renderQuota(q).map((l) => l.text.trim());
  assert.equal(lines[0], "Kimi");
  assert.match(lines[1], /^5h\s+50%\s+\d\d \w{3} \d\d:\d\d$/);
  assert.match(lines[2], /^Month\s+72%/);
});

test("openai shared windows parse and low quota is flagged", () => {
  const q = { label: "GPT", status: "ok", ...p.parseOpenAI({ rate_limit: {
    secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 1795000000 },
    primary_window: { used_percent: 90, limit_window_seconds: 18000, reset_at: 1794000000 },
  } }) };
  const lines = p.renderQuota(q);
  assert.match(lines[1].text, /5h\s+10%/);
  assert.equal(lines[1].tone, "warning");
  assert.match(lines[2].text, /Week\s+70%/);
});

test("deepseek balance and missing login", () => {
  assert.deepEqual(p.parseDeepSeek({ balance_infos: [{ currency: "USD", total_balance: "5.80" }] }).balances, ["5.80 USD"]);
  assert.equal(p.renderQuota({ label: "GPT", status: "not connected" })[1].text.trim(), "not connected");
});

const CONFIG = { agent: {
  lead: { mode: "primary", model: "openai/gpt-6-astra" },
  "lead-kimi": { mode: "primary", model: "kimi-code-plan-global/k3.1-pro" },
  worker: { mode: "subagent", model: "deepseek/deepseek-flash" },
  reviewer: { mode: "subagent", model: "openai/gpt-6-astra" },
  "reviewer-kimi": { mode: "subagent", model: "kimi-code-plan-global/k3.1-pro" },
  takeover: { mode: "subagent", model: "kimi-code-plan-global/k3.1-pro" },
  "takeover-astra": { mode: "subagent", model: "openai/gpt-6-astra" },
  title: { model: "deepseek/deepseek-flash" },
} };

test("team view: one lead row, mirrors folded into base roles, who is working", () => {
  const v = p.teamView({
    roles: p.teamRoles(CONFIG, "A"),
    root: { id: "r", agent: "lead", tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 9000, write: 0 } } },
    children: [{ id: "c", agent: "worker", title: "Fix median", tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
    statuses: { c: { type: "busy" } },
  });
  const team = p.renderTeam(v).map((l) => l.text);
  assert.equal(team.length, 4);
  assert.match(team[0], /^lead\s+Astra/);
  assert.match(team[1], /worker\s+DS Flash\s+● working/);
  assert.ok(!team.some((t) => /kimi|astra/.test(t.split(/\s+/)[0])));
  assert.match(p.renderSpend(v)[0], /lead\s+10K in/);
});

test("mode B shows swapped models and counts mirror sessions under the base role", () => {
  assert.equal(p.swapMode("lead-kimi"), "B");
  assert.equal(p.swapMode("lead"), "A");
  const v = p.teamView({
    roles: p.teamRoles(CONFIG, "B"), mode: "B",
    root: { id: "r", agent: "lead" },
    children: [{ id: "c", agent: "reviewer-kimi", title: "Review" }],
  });
  const team = p.renderTeam(v).map((l) => l.text);
  assert.match(team.find((t) => t.startsWith("lead")), /Kimi/);
  assert.match(team.find((t) => t.startsWith("reviewer")), /Kimi\s+✓ 1 done/);
  assert.match(team.find((t) => t.startsWith("takeover")), /Astra/);
  assert.match(p.renderMode("B").text, /swapped/);
});

test("burn rate and manual swap hint", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const hour = 3600 * 1000;
  // 5h window, 2.5h elapsed, 75% used -> 1.5x
  const fast = { seconds: 5 * 3600, remaining: 25, resetMs: now + 2.5 * hour };
  assert.equal(p.burnRate(fast, now).toFixed(1), "1.5");
  // too early in a window -> no judgement
  assert.equal(p.burnRate({ seconds: 5 * 3600, remaining: 90, resetMs: now + 4.9 * hour }, now), null);
  const slowKimi = { seconds: 5 * 3600, remaining: 90, resetMs: now + 2.5 * hour };
  const quotas = [{ label: "GPT", status: "ok", windows: [fast] }, { label: "Kimi", status: "ok", windows: [slowKimi] }];
  assert.match(p.swapHint(quotas, "A", now).text, /GPT burning 1\.5× \(5h\) — consider Tab/);
  assert.equal(p.swapHint(quotas, "B", now), null);
  // both burning similarly -> swapping would not help
  const both = [{ label: "GPT", status: "ok", windows: [fast] }, { label: "Kimi", status: "ok", windows: [{ ...fast, remaining: 30 }] }];
  assert.equal(p.swapHint(both, "A", now), null);
});

test("task list: order, states, gate verdicts, title cleanup, overflow", () => {
  const children = [
    { id: "a", agent: "scout", title: "Map architecture (@scout subagent)", time: { created: 1 } },
    { id: "b", agent: "worker", title: "Fix median (@worker subagent)", time: { created: 3 } },
    { id: "c", agent: "reviewer-kimi", title: "Review diff (@reviewer-kimi subagent)", time: { created: 5 } },
    { id: "d", agent: "worker", title: "Retry", time: { created: 6 } },
  ];
  const items = p.taskItems({ children, statuses: { c: { type: "busy" } }, outcomes: { b: "error", d: "stopped" }, gates: [{ at: 4, pass: false }] });
  const lines = p.renderTasks(items).map((l) => l.text);
  assert.deepEqual(lines, [
    "✓ scout    Map architecture",
    "✗ worker   Fix median",
    "✗ gate     FAIL",
    "● reviewer Review diff",
    "■ worker   Retry",
  ]);
  assert.equal(p.renderTasks(items, 2)[0].text, "… 3 earlier");
  assert.equal(p.renderTasks([])[0].text, "no delegated tasks yet");
});

test("outcome and gate parsing", () => {
  assert.equal(p.outcomeOf([{ info: { role: "assistant" } }]), "done");
  assert.equal(p.outcomeOf([{ info: { role: "assistant", error: { name: "ProviderAuthError" } } }]), "error");
  assert.equal(p.outcomeOf([{ info: { role: "assistant", error: { name: "MessageAbortedError" } } }]), "stopped");
  const parts = [
    { type: "tool", tool: "gate", state: { status: "completed", output: "GATE: PASS (1 checks)", time: { end: 9 } } },
    { type: "tool", tool: "read", state: { status: "completed", output: "x" } },
    { type: "tool", tool: "gate", state: { status: "running" } },
  ];
  assert.deepEqual(p.gateVerdicts(parts), [{ at: 9, pass: true }]);
});
