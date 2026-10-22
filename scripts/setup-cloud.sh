#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e "if(Number(process.versions.node.split('.')[0])!==24)throw Error('Node.js 24 LTS required')"
npm ci --no-audit --no-fund
npm run typecheck
npm run build
# The demo does not need .NET; this also prepares the agent build workflow.
export DOTNET_CLI_HOME="${DOTNET_CLI_HOME:-/tmp/paneltech-dotnet-home}"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export NUGET_PACKAGES="${NUGET_PACKAGES:-/workspace/.tools/nuget}"
if command -v dotnet >/dev/null && dotnet --list-sdks | rg -q '^8\.0\.426 '; then
  paneltech_dotnet="$(command -v dotnet)"
else
  python3 scripts/install-dotnet.py
  paneltech_dotnet="${PANELTECH_DOTNET_DIR:-/workspace/.tools/dotnet}/dotnet"
fi
(cd agent && "$paneltech_dotnet" --version | rg '^8\.0\.426$')
"$paneltech_dotnet" restore agent/PanelTech.Agent.csproj --locked-mode
"$paneltech_dotnet" build agent/PanelTech.Agent.csproj --no-restore -c Release -m:2
"$paneltech_dotnet" agent/bin/Release/net8.0/PanelTech.Agent.dll --self-test
npm test
