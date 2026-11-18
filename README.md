# team-harness

Команда моделей поверх **неизменённого** OpenCode: умная модель решает, дешёвые делают,
тесты проверяют. Конфиги, промпты и версии — в этом репо; обновление — `git pull`.

| Роль | Модель | Что делает |
|---|---|---|
| lead | GPT-6 Astra | разговаривает с вами, решает, пишет брифы, принимает результат; **не может править файлы и запускать команды** |
| worker | DeepSeek Flash | реализует одну задачу и сам прогоняет проверки |
| takeover | Kimi K3.1 Pro | забирает задачу, если worker дважды не прошёл проверку |
| scout | DeepSeek Flash | ищет по коду и документации, возвращает пути и выдержки |
| reviewer | GPT-6 Astra | независимое ревью рискованного диффа |
| advisor | GPT-6 Astra | диагноз/решение без инструментов |

Почему так и что дальше: [docs/PLAN.md](docs/PLAN.md). Замеры: [eval/README.md](eval/README.md).

## Установка — одна команда

**macOS / Linux** (терминал):
```sh
curl -fsSL https://raw.githubusercontent.com/loviglass/team-harness/main/install.sh | sh
```
**Windows** (PowerShell, без прав администратора):
```powershell
irm https://raw.githubusercontent.com/loviglass/team-harness/main/install.ps1 | iex
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
`%LOCALAPPDATA%\team-harness` (Windows). Личный `~/.config/opencode` не используется и не меняется.
Проектные `opencode.json` и `AGENTS.md` подключаются как обычно.

## Выпуск обновления (владелец)

```sh
node --test tests/*.test.mjs && team-harness doctor
git tag -a v0.2.0 -m "что изменилось" && git push origin main --tags
```

## Правая панель

Под Context (если скрыта: `Ctrl+X`, затем `B`):

- **Team** — роли и модели; `●` кто работает сейчас и над чем, `✓` сколько поручений завершено.
- **Spend (this session)** — токены по ролям в этой сессии и текущий контекст lead.
- **Usage & limits** — по каждому провайдеру окна от короткого к длинному (5h → Week → Month),
  остаток в процентах и время сброса по местному времени; DeepSeek — баланс. Обновление раз в минуту,
  ≤20% подсвечивается.

Плагин — `engines/opencode/plugins/team-panel.js`, только публичный TUI API OpenCode.
Тесты: `node --test tests/*.test.mjs`.

## Изменение команды

Роли и модели — `engines/opencode/opencode.json`, промпты — `engines/opencode/prompts/`.
Новая модель: добавить провайдера/модель и поставить её в нужную роль. После правки — `team-harness doctor`.
