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
| SQLite / backup / migrations / сжатие | `npm test`, `npm run test:database` (временные файлы/API, loopback 3107), typecheck; browser regression при изменении Store; при изменении формата хранения `npm run measure:storage` на временных синтетических базах, со сравнением логической истории и фактического файла |
| Очередь / token lookup / state / планы SQL | `npm test`, typecheck/build, browser + database regression; `npm run measure:load` отдельно на временных синтетических БД, не одновременно с другими CPU-нагруженными проверками; методика docs/LOAD-TESTING.md |
| Длительная нагрузка / online backup при записи | `npm run measure:soak` отдельно от сборок/браузера/другой CPU-нагрузки; собственные временные базы, заданная частота/dropped/error, два backup/restore и отсутствие replay; методика docs/SOAK-TESTING.md. Короткий smoke не заменяет полный прогон |
| C# / агент | Locked restore, Release build, `--self-test`; при протоколе/outbox — `python3 tests/agent_smoke.py` |

Для установки использовать `npm ci`, а не произвольное обновление lockfile. Не переустанавливать зависимости одновременно с работающими тестами, не пересобирать бинарник агента во время его smoke-процесса.

## Агент в текущей Linux-среде

Найти SDK: `command -v dotnet`; если нет — проверить `/workspace/.tools/dotnet/dotnet`. Фиксация SDK — `agent/global.json`. Для локального SDK задать DOTNET_CLI_HOME=/tmp/paneltech-dotnet-home, NUGET_PACKAGES=/workspace/.tools/nuget. Не менять HOME/CODEX_HOME.

```sh
/workspace/.tools/dotnet/dotnet restore agent/PanelTech.Agent.csproj --locked-mode
/workspace/.tools/dotnet/dotnet build agent/PanelTech.Agent.csproj --no-restore -c Release -m:2
/workspace/.tools/dotnet/dotnet agent/bin/Release/net10.0/PanelTech.Agent.dll --self-test
python3 tests/agent_smoke.py
python3 tests/agent_access_smoke.py
```

Если dotnet системный, использовать его путь. При sandbox-ошибке mutex выяснить ограничение и использовать штатный механизм разрешений; не отключать NuGet/TLS/checksum. После успешной установки по необходимости доступен `bash scripts/setup-cloud.sh`.

## DEMO и браузер

`npm run demo` запускает панель/API/симулятор на loopback port 3000. Проверить `/api/health`: ok, DEMO, realAgents=false; затем аутентифицированные state, создание задания, индивидуальный результат и историю. Порт/PID не доказывает работоспособность.

Browser smoke использует временную SQLite и порт 3099, admin/empty-catalog сценарий — отдельную SQLite и порт 3102, personal-owner/password-reset браузер — порт 3104; рабочий экран/20–65 ПК — порт 3105; серверные страницы/фильтры — порт 3106; два администратора/конфликты/audit — порт 3108; доступ устройств — приватный синтетический API на 3112. Linux TTY smoke tests/local_owner_smoke.py проверяет setup:owner/local с временной SQLite и портом 3103; .NET smoke — другую временную БД, порт 3101 и отдельный Linux dry-run Worker. Проверить наличие Python Playwright/Chromium; настройки — README и tests/requirements-browser.txt. Не регистрировать настоящий ПК ради smoke-теста. Не стирать `.data` пользователя; временные данные держать отдельно.

## Оценка результата

Сохранять exit code; различать pass/fail/skipped/unrun и число реально выполненных тестов. При сбое диагностировать первопричину, исправить и повторить затронутое. После успешных достаточных проверок не расширять тестирование бесконечно. В финале перечислить конкретные проверки и границы: Linux build/self-test/dry-run не проверяют Windows PowerShell, службу SCM, UWF или MikroTik.

Для изменения доступа агента: `bash scripts/check-agent.sh` включает `agent_access_smoke.py` (временная БД/API 3110, loopback proxy, настоящий .NET dry-run, потерянные ответы/ошибка записи токена/карантин). Не пересобирать бинарники, пока стенд работает. `browser_device_access.py` проверяет подтверждение, файл, 409 и тёмные desktop/mobile; секрет не должен попасть в DOM/PNG. Исторические LOAD/SOAK SHA не переписывать после изменений кода; новые числа требуют нового замера.

Для расписания/retention/мониторинга: npm test включает tests/operations.test.ts (временные копии, отдельный worker, crash/lock/restore/права/пауза записи). npm run test:operations проверяет настоящий начальный 60-секундный timer и restart на временном DEMO 3114; browser_operations.py — вкладку «Сервер» на отдельном DEMO 3113. Обе команды входят в check-web.sh. Не сокращать длительность теста с mock-clock и не выдавать его за многочасовую нагрузку. Данные и старые отчёты не перезаписывать; подробнее docs/OPERATIONS.md.

Совместная нагрузка штатного Operations/backup-task/restore/retention: npm run measure:operations-load; методика docs/AUTOMATIC-LOAD.md. Только приватная временная БД, запускать отдельно от других тяжёлых задач. Не менять код стенда во время замера; сохранять неудачные попытки и их SHA. Python-проверки учёта slots: python3 tests/operations_load_generator.py. Полный 15-минутный профиль не заменяет многочасовой/2-секундный профиль всех агентов.

Для Windows-пакета: python3 scripts/package-agent.py build --out <новый.zip>, затем verify --from <zip>; PANELTECH_WINDOWS_PACKAGE=<zip> python3 tests/windows_package.py. Верифицировать до распаковки. Опубликованную managed DLL можно проверить в Linux self-test и API smoke через PANELTECH_AGENT_DLL, но это не проверка Windows EXE/SCM/NetQos. Не пересобирать пакет/агент во время process-smoke. qos.ps1: проверять UTF-8 BOM для PS5.1 и сохранность текста; реальную кодировку stdin/stdout/Unicode-путей проверять отдельно на Windows.
