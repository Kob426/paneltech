"""Real Chromium functional smoke. Uses its own temporary SQLite DB and loopback server."""
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PORT = 3099
URL = f"http://127.0.0.1:{PORT}"


def run():
    with tempfile.TemporaryDirectory(prefix="paneltech-browser-") as temp:
        env = dict(os.environ, PORT=str(PORT), DB_PATH=str(Path(temp) / "demo.sqlite"), ENABLE_REAL_AGENTS="0")
        log = open(Path(temp) / "server.log", "w+")
        process = None

        def start():
            nonlocal process
            process = subprocess.Popen(["node", "--import", "tsx", "server/index.ts"], cwd=ROOT, env=env, stdout=log, stderr=log)
            for _ in range(100):
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                try:
                    with urllib.request.urlopen(URL + "/api/health", timeout=1) as response:
                        if response.status == 200:
                            return
                except OSError:
                    time.sleep(0.1)
            raise AssertionError("Server did not start")

        def stop():
            nonlocal process
            if process:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process = None

        start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or shutil.which("chromium"), headless=True, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1512, "height": 982})
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(URL)
                page.get_by_role("button", name="Войти в панель").click()
                expect(page.get_by_role("heading", name="Компьютеры")).to_be_visible()
                page.get_by_role("checkbox", name="Выбрать все ПК", exact=True).check()
                page.get_by_role("button", name="Применить к 6 ПК").click()
                expect(page.get_by_role("dialog")).to_be_visible()
                expect(page.get_by_role("dialog")).to_contain_text("Аврора")
                page.get_by_role("button", name="Запустить для 6 ПК").click()
                success = page.locator("article.job").filter(has_text="DEMO: правила симулятора применены.")
                expect(success).to_have_count(1)
                for snippet in ["Недостаточно", "частичный сбой", "ответ потерян", "Конфликт"]:
                    if snippet == "Недостаточно":
                        snippet = "недостаточно прав"
                    expect(page.locator("article.job").filter(has_text=snippet)).to_have_count(1)
                success.locator("select").nth(0).select_option("helped")
                success.locator("select").nth(1).select_option("voice")
                success.get_by_placeholder("Необязательно").fill("DEMO: ручная отметка из браузерного теста")
                success.get_by_role("button", name="Сохранить отметку").click()
                expect(success).to_contain_text("Отметка: помогло")
                expect(page.locator("td.recommendation").first).to_contain_text("Голосовой чат")
                page.get_by_role("button", name="Сверить фактические правила симулятора").click()
                expect(page.locator("article.job").filter(has_text="выполнена отдельная инспекция")).to_have_count(1)
                page.get_by_role("button", name="История", exact=True).click()
                page.locator(".filters select").nth(0).select_option("aurora-1")
                expect(page.locator("tbody tr")).to_have_count(1)
                expect(page.locator("tbody")).to_contain_text("Помогло")
                # A separate browser account sees server-side feedback.
                page.get_by_role("button", name="Выйти", exact=True).click()
                page.get_by_label("Логин", exact=True).fill("operator")
                page.get_by_label("Пароль", exact=True).fill("DemoOperator-2026!")
                page.get_by_role("button", name="Войти в панель").click()
                expect(page.get_by_role("button", name="Каталог игр", exact=True)).to_have_count(0)
                page.get_by_role("button", name="История", exact=True).click()
                expect(page.locator("tbody")).to_contain_text("Помогло")
                # Restart the actual API process and reuse the persisted session/history.
                stop()
                start()
                page.reload()
                page.get_by_role("button", name="История", exact=True).click()
                expect(page.locator("tbody")).to_contain_text("DEMO: ручная отметка из браузерного теста")
                page.get_by_role("button", name="Компьютеры", exact=True).click()
                pc1 = page.locator("tbody tr").first
                pc1.get_by_role("button", name="Имитировать перезагрузку").click()
                expect(pc1).to_contain_text("Кэш правил: 0")
                expect(pc1.locator("td.recommendation")).to_contain_text("Голосовой чат")
                page.get_by_role("checkbox", name="Выбрать ПК-01", exact=True).check()
                page.locator(".action-fields select").first.select_option("pubg")
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_disabled()
                page.locator(".action-fields select").first.select_option("fortnite")
                assert page.locator(".action-fields select").nth(1).locator("option").all_text_contents() == ["Вариант 36 · 36", "Вариант 40 · 40"]
                # No external resources and no runtime JS errors.
                assert not errors, errors
                (ROOT / "test-results").mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT / "test-results/dashboard.png"), full_page=True)
                page.set_viewport_size({"width":390,"height":844})
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_visible()
                page.screenshot(path=str(ROOT / "test-results/mobile.png"), full_page=True)
                browser.close()
                print("PASS Chromium: login → bulk → six outcomes → feedback → reconciliation → shared history → API restart → reboot → validation; desktop/mobile; no JS errors")
        finally:
            stop()
            log.close()


if __name__ == "__main__":
    run()
