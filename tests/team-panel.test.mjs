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

test("team view shows the active lead only and who is working", () => {
  const roles = p.teamRoles({ agent: {
    lead: { mode: "primary", model: "openai/gpt-6-astra" },
    "lead-kimi": { mode: "primary", model: "kimi-code-plan-global/k3.1-pro" },
    worker: { mode: "subagent", model: "deepseek/deepseek-flash" },
    title: { model: "deepseek/deepseek-flash" },
  } });
  const v = p.teamView({
    roles,
    root: { id: "r", agent: "lead", tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 9000, write: 0 } } },
    children: [{ id: "c", agent: "worker", title: "Fix median", tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
    statuses: { c: { type: "busy" } },
  });
  const team = p.renderTeam(v).map((l) => l.text);
  assert.equal(team.length, 2);
  assert.match(team[0], /^lead\s+Astra/);
  assert.match(team[1], /worker\s+DS Flash\s+● Fix median/);
  assert.match(p.renderSpend(v)[0], /lead\s+10K in/);
});
