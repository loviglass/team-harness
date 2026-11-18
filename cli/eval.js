// team-harness eval: run real tasks headless and compare variants on acceptance and spend.
//   team-harness eval <task.md|dir> [--variant A,B,solo] [--timeout 45] [--keep]
// Each run: fresh git worktree at the task's start commit -> headless session ->
// acceptance commands -> per-vendor token totals from the session database.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SECTION = { prompt: ["Промпт", "Prompt"], answers: ["Заготовленные ответы", "Answers"], acceptance: ["Приёмка", "Acceptance"] };

export function parseTask(text, file = "task") {
  const field = (...names) => {
    for (const n of names) {
      const m = new RegExp(`^-\\s*${n}:\\s*(.+)$`, "m").exec(text);
      if (m) return m[1].trim();
    }
    return undefined;
  };
  const sections = {};
  for (const chunk of text.split(/^##\s+/m).slice(1)) {
    const nl = chunk.indexOf("\n");
    sections[chunk.slice(0, nl < 0 ? undefined : nl).trim()] = nl < 0 ? "" : chunk.slice(nl + 1).trim();
  }
  const section = (names) => names.map((n) => sections[n]).find((v) => v !== undefined);
  const acceptance = section(SECTION.acceptance) || "";
  const block = /```(?:sh|bash|shell)?\s*\n([\s\S]*?)```/.exec(acceptance)?.[1] || "";
  const task = {
    name: basename(file).replace(/\.md$/, ""),
    project: field("Проект", "Project"),
    start: field("Старт", "Start"),
    prompt: section(SECTION.prompt),
    answers: section(SECTION.answers),
    acceptance: block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  };
  const missing = ["project", "start", "prompt"].filter((k) => !task[k]).concat(task.acceptance.length ? [] : ["acceptance commands"]);
  if (missing.length) throw new Error(`${file}: missing ${missing.join(", ")}`);
  if (task.project.startsWith("~")) task.project = join(homedir(), task.project.slice(1));
  return task;
}

export function vendorOf(modelID = "") {
  if (/gpt|astra|^o\d/i.test(modelID)) return "openai";
  if (/^k\d|kimi/i.test(modelID)) return "kimi";
  if (/deepseek/i.test(modelID)) return "deepseek";
  return "other";
}

export function sessionSpend(steps, root) {
  const out = { lead: 0, byVendor: {}, byRole: {}, steps: 0 };
  for (const s of steps.filter((x) => x.root === root)) {
    out.steps++;
    out.byVendor[vendorOf(s.model)] = (out.byVendor[vendorOf(s.model)] || 0) + s.ctx;
    const role = s.isRoot ? "lead" : s.agent;
    out.byRole[role] = (out.byRole[role] || 0) + s.ctx;
    if (s.isRoot && s.agent !== "compaction") out.lead += s.ctx;
  }
  return out;
}

function variantSetup(variant, harnessRoot) {
  const noQuestions = { question: "deny" };
  if (variant === "A") return { agent: "lead", config: { agent: { lead: { permission: noQuestions } } } };
  if (variant === "B") return { agent: "lead-kimi", config: { agent: { "lead-kimi": { permission: noQuestions } } } };
  if (variant === "solo" || variant === "solo-kimi") {
    // Baseline: one strong model does everything itself (the old orchestrator shape).
    const team = JSON.parse(readFileSync(join(harnessRoot, "engines", "opencode", "opencode.json"), "utf8"));
    const model = variant === "solo" ? "openai/gpt-6-astra" : "kimi-code-plan-global/k3.1-pro";
    return {
      agent: variant,
      config: { agent: { [variant]: { mode: "primary", model, variant: "high", description: "eval baseline", permission: { task: "deny", question: "deny", bash: team.agent.worker.permission.bash } } } },
    };
  }
  throw new Error(`unknown variant ${variant} (A, B, solo, solo-kimi)`);
}

function sh(cmd, cwd, timeoutMs) {
  const bash = process.platform === "win32" ? process.env.OPENCODE_GIT_BASH_PATH || "bash.exe" : "sh";
  const r = spawnSync(bash, ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 << 20 });
  return { cmd, code: r.status ?? 1, tail: `${r.stdout || ""}${r.stderr || ""}`.trimEnd().split("\n").slice(-5).join("\n") };
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round((n || 0) / 1e3)}K`);

export async function evalMain(args, { engineRun, dbPath, base, harnessRoot }) {
  let variants = ["A"], timeoutMin = 45, keep = false;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--variant") variants = args[++i].split(",").map((v) => v.trim());
    else if (args[i] === "--timeout") timeoutMin = Number(args[++i]);
    else if (args[i] === "--keep") keep = true;
    else targets.push(args[i]);
  }
  if (!targets.length) throw new Error("usage: team-harness eval <task.md|dir> [--variant A,B,solo] [--timeout 45] [--keep]");
  const files = targets.flatMap((t) => (statSync(t).isDirectory() ? readdirSync(t).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort().map((f) => join(t, f)) : [t]));
  const tasks = files.map((f) => parseTask(readFileSync(f, "utf8"), f));
  const { load } = await import("./metrics.js"); // bun:sqlite, only inside the engine runtime
  const outDir = join(base, "state", "eval");
  mkdirSync(outDir, { recursive: true });
  const resultsFile = join(outDir, "results.jsonl");
  const results = [];

  for (const task of tasks) {
    for (const variant of variants) {
      const setup = variantSetup(variant, harnessRoot);
      const wt = join(outDir, `wt-${task.name}-${variant}-${Date.now()}`);
      const add = spawnSync("git", ["-C", task.project, "worktree", "add", "--detach", wt, task.start], { encoding: "utf8" });
      if (add.status !== 0) throw new Error(`worktree for ${task.name}: ${add.stderr}`);
      const prompt = `${task.prompt}\n\n(Работай без вопросов пользователю: при неясности выбирай разумное допущение и укажи его в итоге.${task.answers ? `\nЗаготовленные ответы на возможные вопросы:\n${task.answers}` : ""})`;
      console.log(`▶ ${task.name} [${variant}] …`);
      const started = Date.now();
      const r = engineRun(["run", "--dir", wt, "--agent", setup.agent, "--format", "json", prompt], setup.config, timeoutMin * 60000);
      const wallS = Math.round((Date.now() - started) / 1000);
      const session = /"sessionID":"([^"]+)"/.exec(r.stdout || "")?.[1];
      const acceptance = task.acceptance.map((c) => sh(c, wt, 30 * 60000));
      const accepted = r.status === 0 && acceptance.every((a) => a.code === 0);
      const spend = session ? sessionSpend(load(dbPath).steps, session) : null;
      const row = { at: new Date().toISOString(), task: task.name, variant, session, accepted, timedOut: r.timedOut, exit: r.status, wallS, acceptance, spend };
      appendFileSync(resultsFile, JSON.stringify(row) + "\n");
      results.push(row);
      console.log(`  ${accepted ? "ACCEPTED" : "REJECTED"} in ${wallS}s · lead ${fmt(spend?.lead)} · ` + Object.entries(spend?.byVendor || {}).map(([v, n]) => `${v} ${fmt(n)}`).join(" · "));
      for (const a of acceptance.filter((x) => x.code !== 0)) console.log(`    ✗ ${a.cmd} (exit ${a.code})\n      ${a.tail.replace(/\n/g, "\n      ")}`);
      if (!keep) spawnSync("git", ["-C", task.project, "worktree", "remove", "--force", wt]);
      else console.log(`  worktree kept: ${wt}`);
    }
  }

  console.log(`\n${"variant".padEnd(10)} ${"accepted".padStart(9)} ${"avg time".padStart(9)} ${"avg lead".padStart(9)} ${"openai".padStart(8)} ${"kimi".padStart(8)} ${"deepseek".padStart(9)}`);
  for (const v of variants) {
    const rows = results.filter((r) => r.variant === v);
    const avg = (f) => rows.reduce((n, r) => n + (f(r) || 0), 0) / Math.max(rows.length, 1);
    console.log(`${v.padEnd(10)} ${`${rows.filter((r) => r.accepted).length}/${rows.length}`.padStart(9)} ${`${Math.round(avg((r) => r.wallS))}s`.padStart(9)} ${fmt(avg((r) => r.spend?.lead)).padStart(9)} ${fmt(avg((r) => r.spend?.byVendor.openai)).padStart(8)} ${fmt(avg((r) => r.spend?.byVendor.kimi)).padStart(8)} ${fmt(avg((r) => r.spend?.byVendor.deepseek)).padStart(9)}`);
  }
  console.log(`\nAll runs: ${resultsFile}`);
}
