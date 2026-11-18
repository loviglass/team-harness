import test from "node:test";
import assert from "node:assert/strict";
import { latestTag, engineAsset, appBase, platformKey, engineEnv, readVersions, projectInstructions } from "../cli/harness.js";

test("latest semver tag wins, junk ignored", () => {
  assert.equal(latestTag(["v0.9.0", "v0.10.0", "v0.2.11", "nightly", "v1.0.0-rc1", ""]), "v0.10.0");
  assert.equal(latestTag([]), undefined);
});

test("engine assets match the official OpenCode release names", () => {
  assert.equal(engineAsset("linux", "x64"), "opencode-linux-x64-baseline.tar.gz");
  assert.equal(engineAsset("linux", "arm64"), "opencode-linux-arm64.tar.gz");
  assert.equal(engineAsset("darwin", "arm64"), "opencode-darwin-arm64.zip");
  assert.equal(engineAsset("windows", "x64"), "opencode-windows-x64-baseline.zip");
});

test("every supported platform has a pinned checksum", () => {
  const v = readVersions();
  for (const [p, a] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["win32", "arm64"]]) {
    assert.match(v[`OPENCODE_SHA256_${platformKey(p, a).key}`], /^[0-9a-f]{64}$/);
  }
});

test("per-OS data locations", () => {
  assert.equal(appBase({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32").replace(/\\/g, "/"), "C:/Users/u/AppData/Local/team-harness");
  assert.match(appBase({}, "darwin"), /Library\/Application Support\/team-harness$/);
  assert.equal(appBase({ XDG_DATA_HOME: "/x" }, "linux"), "/x/team-harness");
  assert.equal(appBase({ TEAM_HARNESS_HOME: "/custom" }, "linux"), "/custom");
});

test("engine env is isolated and never leaks the Bun switch", () => {
  const env = engineEnv("/b", "/r", { BUN_BE_BUN: "1", OPENCODE_CONFIG: "/evil.json", PATH: "/usr/bin" });
  assert.equal(env.BUN_BE_BUN, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.XDG_CONFIG_HOME, "/b/config");
  assert.equal(env.PATH, "/usr/bin");
  assert.match(env.OPENCODE_CONFIG_DIR, /engines.opencode$/);
});

test("Claude Code compatibility is off (no personal ~/.claude/CLAUDE.md)", () => {
  assert.equal(engineEnv("/b", "/r", {}).OPENCODE_DISABLE_CLAUDE_CODE, "true");
});

test("project CLAUDE.md is passed only where a directory has no AGENTS.md", () => {
  const files = new Set(["/repo/.git", "/repo/CLAUDE.md", "/repo/svc/CLAUDE.md", "/repo/svc/AGENTS.md", "/repo/svc/api/CLAUDE.md"]);
  const exists = (p) => files.has(p.replace(/\\/g, "/").replace(/^[A-Z]:/, ""));
  assert.deepEqual(projectInstructions("/repo/svc/api", exists).map((p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, "")), ["/repo/CLAUDE.md", "/repo/svc/api/CLAUDE.md"]);
  assert.deepEqual(projectInstructions("/elsewhere", () => false), []);
});
