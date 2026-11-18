import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGate, runCheck, report } from "../engines/opencode/plugins/gate.js";
import { detectChecks } from "../cli/harness.js";

test("gate config: missing file -> null, invalid entries dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  assert.equal(await loadGate(dir), null);
  writeFileSync(join(dir, ".harness.json"), JSON.stringify({ gate: [{ name: "t", run: "true" }, { name: "x" }, { run: "y" }] }));
  assert.deepEqual((await loadGate(dir)).map((c) => c.name), ["t"]);
});

test("gate runs real commands and reports the failing tail", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const ok = await runCheck({ name: "ok", run: "echo fine", timeoutSec: 10 }, dir);
  const bad = await runCheck({ name: "bad", run: "echo start; for i in $(seq 1 100); do echo line$i; done; echo 'FAIL: boom' >&2; exit 3", timeoutSec: 10 }, dir);
  assert.equal(ok.code, 0);
  assert.equal(bad.code, 3);
  const text = report([ok, bad], { bad: "/tmp/bad.log" });
  assert.match(text, /^GATE: FAIL \(1\/2 checks failed\)/);
  assert.match(text, /- ok: pass/);
  assert.match(text, /- bad: FAIL exit 3/);
  assert.match(text, /FAIL: boom/);
  assert.ok(!text.includes("line10\n"), "only the tail is reported");
  assert.match(text, /full log: \/tmp\/bad.log/);
});

test("gate timeout is reported", { skip: process.platform === "win32" }, async () => {
  const r = await runCheck({ name: "slow", run: "sleep 5", timeoutSec: 0.2 }, tmpdir());
  assert.match(report([r]), /slow: TIMEOUT/);
});

test("init detects Go, Node scripts with the right runner, nested packages", () => {
  const files = { "/r/go.mod": "", "/r/web/package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "echo \"Error: no test specified\" && exit 1", typecheck: "tsc" } }), "/r/web/pnpm-lock.yaml": "" };
  const exists = (p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, "") in files;
  const read = (p) => files[p.replace(/\\/g, "/").replace(/^[A-Z]:/, "")];
  assert.deepEqual(detectChecks("/r", { exists, read }).map((c) => c.run), ["go build ./...", "go vet ./...", "go test ./..."]);
  assert.deepEqual(detectChecks("/r/web", { exists, read, prefix: "cd web && ", label: "web" }), [
    { name: "web:typecheck", run: "cd web && pnpm run typecheck" },
    { name: "web:lint", run: "cd web && pnpm run lint" },
  ]);
});
