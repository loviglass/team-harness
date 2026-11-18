# team-harness

Команда моделей поверх **неизменённого** OpenCode: умная модель решает, дешёвые делают,
тесты проверяют. Конфиги, промпты и версии — в этом репо; обновление — `git pull`.

| Роль | Модель | Что делает |
|---|---|---|
| lead | GPT-6 Astra | разговаривает с вами, решает, пишет брифы, принимает результат; **не может править файлы и запускать команды** |
| worker | DeepSeek Flash | реализует одну задачу и сам прогоняет проверки |
| takeover | Kimi K3.1 Pro | забирает задачу, если worker дважды не прошёл проверку |
| scout | DeepSeek Flash (low) | быстро ищет, где что лежит; возвращает пути и выдержки |
| analyst | DeepSeek Flash (high) | глубокий read-only разбор: проверить гипотезу, найти реальные дефекты в подсистеме |
| reviewer | GPT-6 Astra | независимое ревью рискованного диффа |
| advisor | GPT-6 Astra | диагноз/решение без инструментов |

Почему так и что дальше: [docs/PLAN.md](docs/PLAN.md). Замеры: [eval/README.md](eval/README.md).

## Установка — одна команда

**macOS / Linux** (терминал):
```sh
curl -fsSL https://raw.githubusercontent.com/loviglass/team-harness/main/install.sh | sh
```
**Windows** (в cmd или PowerShell, без прав администратора):
```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/loviglass/team-harness/main/install.ps1 | iex"
```

Нужен только Git (на Windows ставится сам через winget, если его нет).
Установщик за ~1 минуту: клонирует репо на последний релизный тег, скачивает закреплённый
OpenCode с официального GitHub с проверкой SHA256, добавляет команду `team-harness` в PATH,
переносит входы из старого harness (если он был) или проводит вход в ChatGPT, Kimi и DeepSeek,
и запускает проверку. Node.js, Python, Go не нужны: CLI исполняется встроенным в OpenCode рантаймом Bun.
Повторный запуск установщика безопасен (чинит/обновляет).

## Работа

```sh
cd <проект>
team-harness                     # TUI, агент lead; Tab — lead-kimi
team-harness metrics --since 2026-11-18
team-harness update [--check]    # вручную; обычно не нужно
team-harness auth [provider]     # повторный вход
team-harness doctor
```

**Обновления автоматические:** при запуске (не чаще раза в 6 часов) клиент проверяет новый
релизный тег `vX.Y.Z` и переключается на него; при смене версии OpenCode в `versions.env`
скачивает новый движок. Без сети — работает текущая версия. Коммиты в `main` клиентам
не приходят — только теги.

Данные и входы: `~/.local/share/team-harness` (Linux), `~/Library/Application Support/team-harness` (macOS),
`%LOCALAPPDATA%\team-harness` (Windows). Личный `~/.config/opencode` и `~/.claude` не используются и не меняются.
Проектные `opencode.json` и `AGENTS.md` подключаются как обычно; если в репозитории вместо
`AGENTS.md` лежит `CLAUDE.md`, он передаётся агентам автоматически.

Вывод инструментов, попадающий в контекст, ограничен (`engines/opencode/plugins/output-cap.js`):
lead 8 тыс. символов, scout/analyst/reviewer 12 тыс., worker 24 тыс.; у команд сохраняются начало
и конец вывода, чтобы ошибки тестов не терялись.

## Выпуск обновления (владелец)

```sh
node --test tests/*.test.mjs && team-harness doctor
git tag -a v0.2.0 -m "что изменилось" && git push origin main --tags
```

## Проверки проекта (gate)

```sh
cd <проект> && team-harness init     # находит build/typecheck/lint/test → .harness.json; закоммитьте его
```

Инструмент `gate` запускает только эти команды и возвращает PASS/FAIL с хвостом ошибки
(полный лог — в каталоге состояния harness, не в репозитории). Lead принимает работу по `gate`,
а не по отчёту worker; bash у lead по-прежнему нет. Формат `.harness.json`:

```json
{ "gate": [ { "name": "test", "run": "go test ./...", "timeout_sec": 900 } ] }
```

## Защита от разрушительных команд

У пишущих ролей (worker, takeover) bash разрешён, кроме опасного: force-push, `sudo`,
`rm -rf` вне проекта, `terraform apply/destroy`, `docker system/volume prune`, публикация пакетов,
`curl … | sh` — запрещены; `git push`, `git reset --hard`, `rm -rf` в проекте, `ssh/scp`, `kubectl`,
`psql`/`mysql` к серверам, удаление docker-томов — только с подтверждением. Это ограничитель, а не песочница.

## Сравнение вариантов (eval)

```sh
team-harness eval eval/tasks --variant A,B,solo
```

Каждая задача (`eval/tasks/_template.md`: проект, стартовый коммит, промпт, команды приёмки)
прогоняется без интерфейса в отдельном git worktree; затем выполняются команды приёмки.
Итог — принято/нет, время, токены lead и по провайдерам. `solo` — базовая линия «одна сильная
модель делает всё сама» (только для eval). Все прогоны: `state/eval/results.jsonl`.

## Рокировка Astra ↔ Kimi

Если подписка одной модели расходуется быстрее, нажмите **Tab** в TUI: `lead` ↔ `lead-kimi`.

| | Режим A (`lead`, по умолчанию) | Режим B (`lead-kimi`, рокировка) |
|---|---|---|
| lead | Astra | Kimi |
| reviewer | Astra | Kimi |
| advisor | Astra | Kimi |
| takeover | Kimi | Astra |
| worker / scout / analyst | DeepSeek | DeepSeek |

Переключать можно посреди сессии: история сохраняется, новая модель один раз читает контекст lead
без кэша (обычно 10–30 тыс. токенов). Уже работающие субагенты не прерываются; следующие
вызовы reviewer/advisor/takeover идут к модели нового режима (`plugins/swap.js`).
Текущий режим показан в панели под Team. Панель считает скорость расхода каждого окна
(доля использованного ÷ доля прошедшего времени окна): `1.8×` — квота кончится почти вдвое
раньше сброса. Если модель текущего режима расходуется ≥1.3×, а другая заметно медленнее,
появляется подсказка `… — consider Tab`. Сама панель ничего не переключает.

## Правая панель

Под Context (если скрыта: `Ctrl+X`, затем `B`):

- **Team** — роли и модели в текущем режиме рокировки; `●` кто работает сейчас, `✓` сколько поручений завершено.
- **Tasks** — все поручения сессии по порядку: `●` в работе, `✓` готово, `✗` ошибка, `■` остановлено,
  плюс вердикты `gate` (PASS/FAIL). Без расхода токенов: собирается из данных сессии. План lead
  пишет коротким нумерованным списком в тексте ответа, а не отдельным todo-вызовом.
- **Spend (this session)** — токены по ролям в этой сессии и текущий контекст lead.
- **Usage & limits** — по каждому провайдеру окна от короткого к длинному (5h → Week → Month),
  остаток в процентах и время сброса по местному времени; DeepSeek — баланс. Обновление раз в минуту,
  ≤20% подсвечивается.

Плагин — `engines/opencode/plugins/team-panel.js`, только публичный TUI API OpenCode.
Тесты: `node --test tests/*.test.mjs`.

## Изменение команды

Роли и модели — `engines/opencode/opencode.json`, промпты — `engines/opencode/prompts/`.
Новая модель: добавить провайдера/модель и поставить её в нужную роль. После правки — `team-harness doctor`.
