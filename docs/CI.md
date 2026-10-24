# Непрерывные проверки

**24.10.2026 пользователь отдельно разрешил отправку всех текущих изменений в GitHub. Коммит передачи использует `[skip ci]`, чтобы пропустить существующие push/PR Actions. Actions остаются приостановлены из-за лимитов; manual workflow не запускать. Конфигурация оставлена как есть, проверки выполняются локальными check-скриптами. Описание ниже не подтверждает удалённый зелёный CI.**

Workflow [ci.yml](../.github/workflows/ci.yml) запускается на push, pull request и вручную через GitHub Actions → CI → Run workflow. Он проверяет код на `ubuntu-24.04`; публикации, деплоя и подключения клубных ПК в нём нет.

| Задача GitHub Actions | Что выполняет |
| --- | --- |
| Web, API and Chromium (Linux DEMO) | Node из `.nvmrc`, Python 3.12, `npm ci`, фиксированный Playwright и его Chromium; typecheck, 165 Node-тестов API/core/форм/catalog reconciliation/local-owner/pagination/backup/migrations/compact-storage/resilience/audit/queue-load/device-access/operations и точный database CLI/таймер smoke, build, восемь браузерных сценариев desktop/mobile, включая двух администраторов/конфликты/audit/device-access |
| Agent recovery (Linux simulation, no Windows QoS) | Node и Python, SDK из `agent/global.json`, locked NuGet restore обоих проектов, Release build, 31 self-test, 32 аварийных process-теста с файловым имитатором и два dry-run Worker с настоящим loopback API, включая fault proxy доступа |

Сценарии используют временные БД и loopback-порты. Агентская задача не требует `dist`: проверяет только API. Настоящая Windows-инспекция, PowerShell, SCM, UWF и MikroTik не подтверждаются зелёным Linux CI. Детали аварийных тестов — [AGENT-RECOVERY-TESTS.md](AGENT-RECOVERY-TESTS.md).

## Повторить команды локально

Из корня репозитория после `npm ci` и установки Python Playwright/Chromium:

```sh
bash scripts/check-web.sh
bash scripts/check-agent.sh
```

Для текущей облачной среды при необходимости:

```sh
export DOTNET_CLI_HOME=/tmp/paneltech-dotnet-home
export NUGET_PACKAGES=/workspace/.tools/nuget
export PANELTECH_DOTNET=/workspace/.tools/dotnet/dotnet
bash scripts/check-agent.sh
```

Скрипт агента ищет `PANELTECH_DOTNET`, системный `dotnet`, затем облачный путь. Restore/build запускаются из `agent/`, чтобы `global.json` выбирал нужный SDK даже при наличии более новых SDK на runner. Оба Python-стенда учитывают `PANELTECH_DOTNET`.

Для веб-проверки нужны зависимости из `tests/requirements-browser.txt` и Chromium. CI устанавливает браузер через `python -m playwright install --with-deps chromium` и явно передаёт `CHROMIUM_PATH` из установленного Playwright. Локально допустим системный `/usr/bin/chromium`, как в текущей облачной среде; подготовка описана в README. Скрипты завершаются при первой ошибке.

## Права, результаты и диагностика

- Actions закреплены полными commit SHA; версии указаны в комментариях. Обновление SHA — отдельное проверяемое изменение. npm и NuGet используют lockfiles; Playwright закреплён в requirements.
- `GITHUB_TOKEN` имеет только `contents: read`; checkout не сохраняет credentials. Секреты репозитория не используются, `pull_request_target` и привилегированные runner не используются.
- Две задачи независимы, каждая ограничена 15 минутами. Новый запуск той же ветки/PR отменяет предыдущий незавершённый запуск.
- Скриншоты вымышленного DEMO (основной экран, формы, пустой каталог на desktop/mobile) сохраняются как artifact `demo-chromium-screenshots` на 7 дней, если успели создаться. БД, agent state, токены и сырые логи в artifacts не входят. Остальная диагностика — stdout шагов Actions.
- Статус смотреть в [Actions репозитория](https://github.com/Kob426/paneltech/actions/workflows/ci.yml). Ошибки npm/NuGet/скачивания браузера проверять в соответствующем install-шаге; ошибки поведения — в Verify. Не обходить failing test через `continue-on-error`.

При добавлении workflow здесь прошли `actionlint 1.7.7`, `bash -n` и оба check-скрипта целиком. Проверка actionlint выполнена временным официальным binary с SHA-256 сверкой, он не добавлен в репозиторий. Использованы предустановленные зависимости облачной среды; установка на чистом GitHub runner, кэши и загрузка artifact локальным прогоном не доказаны.

**Статус удалённого запуска пока не подтверждён:** GitHub API из этой среды отвечает `403 Forbidden` на чтение Actions. Наличие workflow и успешный push не означают зелёный запуск на GitHub. Настройки разрешения Actions, runner/квот и обязательных checks не менялись. После первого подтверждённого удалённого прогона нужно отметить задачу 4.19 в TASKS.md и сохранить результат в PROJECT-STATUS.md. Пока локальные успешные проверки и удалённый CI учитываются отдельно.

Нагрузочный стенд запускается отдельно командой `npm run measure:load` на временных SQLite: 52 клуба/3380 устройств/10k и 100k jobs. Он не добавлен в GitHub workflow и не выполняется на реальных ПК. Методика и зафиксированные результаты — [LOAD-TESTING.md](LOAD-TESTING.md).

## Локальная проверка 4.35/4.36 — 24.10.2026

После непрерывной нагрузки отдельно прошёл bash scripts/check-web.sh: typecheck/build, 140 Node-тестов, шесть Chromium-сценариев с проверками dark theme/contrast, database CLI/API. `npm run measure:soak` остаётся отдельной ручной 10-минутной Linux-командой, не добавлен в workflow и не совмещается с другими CPU-нагруженными проверками. Результаты/неудачный первый backup и исправление — SOAK-TESTING.md/SOAK-RESULTS.json. Actions/push/remote API не запускались; Windows не проверялся.

## Локальный блок 4.37 / 7.3

Текущие команды дополнены access-проверками: 150 Node, семь Chromium + database CLI/API; .NET build, 31 self-test/32 process recovery, agent_smoke.py и agent_access_smoke.py. Источники/границы — AGENT-ACCESS-CHECKS.json и AGENT-ACCESS.md. Workflow/Actions/push не менялись/не запускались; private fixture ports 3110 (+динамический proxy) и 3112. Реальные ПК/Windows QoS не выполняются.

## Локальные проверки 4.38

Актуальный scripts/check-web.sh выполняет typecheck, 165 Node-теста, build, восемь Chromium-сценариев, database CLI/API и test:operations — настоящий 60-секундный таймер с копией/restore-drill и restart на временном API 3114. Новый browser_operations.py использует временный DEMO 3113, lost POST, реальную файловую блокировку, retry, роли, stale GET и desktop/mobile contrast. GitHub workflow не менялся/не запускался; это локальные результаты. Агентский C# в этом блоке не менялся; прежний .NET build/self/process результат относится к 4.37.

Отдельный измерительный профиль 4.39: `npm run measure:operations-load -- --seconds 900 --heartbeat-rps 600 --jobs 100000`. В check-web/workflow не включён, запускать отдельно от CPU-нагруженных проверок. Очередь генератора проверяется `python3 tests/operations_load_generator.py`; результаты обеих попыток — AUTOMATIC-LOAD-RESULTS.json.

## Локальный переход .NET 10 — 4.40

check-agent.sh теперь использует net10.0/SDK 10.0.402 и обновлённые NuGet lockfile 10.0.13. Locked build, 31 self-test, 32 process recovery и оба API smoke прошли. Дополнительный net8→net10 state-upgrade выполняется через PANELTECH_PREVIOUS_AGENT_DLL с прежним пакетом; в обычном clean-check его нет и он не подменяется тестом net10→net10. GitHub workflow не менялся, его существующая ссылка на global.json использует текущую фиксацию при будущем отдельно разрешённом запуске. Подробности — DOTNET10-UPGRADE.md.

## Windows package 4.41 — Linux cross-publish

`python3 scripts/package-agent.py build --out <новый.zip>` выполняет locked restore/win-x64 FDD publish и статическую проверку пакета. `PANELTECH_WINDOWS_PACKAGE=<zip> python3 tests/windows_package.py` проверяет 10 негативных/комплектных сценариев, включая UTF-8 BOM для PS5.1. `PANELTECH_AGENT_DLL=<распакованная опубликованная DLL> bash scripts/check-agent.sh` проверяет API smoke именно на опубликованной DLL; harness остаётся отдельным Linux executable. Windows EXE не запускается. Пакет unsigned, не содержит runtime/config/state; фактические проверки — WINDOWS-PACKAGE-CHECKS.json. Workflow не менялся.
