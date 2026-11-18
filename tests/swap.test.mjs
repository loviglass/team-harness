import test from "node:test";
import assert from "node:assert/strict";
import { routeSubagent } from "../engines/opencode/plugins/swap.js";

test("mode A keeps base roles, and maps a mirror back to its base", () => {
  assert.equal(routeSubagent("lead", "reviewer"), "reviewer");
  assert.equal(routeSubagent("lead", "reviewer-kimi"), "reviewer");
  assert.equal(routeSubagent("lead", "takeover"), "takeover");
});

test("mode B swaps smart roles to the other vendor", () => {
  assert.equal(routeSubagent("lead-kimi", "reviewer"), "reviewer-kimi");
  assert.equal(routeSubagent("lead-kimi", "advisor"), "advisor-kimi");
  assert.equal(routeSubagent("lead-kimi", "takeover"), "takeover-astra");
  assert.equal(routeSubagent("lead-kimi", "analyst"), "analyst-ds");
  assert.equal(routeSubagent("lead", "analyst"), "analyst");
});

test("cheap roles never change", () => {
  for (const lead of ["lead", "lead-kimi"]) {
    for (const r of ["worker", "scout"]) assert.equal(routeSubagent(lead, r), r);
  }
});
