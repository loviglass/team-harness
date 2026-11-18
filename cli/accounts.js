// Several subscriptions per provider, chosen per project.
// Vault:  <base>/accounts/<provider>/<label>.json   (one OpenCode auth entry, mode 0600)
// Pins:   <base>/state/accounts.json  { defaults: {provider: label, mode}, projects: {root: {provider: label, mode}} }
// A launch composes OPENCODE_AUTH_CONTENT from the selected labels, so every OpenCode process
// has its own accounts while sessions, history and snapshots stay shared.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROVIDERS = {
  openai: { label: "GPT", aliases: ["openai", "gpt", "chatgpt", "astra"] },
  "kimi-code-plan-global": { label: "Kimi", aliases: ["kimi", "kimi-code", "kimi-code-plan-global"] },
  deepseek: { label: "DeepSeek", aliases: ["deepseek", "ds"] },
};
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function providerId(name) {
  const n = String(name || "").toLowerCase();
  const id = Object.keys(PROVIDERS).find((p) => PROVIDERS[p].aliases.includes(n));
  if (!id) throw new Error(`unknown provider "${name}" (use: gpt, kimi, deepseek)`);
  return id;
}

export function checkLabel(label) {
  if (!LABEL.test(String(label || ""))) throw new Error(`invalid account label "${label}" (letters, digits, . _ -; up to 32 chars)`);
  return label;
}

const accountFile = (base, provider, label) => join(base, "accounts", provider, `${label}.json`);
const pinsFile = (base) => join(base, "state", "accounts.json");

export function writePrivateJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(file), 0o700); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
}

export function listAccounts(base) {
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const dir = join(base, "accounts", p);
    out[p] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
  }
  return out;
}

export function readAccount(base, provider, label) {
  return JSON.parse(readFileSync(accountFile(base, provider, label), "utf8"));
}

export function saveAccount(base, provider, label, entry) {
  if (!entry || typeof entry !== "object" || !entry.type) throw new Error(`no ${provider} credentials to save`);
  writePrivateJson(accountFile(base, provider, checkLabel(label)), entry);
}

export function removeAccount(base, provider, label) {
  const f = accountFile(base, provider, label);
  if (!existsSync(f)) throw new Error(`no ${provider} account "${label}"`);
  rmSync(f);
  const pins = loadPins(base);
  if (pins.defaults[provider] === label) delete pins.defaults[provider];
  for (const p of Object.values(pins.projects)) if (p[provider] === label) delete p[provider];
  savePins(base, pins);
}

export function loadPins(base) {
  try {
    const p = JSON.parse(readFileSync(pinsFile(base), "utf8"));
    return { defaults: p.defaults || {}, projects: p.projects || {} };
  } catch {
    return { defaults: {}, projects: {} };
  }
}

export function savePins(base, pins) {
  writePrivateJson(pinsFile(base), pins);
}

export function projectKey(root) {
  return resolve(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Pin an account (or mode) for one project, or as the default.
export function pin(base, { provider, label, mode, project }) {
  const pins = loadPins(base);
  const target = project ? (pins.projects[projectKey(project)] ||= {}) : pins.defaults;
  if (provider) target[provider] = label;
  if (mode) target.mode = mode;
  savePins(base, pins);
}

// Which label serves each provider: project pin -> default -> "main" -> first available.
export function resolveAccounts(base, projectRoot) {
  const all = listAccounts(base);
  const pins = loadPins(base);
  const proj = projectRoot ? pins.projects[projectKey(projectRoot)] || {} : {};
  const out = {};
  for (const [p, labels] of Object.entries(all)) {
    if (!labels.length) continue;
    const want = [proj[p], pins.defaults[p], "main", labels[0]].find((l) => l && labels.includes(l));
    out[p] = { label: want, file: accountFile(base, p, want), pinned: proj[p] === want ? "project" : pins.defaults[p] === want ? "default" : "auto" };
  }
  return out;
}

export function resolveMode(base, projectRoot) {
  const pins = loadPins(base);
  const proj = projectRoot ? pins.projects[projectKey(projectRoot)] || {} : {};
  return proj.mode || pins.defaults.mode || "A";
}

export function composeAuth(selection) {
  const auth = {};
  for (const [p, s] of Object.entries(selection)) {
    try { auth[p] = JSON.parse(readFileSync(s.file, "utf8")); } catch {}
  }
  return auth;
}

// First run with accounts: existing single logins become "main".
export function migrateLegacy(base, legacyAuthFile) {
  const all = listAccounts(base);
  if (Object.values(all).some((l) => l.length) || !existsSync(legacyAuthFile)) return [];
  let legacy;
  try { legacy = JSON.parse(readFileSync(legacyAuthFile, "utf8")); } catch { return []; }
  const imported = [];
  for (const p of Object.keys(PROVIDERS)) {
    if (legacy[p]?.type) {
      saveAccount(base, p, "main", legacy[p]);
      imported.push(p);
    }
  }
  return imported;
}
