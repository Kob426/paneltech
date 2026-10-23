#!/usr/bin/env bash
# Linux test processes only. Never enables Windows QoS or installs a service.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${PANELTECH_DOTNET:-}" ]]; then
  paneltech_dotnet="$PANELTECH_DOTNET"
elif command -v dotnet >/dev/null; then
  paneltech_dotnet="$(command -v dotnet)"
else
  paneltech_dotnet=/workspace/.tools/dotnet/dotnet
fi
export PANELTECH_DOTNET="$paneltech_dotnet"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
# Resolve the SDK from agent/global.json even on runners with newer SDKs installed.
(
  cd agent
  "$paneltech_dotnet" --version
  "$paneltech_dotnet" restore ../tests/agent-harness/AgentHarness.csproj --locked-mode
  "$paneltech_dotnet" build ../tests/agent-harness/AgentHarness.csproj --no-restore -c Release -m:2
)
"$paneltech_dotnet" agent/bin/Release/net8.0/PanelTech.Agent.dll --self-test
python3 tests/agent_recovery.py
python3 tests/agent_smoke.py
