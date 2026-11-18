// `gate` tool: runs the project's own acceptance checks from .harness.json and returns
// a short verdict. The harness runs the commands — the lead accepts work on real exit
// codes instead of a worker's report, without getting a general-purpose shell.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_SEC = 900;
const TAIL_LINES = 25;
const MAX_REPORT = 4000;

export async function loadGate(root) {
  const file = join(root, ".harness.json");
  if (!existsSync(file)) return null;
  const cfg = JSON.parse(await readFile(file, "utf8"));
  const checks = Array.isArray(cfg?.gate) ? cfg.gate : [];
  return checks
    .filter((c) => c && typeof c.name === "string" && typeof c.run === "string" && c.run.trim())
    .map((c) => ({ name: c.name, run: c.run, timeoutSec: Number.isFinite(c.timeout_sec) ? c.timeout_sec : DEFAULT_TIMEOUT_SEC }));
}

function shell() {
  if (process.platform === "win32") return [process.env.OPENCODE_GIT_BASH_PATH || "bash.exe", "-c"];
  return ["sh", "-c"];
}

export function runCheck(check, cwd, signal) {
  return new Promise((resolve) => {
    const [bin, flag] = shell();
    const started = Date.now();
    const child = spawn(bin, [flag, check.run], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    const collect = (b) => { size += b.length; chunks.push(b); while (size > 4 << 20 && chunks.length > 1) size -= chunks.shift().length; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, check.timeoutSec * 1000);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener?.("abort", onAbort);
    const done = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ name: check.name, run: check.run, code, timedOut, seconds: (Date.now() - started) / 1000, output: Buffer.concat(chunks).toString("utf8") });
    };
    child.on("error", (e) => { chunks.push(Buffer.from(String(e))); done(127); });
    child.on("close", (code) => done(code ?? 1));
  });
}

export function report(results, logs = {}) {
  const lines = [];
  const failed = results.filter((r) => r.code !== 0);
  lines.push(failed.length ? `GATE: FAIL (${failed.length}/${results.length} checks failed)` : `GATE: PASS (${results.length} checks)`);
  for (const r of results) {
    const status = r.code === 0 ? "pass" : r.timedOut ? "TIMEOUT" : `FAIL exit ${r.code}`;
    lines.push(`- ${r.name}: ${status} (${r.seconds.toFixed(1)}s) \`${r.run}\``);
  }
  for (const r of failed) {
    const tail = r.output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
    lines.push(`\n## ${r.name} — last ${TAIL_LINES} lines${logs[r.name] ? ` (full log: ${logs[r.name]})` : ""}\n${tail}`);
  }
  const text = lines.join("\n");
  return text.length > MAX_REPORT ? text.slice(0, MAX_REPORT) + "\n[report truncated]" : text;
}

const NO_CONFIG = "No gate configured for this repository: there is no .harness.json with a \"gate\" list. " +
  "Ask the user to run `team-harness init` in the repository (it detects build/test/lint commands), " +
  "or rely on the acceptance commands the worker ran and say that the gate was not available.";

export default {
  id: "team-harness:gate",
  async server() {
    return {
      tool: {
        gate: {
          description:
            "Run this repository's acceptance checks (build/typecheck/lint/tests from .harness.json) in the current working tree " +
            "and get PASS/FAIL per check with the tail of failing output. Use it to accept or reject a change on real exit codes " +
            "instead of trusting a report. Takes no arguments; runs only the configured commands.",
          args: {},
          async execute(_args, ctx) {
            const root = ctx.worktree || ctx.directory;
            const checks = await loadGate(root).catch((e) => { throw new Error(`.harness.json is invalid: ${e.message}`); });
            if (!checks || !checks.length) return NO_CONFIG;
            ctx.metadata?.({ title: `gate: ${checks.map((c) => c.name).join(", ")}` });
            const results = [];
            for (const c of checks) results.push(await runCheck(c, root, ctx.abort));
            const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state") || tmpdir(), "gate-logs");
            const logs = {};
            await mkdir(dir, { recursive: true }).catch(() => {});
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            for (const r of results.filter((x) => x.code !== 0)) {
              const file = join(dir, `${stamp}-${r.name.replace(/[^\w.-]/g, "_")}.log`);
              if (await writeFile(file, r.output).then(() => true, () => false)) logs[r.name] = file;
            }
            return { title: results.every((r) => r.code === 0) ? "gate: pass" : "gate: FAIL", output: report(results, logs) };
          },
        },
      },
    };
  },
};
