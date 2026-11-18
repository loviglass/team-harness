// Keeps per-process accounts coherent. team-harness starts OpenCode with
// OPENCODE_AUTH_CONTENT (this process's accounts) and TEAM_HARNESS_ACCOUNTS
// ({provider: {label, file}}). When OpenCode refreshes an OAuth token it writes the
// new token to the shared auth.json but keeps reading the env, so we:
//  - adopt a newer token for OUR account (same accountId) into process.env at once;
//  - persist it to the account's vault file, so the next launch and other processes get it;
//  - adopt a newer token another process saved to the vault for the same account.
import { watch } from "node:fs";
import { readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

const POLL_MS = 3000;

export function sameAccount(a, b) {
  if (!a || !b || a.type !== "oauth" || b.type !== "oauth") return false;
  if (a.accountId || b.accountId) return a.accountId === b.accountId;
  return false; // without an account id we cannot prove identity: never mix tokens
}

export function newer(candidate, current) {
  return sameAccount(candidate, current) && Number(candidate.expires || 0) > Number(current.expires || 0) && !!candidate.access;
}

// Returns {env, vault} updates for one pass; pure for tests.
export function reconcile(envAuth, fileAuth, vaultEntries) {
  const next = { ...envAuth };
  const toVault = {};
  let changed = false;
  for (const [p, cur] of Object.entries(envAuth)) {
    if (cur?.type !== "oauth") continue;
    const fromFile = fileAuth?.[p];
    const fromVault = vaultEntries?.[p];
    let best = next[p];
    if (newer(fromVault, best)) best = fromVault;
    if (newer(fromFile, best)) { best = fromFile; toVault[p] = fromFile; }
    if (best !== next[p]) { next[p] = best; changed = true; }
  }
  return { env: changed ? next : null, vault: toVault };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writeVault(file, entry) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, file);
}

export default {
  id: "team-harness:accounts",
  async server() {
    let selection;
    try { selection = JSON.parse(process.env.TEAM_HARNESS_ACCOUNTS || "{}"); } catch { selection = {}; }
    if (!process.env.OPENCODE_AUTH_CONTENT || !Object.keys(selection).length) return {};
    const authFile = join(process.env.XDG_DATA_HOME || "", "opencode", "auth.json");
    let busy = false;
    const pass = async () => {
      if (busy) return;
      busy = true;
      try {
        const envAuth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT || "{}");
        const vault = {};
        for (const [p, s] of Object.entries(selection)) if (envAuth[p]?.type === "oauth") vault[p] = await readJson(s.file);
        const { env, vault: save } = reconcile(envAuth, await readJson(authFile), vault);
        if (env) process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(env);
        for (const [p, entry] of Object.entries(save)) if (selection[p]?.file) await writeVault(selection[p].file, entry);
      } catch {} finally {
        busy = false;
      }
    };
    // React right after OpenCode writes a refreshed token; poll as a fallback.
    try { watch(join(process.env.XDG_DATA_HOME || "", "opencode"), (_e, name) => { if (!name || String(name).startsWith("auth.json")) void pass(); }); } catch {}
    const timer = setInterval(() => void pass(), POLL_MS);
    timer.unref?.();
    return {};
  },
};
