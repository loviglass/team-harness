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

## Установка (Linux/macOS)

```sh
git clone <repo> ~/.local/share/team-harness/repo
ln -s ~/.local/share/team-harness/repo/bin/team-harness ~/.local/bin/team-harness
team-harness install-engine      # закреплённый OpenCode из versions.env, проверка SHA256
team-harness auth import         # взять входы из старого harness, или: team-harness auth login
team-harness doctor
```

## Работа

```sh
cd <проект>
team-harness                     # TUI, агент lead; Tab — lead-kimi
team-harness metrics --since 2026-11-18
team-harness update              # git pull + движок, если пин сменился
```

Личный `~/.config/opencode` не используется и не меняется. Данные и входы —
в `~/.local/share/team-harness`. Проектные `opencode.json` и `AGENTS.md` подключаются как обычно.

## Изменение команды

Роли и модели — `engines/opencode/opencode.json`, промпты — `engines/opencode/prompts/`.
Новая модель: добавить провайдера/модель и поставить её в нужную роль. После правки — `team-harness doctor`.
