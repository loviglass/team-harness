// team-harness CLI. Runs on the Bun runtime embedded in the pinned OpenCode binary
// (BUN_BE_BUN=1), so Windows, macOS and Linux need nothing besides Git.
// OpenCode itself is never modified: we download the official release and point it
// at the team config in this repo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, copyFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir ?? dirname(new URL(import.meta.url).pathname), "..");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const PROVIDERS = [
  { id: "openai", hint: "OpenAI: choose 'ChatGPT Pro/Plus' and log in with YOUR subscription in the browser (not an API key)." },
  { id: "kimi-code-plan-global", hint: "Kimi: paste your personal Kimi Code key from https://www.kimi.ai/code/console (not a Moonshot API key)." },
  { id: "deepseek", hint: "DeepSeek: paste your personal key from https://platform.deepseek.com/api_keys (balance must be positive)." },
];
const UPDATE_EVERY_MS = 6 * 3600 * 1000;

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
    const v = run(target, ["--version"]).stdout?.trim();
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
    if (k === "BUN_BE_BUN" || k === "OPENCODE_CONFIG" || k === "OPENCODE_CONFIG_CONTENT") delete env[k];
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
  const instructions = projectInstructions(workDir(args));
  if (instructions.length) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ instructions });
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
  const git = (...a) => run("git", ["-C", ROOT, ...a], { timeout: 15000 });
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

function authStatus() {
  try {
    return JSON.parse(readFileSync(authFile(), "utf8"));
  } catch {
    return {};
  }
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

function login(only) {
  const auth = authStatus();
  for (const p of PROVIDERS) {
    if (only && p.id !== only) continue;
    if (auth[p.id] && !only) {
      console.log(`[ok] ${p.id} is connected`);
      continue;
    }
    console.log(`\n${p.hint}`);
    const status = engine(["auth", "login", "--provider", p.id]);
    if (status !== 0 || !authStatus()[p.id]) die(`login to ${p.id} was not completed; re-run: team-harness auth`);
  }
}

// ---------- doctor ----------

const ROLES = ["lead", "lead-kimi", "worker", "takeover", "scout", "analyst", "reviewer", "advisor"];

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
  const auth = authStatus();
  const missing = PROVIDERS.filter((p) => !auth[p.id]).map((p) => p.id);
  const tag = run("git", ["-C", ROOT, "describe", "--tags", "--always"]).stdout?.trim();
  console.log(`ok: team-harness ${tag}, OpenCode ${v}, ${ROLES.length} roles valid, leads cannot edit`);
  if (missing.length) console.log(`warning: not logged in: ${missing.join(", ")} (team-harness auth)`);
}

// ---------- main ----------

function usage() {
  console.log(`team-harness — OpenCode with the team roles

  team-harness [args]          open the TUI in the current folder (agent: lead)
  team-harness run ...         headless run (same as 'opencode run')
  team-harness setup           install engine, log in, check (run once)
  team-harness auth [provider] log in (openai | kimi-code-plan-global | deepseek)
  team-harness update [--check]
  team-harness doctor          check config and roles without model calls
  team-harness metrics [--since YYYY-MM-DD] [--json]
  team-harness version`);
}

export async function main(argv) {
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
      if (!rest.includes("--no-login")) login();
      doctor();
      console.log("\nReady. Open a NEW terminal in your project folder and run: team-harness");
      return;
    case "auth":
      if (rest[0] === "import") return void (importOldAuth() || console.log("Nothing to import."));
      return login(rest[0]);
    case "update":
      if (!(await update({ force: true, check: rest.includes("--check") }))) await installEngine(readVersions());
      return;
    case "doctor":
      return doctor();
    case "metrics": {
      const { metricsMain } = await import("./metrics.js");
      return metricsMain(["--db", join(BASE, "data", "opencode", "opencode.db"), ...rest]);
    }
    default: {
      // Quiet background-style check; a failed check never blocks work.
      let updated = false;
      try {
        updated = await update({ quiet: true });
      } catch {}
      if (updated) {
        const r = spawnSync(process.execPath, [join(ROOT, "cli", "harness.js"), ...argv], { stdio: "inherit", env: process.env });
        process.exit(r.status ?? 1);
      }
      process.exit(engine(argv));
    }
  }
}

if (import.meta.main) await main(process.argv.slice(2));
