"""Exercises the compiled .NET worker over loopback, dry-run only, no Windows machine."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("PANELTECH_DOTNET") or shutil.which("dotnet") or "/workspace/.tools/dotnet/dotnet"
BASE = "http://127.0.0.1:3101/api"


def run():
    with tempfile.TemporaryDirectory(prefix="paneltech-agent-test-") as temp:
        temp = Path(temp)
        log = open(temp / "processes.log", "w+")
        api = subprocess.Popen(["node", "--import", "tsx", "server/index.ts"], cwd=ROOT, env=dict(os.environ, ENABLE_REAL_AGENTS="1", PORT="3101", DB_PATH=str(temp / "fixture.sqlite"), ADMIN_USERNAME="fixture", ADMIN_PASSWORD="FixturePassword-2026!"), stdout=log, stderr=log)
        agent = None
        cookie = ""
        csrf = ""

        def request(path, method="GET", body=None):
            headers = {"Content-Type": "application/json", "Cookie": cookie, "X-CSRF-Token": csrf}
            req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response), response.headers

        def wait(condition):
            for _ in range(150):
                if condition():
                    return
                time.sleep(0.1)
            print("fixture jobs", request("/history")[0]); raise AssertionError("Condition timed out")

        def start_agent(enroll=False):
            args = [DOTNET, str(ROOT / "agent/bin/Release/net8.0/PanelTech.Agent.dll"), "--config", str(temp / "config.json")]
            if enroll:
                args += ["--enrollment-file", str(temp / "enroll.txt")]
            return subprocess.Popen(args, cwd=ROOT, env=dict(os.environ, DOTNET_CLI_HOME=str(temp / "dotnet-home")), stdout=log, stderr=log)

        def stop(process):
            if process:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        try:
            for _ in range(100):
                try:
                    request("/health")
                    break
                except OSError:
                    time.sleep(0.1)
            login, headers = request("/login", "POST", {"username": "fixture", "password": "FixturePassword-2026!"})
            cookie = headers["Set-Cookie"].split(";")[0]
            csrf = login["csrf"]
            club, _ = request("/admin/clubs", "POST", {"name": "Linux dry-run fixture / no club PC", "variants": [{"id": 36, "name": "Fixture"}]})
            game, _ = request("/admin/games", "POST", {"name": "Contract fixture", "exes": ["fixture.exe"]})
            enrollment, _ = request("/admin/enrollments", "POST", {"clubId": club["id"]})
            (temp / "enroll.txt").write_text(enrollment["token"])
            (temp / "enroll.txt").chmod(0o600)
            (temp / "config.json").write_text(json.dumps({"serverUrl": "http://127.0.0.1:3101", "stateDirectory": "state", "name": "LINUX-DRY-RUN"}))
            agent = start_agent(enroll=True)
            wait(lambda: len(request("/state")[0]["devices"]) == 1)
            state, _ = request("/state")
            device = state["devices"][0]
            assert not device["demo"]
            assert device["inspectedAt"] is None, "Dry-run must not claim factual inspection"
            jobs, _ = request("/jobs", "POST", {"deviceIds": [device["id"]], "gameId": game["id"], "variant": 36, "operation": "apply_marking"})
            def finished():
                return request("/history")[0][0]["state"] == "failed"
            wait(finished)
            job = request("/history")[0][0]
            assert job["id"] == jobs[0]["id"] and job["code"] == "dry_run"
            assert request("/state")[0]["devices"][0]["rules"] == []
            stop(agent)
            before = request("/state")[0]["devices"][0]["lastSeen"]
            (temp / "enroll.txt").unlink()
            agent = start_agent()
            wait(lambda: request("/state")[0]["devices"][0]["lastSeen"] > before)
            state = request("/state")[0]
            assert len(state["devices"]) == 1 and state["devices"][0]["id"] == device["id"]
            assert state["devices"][0]["inspectedAt"] is None
            request("/admin/devices/" + device["id"] + "/revoke", "POST", {})
            last = request("/state")[0]["devices"][0]["lastSeen"]
            assert agent.wait(timeout=8) == 1, "Revoked worker must stop with an error, preserving state"
            assert request("/state")[0]["devices"][0]["lastSeen"] == last
            print("PASS .NET Linux worker: enrollment → polling → dry-run rejected as QoS success → persistent identity/token/outbox → process restart → revocation; no Windows operations")
        except Exception:
            log.flush()
            log.seek(0)
            print(log.read())
            raise
        finally:
            stop(agent)
            stop(api)
            log.close()


if __name__ == "__main__":
    run()
