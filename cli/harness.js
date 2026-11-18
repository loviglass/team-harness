// team-harness CLI. Runs on the Bun runtime embedded in the pinned OpenCode binary
// (BUN_BE_BUN=1), so Windows, macOS and Linux need nothing besides Git.
// OpenCode itself is never modified: we download the official release and point it
// at the team config in this repo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, copyFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, providerId, checkLabel, listAccounts, saveAccount, removeAccount, resolveAccounts, resolveMode, composeAuth, migrateLegacy, pin, loadPins } from "./accounts.js";

export const ROOT = resolve(import.meta.dir ?? dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
// Checked on every start; the short throttle only stops the post-update re-exec from checking twice.
const UPDATE_EVERY_MS = 60 * 1000;

function die(msg) {
  console.error(`team-harness: ${msg}`);
  process.exit(1);
}

export function appBase(env = process.env, platform = process.platform, name = "team-harness") {
  if (name === "team-harness" && env.TEAM_HARNESS_HOME) return env.TEAM_HARNESS_HOME;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), name);
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", name);
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), name);
}

const BASE = appBase();
const OLD_HARNESS = appBase(process.env, process.platform, "opencode-team-harness");

export function readVersions(root = ROOT) {
  const out = {};
  for (const line of readFileSync(join(root, "versions.env"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_a-z]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new Error(`unsupported platform ${platform}/${arch}`);
  return { os, cpu, key: `${os}_${cpu}` };
}

export function engineAsset(os, cpu) {
  const baseline = cpu === "x64" ? "-baseline" : "";
  return os === "linux" ? `opencode-linux-${cpu}${baseline}.tar.gz` : `opencode-${os}-${cpu}${baseline}.zip`;
}

function enginePath(version) {
  return join(BASE, "engine", `opencode-${version}`, `opencode${EXE}`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

async function installEngine(versions) {
  const version = versions.OPENCODE_VERSION;
  const target = enginePath(version);
  if (!existsSync(target)) {
    const { os, cpu, key } = platformKey();
    const sha = versions[`OPENCODE_SHA256_${key}`];
    if (!sha) die(`no pinned checksum for ${key}`);
    const asset = engineAsset(os, cpu);
    const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`;
    console.log(`Downloading OpenCode ${version} (${asset})…`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) die(`download failed: HTTP ${res.status} ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha) die(`checksum mismatch for ${asset}: ${got}`);
    mkdirSync(join(BASE, "engine"), { recursive: true });
    const tmp = mkdtempSync(join(BASE, "engine", ".dl-"));
    try {
      const archive = join(tmp, asset);
      writeFileSync(archive, bytes);
      // Windows: System32 tar (bsdtar) reads zip; Git's GNU tar earlier on PATH does not.
      const tar = IS_WIN ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
      const x = run(tar, [asset.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", tmp]);
      if (x.status !== 0) die(`cannot extract ${asset}: ${x.stderr || x.error}`);
      const bin = join(tmp, `opencode${EXE}`);
      if (!existsSync(bin)) die("archive has no opencode binary");
      mkdirSync(dirname(target), { recursive: true });
      renameSync(bin, target);
      if (!IS_WIN) chmodSync(target, 0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const v = run(target, ["--version"], { env: engineEnv() }).stdout?.trim();
    if (v !== version) die(`installed engine reports ${v}, expected ${version}`);
    console.log(`OpenCode ${version} installed.`);
  }
  // The launcher shim uses this binary as its JS runtime.
  writeFileSync(join(BASE, "engine", "current"), target);
  // Keep at most the current and one previous engine.
  const keep = new Set([`opencode-${version}`]);
  const dirs = readdirSync(join(BASE, "engine")).filter((d) => d.startsWith("opencode-") && !keep.has(d));
  dirs.sort((a, b) => statSync(join(BASE, "engine", b)).mtimeMs - statSync(join(BASE, "engine", a)).mtimeMs);
  for (const d of dirs.slice(1)) rmSync(join(BASE, "engine", d), { recursive: true, force: true });
  return target;
}

function gitBash() {
  const where = run("where", ["git"]);
  for (const git of (where.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const root = dirname(dirname(git.trim()));
    for (const c of [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]) if (existsSync(c)) return c;
  }
  return null;
}

export function engineEnv(base = BASE, root = ROOT, src = process.env) {
  const env = { ...src };
  for (const k of Object.keys(env)) {
    if (k === "BUN_BE_BUN" || k === "OPENCODE_CONFIG" || k === "OPENCODE_CONFIG_CONTENT" || k === "OPENCODE_AUTH_CONTENT" || k === "TEAM_HARNESS_ACCOUNTS") delete env[k];
  }
  Object.assign(env, {
    // Isolated from a personal ~/.config/opencode (e.g. a global Slim install).
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CACHE_HOME: join(base, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "engines", "opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    // No Claude Code compatibility: it would also load a personal ~/.claude/CLAUDE.md.
    // Project CLAUDE.md files are passed explicitly instead (projectInstructions).
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    // Ctrl+B sends a running subagent to the background so the lead (and you) can continue;
    // also enables task background:true. Same as the old harness.
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
  });
  return env;
}

// Repos that keep their rules in CLAUDE.md (no AGENTS.md): pass those files as
// instructions, from the git root down to the working directory.
export function projectInstructions(dir, exists = existsSync) {
  const chain = [];
  let cur = resolve(dir);
  for (let i = 0; i < 64; i++) {
    chain.unshift(cur);
    if (exists(join(cur, ".git"))) break;
    const up = dirname(cur);
    if (up === cur) return [];
    cur = up;
  }
  if (!exists(join(chain[0], ".git"))) return [];
  return chain.filter((d) => !exists(join(d, "AGENTS.md")) && exists(join(d, "CLAUDE.md"))).map((d) => join(d, "CLAUDE.md"));
}

function workDir(args) {
  const i = args.indexOf("--dir");
  if (i >= 0 && args[i + 1]) return resolve(args[i + 1]);
  const first = args[0];
  if (first && !first.startsWith("-") && existsSync(first) && statSync(first).isDirectory()) return resolve(first);
  return process.cwd();
}

function prepare(engine, args = []) {
  for (const d of ["config", "data", "state", "cache"]) mkdirSync(join(BASE, d), { recursive: true });
  const env = engineEnv();
  const dir = workDir(args);
  const instructions = projectInstructions(dir);
  if (instructions.length) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ instructions });
  // Per-process accounts for this project (see cli/accounts.js and plugins/accounts.js).
  migrateLegacy(BASE, authFile());
  const selection = resolveAccounts(BASE, gitRoot(dir) || dir);
  if (Object.keys(selection).length) {
    env.OPENCODE_AUTH_CONTENT = JSON.stringify(composeAuth(selection));
    env.TEAM_HARNESS_ACCOUNTS = JSON.stringify(selection);
  }
  if (IS_WIN && !env.OPENCODE_GIT_BASH_PATH) {
    const bash = gitBash();
    if (!bash) die("Git for Windows (with Git Bash) is required: https://git-scm.com/download/win");
    env.OPENCODE_GIT_BASH_PATH = bash;
  }
  return { engine, env };
}

function engine(args, { capture = false } = {}) {
  const versions = readVersions();
  const bin = enginePath(versions.OPENCODE_VERSION);
  if (!existsSync(bin)) die("OpenCode is not installed; run: team-harness setup");
  const { env } = prepare(bin, args);
  if (capture) return run(bin, args, { env });
  process.on("SIGINT", () => {}); // the TUI owns Ctrl+C
  const r = spawnSync(bin, args, { stdio: "inherit", env });
  return r.status ?? 1;
}

// ---------- updates: managed clone follows the latest vX.Y.Z tag ----------

function isManagedClone() {
  return resolve(ROOT) === resolve(join(BASE, "repo"));
}

export function latestTag(tags) {
  const parse = (t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number);
  return tags.map((t) => t.trim()).filter(parse).sort((a, b) => {
    const x = parse(a), y = parse(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1);
}

async function update({ force = false, check = false, quiet = false } = {}) {
  if (!isManagedClone()) {
    if (!quiet) console.log("Development checkout: update it with git yourself.");
    return false;
  }
  const stamp = join(BASE, "state", "last-update-check");
  if (!force && existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < UPDATE_EVERY_MS) return false;
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, new Date().toISOString());
  const git = (...a) => run("git", ["-C", ROOT, ...a], { timeout: 8000 });
  const f = git("fetch", "--quiet", "--tags", "--force", "origin");
  if (f.status !== 0) {
    if (!quiet) console.log("Update check failed (offline?); keeping the current version.");
    return false;
  }
  const latest = latestTag(git("tag", "--list", "v*").stdout.split("\n"));
  const current = git("describe", "--tags", "--exact-match", "HEAD").stdout?.trim();
  if (!latest || latest === current) {
    if (!quiet) console.log(`Up to date (${current || "untagged"}).`);
    return false;
  }
  if (check) {
    console.log(`Update available: ${current || "untagged"} -> ${latest}`);
    return false;
  }
  const c = git("checkout", "--quiet", "--force", latest);
  if (c.status !== 0) die(`cannot switch to ${latest}: ${c.stderr}`);
  console.log(`team-harness updated: ${current || "untagged"} -> ${latest}`);
  await installEngine(readVersions());
  return true;
}

// ---------- auth ----------

function authFile() {
  return join(BASE, "data", "opencode", "auth.json");
}

function importOldAuth() {
  const src = join(OLD_HARNESS, "data", "opencode", "auth.json");
  if (!existsSync(src) || existsSync(authFile())) return false;
  mkdirSync(dirname(authFile()), { recursive: true });
  copyFileSync(src, authFile());
  if (!IS_WIN) chmodSync(authFile(), 0o600);
  console.log("Logins imported from the old opencode-team-harness.");
  return true;
}

const HINTS = {
  openai: "OpenAI: choose 'ChatGPT Pro/Plus' and log in with YOUR subscription in the browser (not an API key).",
  "kimi-code-plan-global": "Kimi: paste your personal Kimi Code key from https://www.kimi.ai/code/console (not a Moonshot API key).",
  deepseek: "DeepSeek: paste your personal key from https://platform.deepseek.com/api_keys (balance must be positive).",
};

// Log in through OpenCode into a scratch data dir, then file the credential under a label.
function addAccount(provider, label) {
  checkLabel(label);
  const bin = enginePath(readVersions().OPENCODE_VERSION);
  if (!existsSync(bin)) die("OpenCode is not installed; run: team-harness setup");
  mkdirSync(join(BASE, "state"), { recursive: true });
  const tmp = mkdtempSync(join(BASE, "state", ".login-"));
  try {
    const env = engineEnv();
    env.XDG_DATA_HOME = tmp;
    console.log(`\n${HINTS[provider]}\nAccount label: ${label}`);
    spawnSync(bin, ["auth", "login", "--provider", provider], { stdio: "inherit", env });
    let entry;
    try { entry = JSON.parse(readFileSync(join(tmp, "opencode", "auth.json"), "utf8"))[provider]; } catch {}
    if (!entry) die(`login to ${provider} was not completed`);
    saveAccount(BASE, provider, label, entry);
    console.log(`[ok] ${PROVIDERS[provider].label} account "${label}" saved`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function ensureLogins() {
  migrateLegacy(BASE, authFile());
  const all = listAccounts(BASE);
  for (const p of Object.keys(PROVIDERS)) {
    if (all[p].length) console.log(`[ok] ${PROVIDERS[p].label}: ${all[p].join(", ")}`);
    else addAccount(p, "main");
  }
}

function projectRoot() {
  return gitRoot(process.cwd()) || process.cwd();
}

function accountCommand(args) {
  const [sub, ...rest] = args;
  const project = rest.includes("--project");
  const pos = rest.filter((a) => !a.startsWith("--"));
  switch (sub) {
    case undefined:
    case "list": {
      migrateLegacy(BASE, authFile());
      const all = listAccounts(BASE);
      const active = resolveAccounts(BASE, projectRoot());
      console.log(`Accounts for ${projectRoot()} (mode ${resolveMode(BASE, projectRoot())}):`);
      for (const p of Object.keys(PROVIDERS)) {
        const labels = all[p].map((l) => (active[p]?.label === l ? `*${l}` : l)).join("  ") || "(none: team-harness account add " + PROVIDERS[p].aliases[0] + " main)";
        console.log(`  ${PROVIDERS[p].label.padEnd(9)} ${labels}${active[p] ? `   [${active[p].pinned}]` : ""}`);
      }
      console.log("\n* = used here. Pin: team-harness account use <gpt|kimi|deepseek> <label> [--project]");
      return;
    }
    case "add": {
      const p = providerId(pos[0]);
      return addAccount(p, pos[1] || "main");
    }
    case "use": {
      const p = providerId(pos[0]);
      const label = checkLabel(pos[1]);
      if (!listAccounts(BASE)[p].includes(label)) die(`no ${PROVIDERS[p].label} account "${label}"; add it: team-harness account add ${pos[0]} ${label}`);
      pin(BASE, { provider: p, label, project: project ? projectRoot() : null });
      console.log(`${PROVIDERS[p].label} -> "${label}" ${project ? `for ${projectRoot()}` : "by default"}. Restart team-harness (team-harness -c continues the last session).`);
      return;
    }
    case "remove": {
      const p = providerId(pos[0]);
      removeAccount(BASE, p, checkLabel(pos[1]));
      console.log(`${PROVIDERS[p].label} account "${pos[1]}" removed`);
      return;
    }
    default:
      die("usage: team-harness account [list | add <provider> [label] | use <provider> <label> [--project] | remove <provider> <label>]");
  }
}

function modeCommand(args) {
  const m = (args.find((a) => !a.startsWith("--")) || "").toUpperCase();
  if (!["A", "B"].includes(m)) {
    console.log(`Mode here: ${resolveMode(BASE, projectRoot())}  (A: Astra leads, B: Kimi leads). Set: team-harness mode A|B [--project]`);
    return;
  }
  pin(BASE, { mode: m, project: args.includes("--project") ? projectRoot() : null });
  console.log(`Start mode ${m} ${args.includes("--project") ? `for ${projectRoot()}` : "by default"}. Tab still swaps inside a session.`);
}

// ---------- doctor ----------

const ROLES = ["lead", "lead-kimi", "worker", "takeover", "takeover-astra", "scout", "analyst", "analyst-ds", "reviewer", "reviewer-kimi", "advisor", "advisor-kimi"];

function doctor() {
  const versions = readVersions();
  const v = engine(["--version"], { capture: true }).stdout?.trim();
  if (v !== versions.OPENCODE_VERSION) die(`engine ${v} != pinned ${versions.OPENCODE_VERSION}`);
  if (engine(["debug", "config"], { capture: true }).status !== 0) die("config does not resolve");
  for (const role of ROLES) {
    const r = engine(["debug", "agent", role], { capture: true });
    if (r.status !== 0) die(`agent ${role} is invalid`);
    if (role.startsWith("lead")) {
      const tools = JSON.parse(r.stdout).tools || {};
      const bad = ["edit", "write", "patch", "webfetch", "websearch"].filter((t) => tools[t]);
      if (bad.length) die(`${role} must not have tools: ${bad.join(", ")}`);
    }
  }
  migrateLegacy(BASE, authFile());
  const all = listAccounts(BASE);
  const missing = Object.keys(PROVIDERS).filter((p) => !all[p].length);
  const tag = run("git", ["-C", ROOT, "describe", "--tags", "--always"]).stdout?.trim();
  console.log(`ok: team-harness ${tag}, OpenCode ${v}, ${ROLES.length} roles valid, leads cannot edit`);
  if (missing.length) console.log(`warning: not logged in: ${missing.join(", ")} (team-harness account add <provider> main)`);
}

// ---------- init: detect acceptance checks for the gate tool ----------

function gitRoot(dir) {
  const r = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function nodeRunner(dir, exists) {
  if (exists(join(dir, "pnpm-lock.yaml"))) return "pnpm run";
  if (exists(join(dir, "yarn.lock"))) return "yarn";
  if (exists(join(dir, "bun.lockb")) || exists(join(dir, "bun.lock"))) return "bun run";
  return "npm run";
}

// Returns [{name, run}] for one directory; prefix is "cd sub && " for nested packages.
export function detectChecks(dir, { exists = existsSync, read = (f) => readFileSync(f, "utf8"), prefix = "", label = "" } = {}) {
  const checks = [];
  const add = (name, cmd) => checks.push({ name: label ? `${label}:${name}` : name, run: prefix + cmd });
  if (exists(join(dir, "go.mod"))) {
    add("build", "go build ./...");
    add("vet", "go vet ./...");
    add("test", "go test ./...");
  }
  if (exists(join(dir, "package.json"))) {
    let scripts = {};
    try { scripts = JSON.parse(read(join(dir, "package.json"))).scripts || {}; } catch {}
    const runner = nodeRunner(dir, exists);
    for (const name of ["typecheck", "type-check", "lint", "test"]) {
      if (scripts[name] && !/no test specified/.test(scripts[name])) add(name.replace("type-check", "typecheck"), `${runner} ${name}`);
    }
  }
  if (exists(join(dir, "Cargo.toml"))) {
    add("check", "cargo check --all-targets");
    add("test", "cargo test");
  }
  if (exists(join(dir, "pyproject.toml")) || exists(join(dir, "pytest.ini")) || exists(join(dir, "setup.py"))) {
    add("test", "python -m pytest -q");
  }
  if (!checks.length && exists(join(dir, "Makefile"))) {
    const mk = (() => { try { return read(join(dir, "Makefile")); } catch { return ""; } })();
    if (/^test:/m.test(mk)) add("test", "make test");
    if (/^lint:/m.test(mk)) add("lint", "make lint");
  }
  return checks;
}

function initGate(dir) {
  const root = gitRoot(dir) || dir;
  const file = join(root, ".harness.json");
  if (existsSync(file)) {
    console.log(`${file} already exists:\n${readFileSync(file, "utf8")}`);
    return;
  }
  let gate = detectChecks(root);
  // Monorepos: one level of nested packages (e.g. web/, frontend/).
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith(".") || sub.name === "node_modules" || sub.name === "vendor") continue;
    const d = join(root, sub.name);
    if (existsSync(join(d, "package.json")) || existsSync(join(d, "go.mod")) || existsSync(join(d, "Cargo.toml")) || existsSync(join(d, "pyproject.toml"))) {
      gate = gate.concat(detectChecks(d, { prefix: `cd ${sub.name} && `, label: sub.name }));
    }
  }
  if (!gate.length) die("could not detect checks; create .harness.json by hand (see README)");
  writeFileSync(file, JSON.stringify({ gate }, null, 2) + "\n");
  console.log(`Created ${file}:\n${JSON.stringify({ gate }, null, 2)}\n\nReview the commands, then commit the file so the whole team uses the same gate.`);
}

// ---------- main ----------

function usage() {
  console.log(`team-harness — OpenCode with the team roles

  team-harness [args]          open the TUI in the current folder (agent: lead)
  team-harness run ...         headless run (same as 'opencode run')
  team-harness setup           install engine, log in, check (run once)
  team-harness account [list]   subscriptions per provider; * = used in this project
  team-harness account add <gpt|kimi|deepseek> [label]
  team-harness account use <gpt|kimi|deepseek> <label> [--project]
  team-harness account remove <provider> <label>
  team-harness mode [A|B] [--project]   start mode: A = Astra leads, B = Kimi leads
  team-harness auth [provider]  re-login the account used here
  team-harness update [--check]
  team-harness eval <tasks> [--variant A,B,solo]   run tasks headless and compare variants
  team-harness init            detect build/test/lint checks into .harness.json (for the gate tool)
  team-harness doctor          check config and roles without model calls
  team-harness metrics [--since YYYY-MM-DD] [--json]
  team-harness version`);
}

// OpenCode subcommands passed through as-is; any other bare word is a typo, not a project path.
const ENGINE_COMMANDS = new Set(["run", "debug", "session", "export", "import", "models", "stats", "serve", "web", "attach", "agent", "mcp", "acp", "db", "providers", "pr", "github"]);

export function normalizeArgs(argv) {
  return argv.map((a) => String(a).replace(/^\s*"?|"?\s*$/g, "")).filter((a, i) => a !== "" || i > 0);
}

export async function main(rawArgv) {
  const argv = normalizeArgs(rawArgv);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "-h": case "--help": case "help":
      return usage();
    case "version":
      console.log(run("git", ["-C", ROOT, "describe", "--tags", "--always"]).stdout?.trim(), `(OpenCode ${readVersions().OPENCODE_VERSION})`);
      return;
    case "setup":
      await installEngine(readVersions());
      importOldAuth();
      if (rest.includes("--no-login")) migrateLegacy(BASE, authFile());
      else ensureLogins();
      doctor();
      console.log("\nReady. Open a NEW terminal in your project folder and run: team-harness");
      return;
    case "auth":
      if (rest[0] === "import") return void (importOldAuth() ? migrateLegacy(BASE, authFile()) : console.log("Nothing to import."));
      if (!rest[0]) return ensureLogins();
      return addAccount(providerId(rest[0]), rest[1] || resolveAccounts(BASE, projectRoot())[providerId(rest[0])]?.label || "main");
    case "account":
    case "accounts":
      try { return accountCommand(rest); } catch (e) { die(e.message); }
      return;
    case "mode":
      return modeCommand(rest);
    case "update":
      if (!(await update({ force: true, check: rest.includes("--check") }))) await installEngine(readVersions());
      return;
    case "doctor":
      return doctor();
    case "init":
      return initGate(process.cwd());
    case "eval": {
      const { evalMain } = await import("./eval.js");
      const bin = enginePath(readVersions().OPENCODE_VERSION);
      if (!existsSync(bin)) die("OpenCode is not installed; run: team-harness setup");
      const engineRun = (args, extraConfig, timeoutMs) => {
        const { env } = prepare(bin, args);
        const content = { ...(env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {}), ...extraConfig };
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
        const r = spawnSync(bin, args, { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
        return { status: r.status ?? 1, stdout: r.stdout || "", timedOut: r.error?.code === "ETIMEDOUT" };
      };
      try {
        return await evalMain(rest, { engineRun, dbPath: join(BASE, "data", "opencode", "opencode.db"), base: BASE, harnessRoot: ROOT });
      } catch (e) {
        die(`eval: ${e.message}`);
      }
    }
    case "metrics": {
      const { metricsMain } = await import("./metrics.js");
      return metricsMain(["--db", join(BASE, "data", "opencode", "opencode.db"), ...rest]);
    }
    default: {
      if (cmd && !cmd.startsWith("-") && !ENGINE_COMMANDS.has(cmd) && !(existsSync(cmd) && statSync(cmd).isDirectory())) {
        console.error(`team-harness: unknown command or folder: ${JSON.stringify(cmd)}\n`);
        usage();
        process.exit(2);
      }
      // Quiet background-style check; a failed check never blocks work.
      let updated = false;
      try {
        updated = await update({ quiet: true });
      } catch {}
      if (updated) {
        const r = spawnSync(process.execPath, [join(ROOT, "cli", "harness.js"), ...argv], { stdio: "inherit", env: process.env });
        process.exit(r.status ?? 1);
      }
      // Start in the project's pinned mode (B = Kimi leads) unless an agent was chosen explicitly.
      let args = argv;
      if (!argv.includes("--agent") && !ENGINE_COMMANDS.has(argv[0])) {
        const dir = workDir(argv);
        if (resolveMode(BASE, gitRoot(dir) || dir) === "B") args = ["--agent", "lead-kimi", ...argv];
      }
      process.exit(engine(args));
    }
  }
}

if (import.meta.main) await main(process.argv.slice(2));
