# Переход агента на .NET 10 LTS — 4.40

Агент PanelTech и отдельный аварийный harness теперь собираются для **net10.0**. SDK **10.0.402** закреплён в agent/global.json с rollForward=disable/allowPrerelease=false; пакет Microsoft.Extensions.Hosting.WindowsServices **10.0.13**, оба NuGet lockfile пересчитаны и далее используются с --locked-mode. Официальная поддержка .NET 10 LTS — до **14.11.2028**, но servicing-обновления и их проверка всё равно нужны.

Официальные источники: [release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), [политика поддержки](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core), [установка на Windows](https://learn.microsoft.com/en-us/dotnet/core/install/windows), [изменение BackgroundService в .NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task).

## Сборка и проверка

Установите точный SDK из agent/global.json. В Linux x64 `python3 scripts/install-dotnet.py` загружает официальный tar.gz и проверяет закреплённый SHA-512; при существующем каталоге добавляет новую версию, сохраняя прежние SDK/runtime. Другие ОС/архитектуры этим скриптом не устанавливаются. GitHub и публикация для этого не нужны.

Из корня проекта после npm ci:

```sh
export DOTNET_CLI_HOME=/tmp/paneltech-dotnet-home
export NUGET_PACKAGES=/workspace/.tools/nuget
export PANELTECH_DOTNET=/workspace/.tools/dotnet/dotnet
bash scripts/check-agent.sh
```

Для обычной установки используйте путь своего dotnet вместо облачного. Из agent в PowerShell:

```powershell
dotnet --version
dotnet restore --locked-mode
dotnet build --no-restore -c Release
dotnet bin/Release/net10.0/PanelTech.Agent.dll --self-test
```

check-agent.sh выбирает SDK по global.json, выполняет locked restore/Release build обоих проектов, 31 self-test, 32 process recovery, API dry-run и fault-proxy доступов. Сам агент остаётся программой PanelTech. Код протокола/TTL/receipt/ownership/PowerShell в этом блоке не изменён; изменены платформа, зависимость, lockfile, пути проверок и установка SDK.

.NET 10 запускает всю ExecuteAsync у BackgroundService в фоне. Сообщение Host «Application started» само по себе не подтверждает регистрацию/готовность агента. Worker сохраняет явный выход с ошибкой и StopApplication при отказе state/доступа; это проверяется настоящими process-тестами. Windows SCM-start/stop здесь не проверены.

## Сохранение локального состояния при переходе

Перед реальным обновлением на отдельно согласованном Windows-ПК остановить службу/консоль, убедиться, что операции не выполняются, сохранить прежний полный пакет и защищённый state. Не удалять identity.json/receipts.json/ownership.json/rollback.json, не выдавать новый enrollment вместо обновления. Установить совместимый .NET 10 Runtime, затем заменить полный согласованный пакет; не копировать только DLL поверх старых зависимостей. Путь config/state должен остаться прежним. Копии state содержат секреты и требуют тех же прав.

Совместимость **конкретной версии Windows**, требуемых обновлений ОС, SCM/account/ACL и PowerShell NetQos пока не подтверждена. Фактические версии ОС клубов ещё не собраны. Framework-dependent пакет net10.0 требует .NET 10 Runtime; установленный .NET 8 его не заменяет. Перед реальным размещением сверить официальную таблицу поддерживаемых ОС. В 4.40 self-contained/win-x64 publish не проверялись. Следующий блок 4.41 проверил framework-dependent win-x64 cross-publish и повысил минимальный runtime до 10.0.13; подпись и реальное Windows-исполнение остаются непроверенными. См. WINDOWS-PACKAGE.md.

Дополнительная миграционная проверка использует предыдущий собранный пакет net8.0 (не входит в архив исходников):

```sh
PANELTECH_PREVIOUS_AGENT_DLL=/path/to/old/net8.0/PanelTech.Agent.dll python3 tests/agent_smoke.py
```

Нужен весь прежний output рядом с DLL и установленный .NET 8 Runtime для первого запуска. Тест требует runtimeconfig с tfm=net8.0, создаёт только временный приватный API/БД, сначала запускает настоящий .NET 8 агент без QoS, сохраняет результат/receipt, затем запускает новый .NET 10 агент с тем же state без enrollment. Проверяет прежние ID/token/receipt и attempts=1, затем отзыв. В обычном check-agent тот же сценарий проверяет restart net10→net10. Старое состояние не угадывается и не сбрасывается.

Сырые версии/проверки/SHA — DOTNET10-CHECKS.json и PROJECT-STATUS.md. Linux dry-run не подтверждает настоящую маркировку, Windows-перезагрузку, SCM, NTFS/ACL/UWF или MikroTik. Старые отчёты .NET 8 сохраняют свои исходные SHA и относятся к прежним блокам; их не переписывают под новую платформу.
