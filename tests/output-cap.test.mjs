import test from "node:test";
import assert from "node:assert/strict";
import { capOutput } from "../engines/opencode/plugins/output-cap.js";

const lines = (n, w = 50) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(w, "x")).join("\n");

test("small output is untouched", () => {
  assert.equal(capOutput("read", "scout", "short"), null);
  assert.equal(capOutput("task", "scout", lines(5000)), null);
});

test("scout read is capped with an offset/limit hint", () => {
  const out = capOutput("read", "scout", lines(2000));
  assert.ok(out.length < 12300);
  assert.match(out, /output truncated: .*offset\/limit/);
});

test("worker read budget is 12K chars / 300 lines", () => {
  assert.equal(capOutput("read", "worker", lines(150, 60)), null);
  assert.ok(capOutput("read", "worker", lines(1000, 60)).length < 12300);
});

test("bash keeps head and tail so test failures stay visible", () => {
  const text = "START\n" + "noise\n".repeat(20000) + "FAIL: TestX expected 2 got 3\n";
  const out = capOutput("bash", "worker", text);
  assert.match(out, /^START/);
  assert.match(out, /FAIL: TestX expected 2 got 3\n$/);
  assert.match(out, /chars omitted/);
  assert.ok(out.length < 9500);
});

test("lead-kimi uses the lead budget", () => {
  assert.ok(capOutput("read", "lead-kimi", lines(1000)).length < 8300);
});
