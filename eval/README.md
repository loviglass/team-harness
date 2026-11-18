# Сравнительный замер (этап 0–1)

Цель: на одних и тех же задачах сравнить расход «умной» модели и качество
у старого harness (`harness`, OpenCode + Slim) и нового (`team-harness`).

## Набор задач

10–15 реальных задач из рабочих проектов, по одной на файл `eval/tasks/NN-name.md`
(шаблон — `_template.md`). Смесь: ~40% рутина (баг/мелкая фича с тестом),
~40% средние (несколько файлов), ~20% сложные/рискованные (контракты, миграции, конкурентность).
У каждой задачи — фиксированный commit старта и **проверяемые критерии приёмки**
(команды, которые должны пройти). Без команд задача в набор не берётся.

## Прогон

Для каждой задачи и каждого варианта:

```sh
git -C <project> worktree add /tmp/eval-NN-<variant> <start-commit>
cd /tmp/eval-NN-<variant>
harness                 # вариант old
team-harness            # вариант new (агент lead = Astra), Tab -> lead-kimi для варианта new-kimi
```

Вставить текст задачи из раздела «Промпт» без подсказок. Не вмешиваться, кроме
ответов на прямые вопросы модели (ответы — заранее записанные в задаче).
После завершения выполнить команды приёмки вручную и записать результат.

## Метрики

```sh
old:   BUN_BE_BUN=1 ~/.local/share/team-harness/engine/opencode-*/opencode cli/metrics.js --db ~/.local/share/opencode-team-harness/data/opencode/opencode.db --since <дата> --json
new:   team-harness metrics --since <дата> --json
```

На задачу записать в `eval/results/<variant>.csv`:
`task, accepted(0/1), lead_ctx, lead_steps, lead_hands_on_share, child_ctx_total, wall_minutes, human_interventions, review_findings_high`.

## Критерий успеха этапа 1

- `lead_ctx` в среднем ≥3× меньше, чем у old;
- доля принятых задач не ниже old;
- время на задачу не хуже old более чем на 30%.

Если качество падает — смотреть, на каких задачах (рутина или сложные), и
двигать границу между worker и takeover, а не возвращать работу в lead.
