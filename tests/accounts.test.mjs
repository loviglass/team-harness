import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as a from "../cli/accounts.js";
import { reconcile, sameAccount } from "../engines/opencode/plugins/accounts.js";

const oauth = (accountId, expires, access = `tok-${expires}`) => ({ type: "oauth", accountId, expires, access, refresh: `r-${expires}` });

test("provider aliases and label validation", () => {
  assert.equal(a.providerId("gpt"), "openai");
  assert.equal(a.providerId("Kimi"), "kimi-code-plan-global");
  assert.equal(a.providerId("ds"), "deepseek");
  assert.throws(() => a.providerId("claude"));
  assert.throws(() => a.checkLabel("../x"));
  assert.equal(a.checkLabel("work-2"), "work-2");
});

test("legacy logins migrate to 'main' with private files", () => {
  const base = mkdtempSync(join(tmpdir(), "acc-"));
  const legacy = join(base, "auth.json");
  writeFileSync(legacy, JSON.stringify({ openai: oauth("A", 1), deepseek: { type: "api", key: "k" }, other: { type: "api", key: "x" } }));
  assert.deepEqual(a.migrateLegacy(base, legacy), ["openai", "deepseek"]);
  assert.deepEqual(a.listAccounts(base).openai, ["main"]);
  if (process.platform !== "win32") assert.equal(statSync(join(base, "accounts", "openai", "main.json")).mode & 0o777, 0o600);
  assert.deepEqual(a.migrateLegacy(base, legacy), [], "runs only once");
});

test("resolution: project pin > default > main > first; mode pins", () => {
  const base = mkdtempSync(join(tmpdir(), "acc-"));
  a.saveAccount(base, "openai", "main", oauth("A", 1));
  a.saveAccount(base, "openai", "work", oauth("B", 1));
  a.saveAccount(base, "deepseek", "zeta", { type: "api", key: "z" });
  assert.equal(a.resolveAccounts(base, "/p1").openai.label, "main");
  assert.equal(a.resolveAccounts(base, "/p1").deepseek.label, "zeta");
  a.pin(base, { provider: "openai", label: "work" });
  assert.equal(a.resolveAccounts(base, "/p1").openai.label, "work");
  a.pin(base, { provider: "openai", label: "main", project: "/p2" });
  assert.equal(a.resolveAccounts(base, "/p2").openai.label, "main");
  assert.equal(a.resolveAccounts(base, "/p2").openai.pinned, "project");
  assert.equal(a.resolveMode(base, "/p2"), "A");
  a.pin(base, { mode: "B", project: "/p2" });
  assert.equal(a.resolveMode(base, "/p2"), "B");
  assert.equal(a.resolveMode(base, "/p1"), "A");
  const auth = a.composeAuth(a.resolveAccounts(base, "/p2"));
  assert.equal(auth.openai.accountId, "A");
  a.removeAccount(base, "openai", "main");
  assert.equal(a.resolveAccounts(base, "/p2").openai.label, "work", "falls back after removal");
});

test("token sync adopts only newer tokens of the SAME account", () => {
  assert.equal(sameAccount(oauth("A", 1), oauth("A", 2)), true);
  assert.equal(sameAccount(oauth("A", 1), oauth("B", 2)), false);
  assert.equal(sameAccount(oauth(undefined, 1), oauth(undefined, 2)), false);
  const env = { openai: oauth("A", 100), deepseek: { type: "api", key: "k" } };
  // another process (account B) refreshed into the shared file: ignore
  assert.equal(reconcile(env, { openai: oauth("B", 999) }, {}).env, null);
  // our refresh landed in the shared file: adopt and persist
  const r1 = reconcile(env, { openai: oauth("A", 200) }, { openai: oauth("A", 100) });
  assert.equal(r1.env.openai.expires, 200);
  assert.equal(r1.vault.openai.expires, 200);
  // another process with the same account saved a newer token to the vault: adopt, no re-save
  const r2 = reconcile(env, {}, { openai: oauth("A", 300) });
  assert.equal(r2.env.openai.expires, 300);
  assert.deepEqual(r2.vault, {});
  // older tokens never replace newer ones
  assert.equal(reconcile(env, { openai: oauth("A", 50) }, { openai: oauth("A", 60) }).env, null);
});
