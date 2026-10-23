# Непрерывные проверки

Workflow [ci.yml](../.github/workflows/ci.yml) запускается на push, pull request и вручную через GitHub Actions → CI → Run workflow. Он проверяет код на `ubuntu-24.04`; публикации, деплоя и подключения клубных ПК в нём нет.

| Задача GitHub Actions | Что выполняет |
| --- | --- |
| Web, API and Chromium (Linux DEMO) | Node из `.nvmrc`, Python 3.12, `npm ci`, фиксированный Playwright и его Chromium; typecheck, 61 Node-тест API/core/валидации форм/catalog reconciliation, build, настоящий браузерный сценарий desktop/mobile |
| Agent recovery (Linux simulation, no Windows QoS) | Node и Python, SDK из `agent/global.json`, locked NuGet restore обоих проектов, Release build, 17 self-test, 19 аварийных process-тестов с файловым имитатором и dry-run Worker с настоящим loopback API |

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
