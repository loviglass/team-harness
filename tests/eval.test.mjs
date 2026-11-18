import test from "node:test";
import assert from "node:assert/strict";
import { parseTask, sessionSpend, vendorOf } from "../cli/eval.js";

const TASK = `# 01 — median

- Проект: ~/proj
- Старт: abc123
- Класс: рутина

## Промпт
Почини median.
Тесты не меняй.

## Заготовленные ответы
Если спросит про пустой список — ValueError.

## Приёмка
\`\`\`sh
# comment
python3 -m unittest -q
git diff --quiet HEAD -- test_calc.py
\`\`\`
Дополнительно: вручную ничего.
`;

test("task markdown parses into project, start, prompt, answers, acceptance", () => {
  const t = parseTask(TASK, "eval/tasks/01-median.md");
  assert.equal(t.name, "01-median");
  assert.match(t.project, /proj$/);
  assert.ok(!t.project.startsWith("~"));
  assert.equal(t.start, "abc123");
  assert.equal(t.prompt, "Почини median.\nТесты не меняй.");
  assert.match(t.answers, /ValueError/);
  assert.deepEqual(t.acceptance, ["python3 -m unittest -q", "git diff --quiet HEAD -- test_calc.py"]);
});

test("a task without acceptance commands is rejected", () => {
  assert.throws(() => parseTask("- Проект: x\n- Старт: y\n## Промпт\nz\n", "bad.md"), /acceptance/);
});

test("spend is attributed per vendor and lead", () => {
  assert.equal(vendorOf("gpt-6-astra"), "openai");
  assert.equal(vendorOf("k3.1-pro"), "kimi");
  assert.equal(vendorOf("deepseek-flash"), "deepseek");
  const steps = [
    { root: "r", isRoot: true, agent: "lead", model: "gpt-6-astra", ctx: 100 },
    { root: "r", isRoot: false, agent: "worker", model: "deepseek-flash", ctx: 1000 },
    { root: "r", isRoot: true, agent: "compaction", model: "deepseek-flash", ctx: 50 },
    { root: "other", isRoot: true, agent: "lead", model: "gpt-6-astra", ctx: 9999 },
  ];
  const s = sessionSpend(steps, "r");
  assert.equal(s.lead, 100);
  assert.deepEqual(s.byVendor, { openai: 100, deepseek: 1050 });
  assert.equal(s.byRole.worker, 1000);
});
