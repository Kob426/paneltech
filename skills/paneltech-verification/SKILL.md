---
name: paneltech-verification
description: "Проверить запуск, сборку и регрессии PanelTech: TypeScript/Vue, API/симулятор, Chromium и Linux dry-run .NET-агента. Применять при проверке изменений и перед отчётом о готовности."
---

# Проверка по фактическому результату

Выполнять команды из корня checkout. Проверить `package.json`, README и наличие инструментов: команды/версии могут измениться. Не считать этот файл отчётом уже выполненных тестов.

## Выбор проверок

| Изменение | Проверка |
| --- | --- |
| Только инструкции/Markdown | Ссылки, команды по существующему package.json, структура навыков; не запускать все сборки без причины |
| TypeScript / Vue | `npm run typecheck`, `npm run build` |
| API / очередь / симулятор / контракт | `npm test` + typecheck; целевой содержательный regression test |
| Поведение интерфейса | Build + `npm run test:browser`, осмотр итогового desktop/mobile рендера |
| C# / агент | Locked restore, Release build, `--self-test`; при протоколе/outbox — `python3 tests/agent_smoke.py` |

Для установки использовать `npm ci`, а не произвольное обновление lockfile. Не переустанавливать зависимости одновременно с работающими тестами, не пересобирать бинарник агента во время его smoke-процесса.

## Агент в текущей Linux-среде

Найти SDK: `command -v dotnet`; если нет — проверить `/workspace/.tools/dotnet/dotnet`. Фиксация SDK — `agent/global.json`. Для локального SDK задать DOTNET_CLI_HOME=/tmp/paneltech-dotnet-home, NUGET_PACKAGES=/workspace/.tools/nuget. Не менять HOME/CODEX_HOME.

```sh
/workspace/.tools/dotnet/dotnet restore agent/PanelTech.Agent.csproj --locked-mode
/workspace/.tools/dotnet/dotnet build agent/PanelTech.Agent.csproj --no-restore -c Release -m:2
/workspace/.tools/dotnet/dotnet agent/bin/Release/net8.0/PanelTech.Agent.dll --self-test
python3 tests/agent_smoke.py
```

Если dotnet системный, использовать его путь. При sandbox-ошибке mutex выяснить ограничение и использовать штатный механизм разрешений; не отключать NuGet/TLS/checksum. После успешной установки по необходимости доступен `bash scripts/setup-cloud.sh`.

## DEMO и браузер

`npm run demo` запускает панель/API/симулятор на loopback port 3000. Проверить `/api/health`: ok, DEMO, realAgents=false; затем аутентифицированные state, создание задания, индивидуальный результат и историю. Порт/PID не доказывает работоспособность.

Browser smoke использует временную SQLite и порт 3099; .NET smoke — другую временную БД, порт 3101 и отдельный Linux dry-run Worker. Проверить наличие Python Playwright/Chromium; настройки — README и tests/requirements-browser.txt. Не регистрировать настоящий ПК ради smoke-теста. Не стирать `.data` пользователя; временные данные держать отдельно.

## Оценка результата

Сохранять exit code; различать pass/fail/skipped/unrun и число реально выполненных тестов. При сбое диагностировать первопричину, исправить и повторить затронутое. После успешных достаточных проверок не расширять тестирование бесконечно. В финале перечислить конкретные проверки и границы: Linux build/self-test/dry-run не проверяют Windows PowerShell, службу SCM, UWF или MikroTik.
