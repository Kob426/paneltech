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


def contrast_issues(page):
    """Check visible DOM text against its resolved solid background, not a full WCAG audit."""
    return page.evaluate(r"""() => {
      const rgba = s => (s.match(/[\d.]+/g) || []).map(Number);
      const over = (f,b) => { const a=f[3] ?? 1; return [0,1,2].map(i=>f[i]*a+b[i]*(1-a)); };
      const luminance = c => c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
      const issues=[]; const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      while(walk.nextNode()) {
        const node=walk.currentNode, text=node.textContent.trim(), el=node.parentElement;
        if(!text || !el || !el.getClientRects().length || el.closest(':disabled,[aria-hidden="true"],.brand-mark,script,style')) continue;
        const style=getComputedStyle(el);
        if(style.visibility!=='visible' || style.display==='none') continue;
        const ancestors=[]; for(let p=el;p;p=p.parentElement) ancestors.unshift(p);
        let bg=[255,255,255]; for(const p of ancestors) bg=over(rgba(getComputedStyle(p).backgroundColor),bg);
        const fg=over(rgba(style.color),bg), a=luminance(fg), b=luminance(bg), ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        const size=parseFloat(style.fontSize), weight=parseFloat(style.fontWeight), minimum=size>=24||(size>=18.66&&weight>=700)?3:4.5;
        if(ratio+.01<minimum) issues.push({text:text.slice(0,60),ratio:Math.round(ratio*100)/100,minimum,color:style.color,bg,fontSize:style.fontSize});
      }
      return issues;
    }""")


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
                trigger = page.get_by_role("button", name="Применить к 6 ПК")
                trigger.click()
                dialog = page.get_by_role("dialog")
                expect(dialog).to_be_visible()
                cancel = dialog.get_by_role("button", name="Отмена", exact=True)
                submit = dialog.get_by_role("button", name="Запустить для 6 ПК")
                expect(cancel).to_be_focused()
                page.keyboard.press("Shift+Tab")
                expect(submit).to_be_focused()
                page.keyboard.press("Tab")
                expect(cancel).to_be_focused()
                page.keyboard.press("Escape")
                expect(dialog).not_to_be_visible()
                expect(trigger).to_be_focused()
                assert page.request.get(URL + "/api/history").json() == [], "Escape must not submit a job"
                trigger.click()
                page.keyboard.press("Enter")  # Cancel receives initial focus, so Enter is safe.
                expect(dialog).not_to_be_visible()
                expect(trigger).to_be_focused()
                assert page.request.get(URL + "/api/history").json() == []
                trigger.click()
                expect(dialog).to_be_visible()
                expect(page.get_by_role("dialog")).to_contain_text("Аврора")
                page.get_by_role("button", name="Запустить для 6 ПК").click()
                success = page.locator("article.job").filter(has_text="DEMO: правила симулятора применены.")
                expect(success).to_have_count(1)
                expect(trigger).to_be_focused()
                assert not contrast_issues(page)
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
                # A late answer for a previous filter must not replace the current filter's rows.
                held = []
                def delay_old_history(route):
                    if "deviceId=aurora-1" in route.request.url:
                        held.append(route)
                    else:
                        route.continue_()
                page.route("**/api/history?**", delay_old_history)
                page.locator(".filters select").nth(0).select_option("aurora-1")
                expect(page.locator("tbody")).to_contain_text("Загрузка истории")
                page.locator(".filters select").nth(0).select_option("aurora-2")
                expect(page.locator("tbody")).to_contain_text("ПК-02")
                assert held, "Expected delayed old-filter request"
                with page.expect_response(lambda response: "deviceId=aurora-1" in response.url):
                    for route in held:
                        route.continue_()
                expect(page.locator("tbody")).to_contain_text("ПК-02")
                expect(page.locator("tbody")).not_to_contain_text("ПК-01")
                page.unroute("**/api/history?**", delay_old_history)
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
                expect(page.locator(".connection-status")).to_have_text("API недоступен", timeout=12000)
                expect(page.locator(".connection-warning")).to_contain_text("последний загруженный снимок")
                start()
                expect(page.locator(".connection-status")).to_have_text("API подключён", timeout=12000)
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
                # Explicit residual-rules scenario: failure, no feedback form, persisted history.
                page.get_by_label("Сценарий ПК-01", exact=True).select_option("rollback_failed")
                page.get_by_role("button", name="Применить к 1 ПК").click()
                residual = page.locator("article.job").filter(has_text="DEMO: частичный сбой, откат не выполнен.")
                expect(residual).to_have_count(1)
                expect(residual.locator(".badge")).to_have_text("Ошибка")
                expect(residual.locator(".rollback-failed")).to_contain_text("остаточный набор")
                expect(residual.locator(".feedback")).to_have_count(0)
                expect(page.locator("tbody tr").first).to_contain_text("Правил: 1")
                # The POST reaches the API but its response is lost: never replay it automatically.
                page.get_by_label("Сценарий ПК-01", exact=True).select_option("success")
                before_lost = len(page.request.get(URL + "/api/history").json())
                delivered_posts = []
                def lose_post_response(route):
                    delivered_posts.append(route.request.url)
                    response = route.fetch()
                    assert response.status == 201
                    route.abort()
                page.route("**/api/jobs", lose_post_response)
                page.get_by_role("button", name="Применить к 1 ПК").click()
                expect(page.get_by_role("alert")).to_contain_text("Действие могло быть выполнено")
                expect(page.locator(".connection-status")).to_have_text("API подключён", timeout=12000)
                page.unroute("**/api/jobs", lose_post_response)
                assert len(delivered_posts) == 1
                assert len(page.request.get(URL + "/api/history").json()) == before_lost + 1
                # Prevent action submission while state polling is unavailable; recover via GET only.
                before = len(page.request.get(URL + "/api/history").json())
                page.route("**/api/state", lambda route: route.abort())
                expect(page.locator(".connection-status")).to_have_text("API недоступен", timeout=12000)
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_disabled()
                expect(page.get_by_role("button", name="Инспекция", exact=True)).to_be_disabled()
                assert len(page.request.get(URL + "/api/history").json()) == before
                # Hold the next GET to observe reconnecting before a confirmed successful response.
                page.unroute("**/api/state")
                paused = []
                page.route("**/api/state", lambda route: paused.append(route))
                expect(page.locator(".connection-status")).to_have_text("Восстановление связи с API", timeout=12000)
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_disabled()
                for route in paused[:]:
                    route.continue_()
                page.unroute("**/api/state")
                expect(page.locator(".connection-status")).to_have_text("API подключён", timeout=12000)
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_enabled()
                page.get_by_role("button", name="История", exact=True).click()
                expect(page.locator("tbody")).to_contain_text("откат не выполнен")
                page.get_by_role("button", name="Компьютеры", exact=True).click()
                # Long catalog labels and an empty club/history must fit and remain usable.
                admin_context = browser.new_context()
                admin = admin_context.request
                auth = admin.post(URL + "/api/login", data={"username":"admin", "password":"DemoAdmin-2026!"}).json()
                csrf_headers = {"X-CSRF-Token":auth["csrf"]}
                state = admin.get(URL + "/api/state").json()
                aurora = next(c for c in state["clubs"] if c["id"] == "aurora")
                long_club = "Аврора · DEMO — " + "К" * 64
                assert admin.put(URL + "/api/admin/clubs/aurora", headers=csrf_headers, data={"name":long_club,"variants":aurora["variants"]}).status == 200
                original_game = next(g for g in state["games"] if g["id"] == "fortnite")
                assert admin.put(URL + "/api/admin/games/fortnite", headers=csrf_headers, data={"name":"Fortnite — " + "Д" * 70,"exes":original_game["exes"]}).status == 200
                assert admin.post(URL + "/api/admin/clubs", headers=csrf_headers, data={"name":"Пустой тестовый клуб","variants":[{"id":36,"name":"Тестовый вариант"}]}).status == 201
                expect(page.get_by_role("heading", name=long_club, exact=True)).to_be_visible(timeout=10000)
                page.locator(".clubs button").filter(has_text="Пустой тестовый клуб").click()
                expect(page.locator("tbody")).to_contain_text("В клубе нет зарегистрированных ПК")
                expect(page.get_by_role("button", name="Применить к 0 ПК")).to_be_disabled()
                page.get_by_role("button", name="История", exact=True).click()
                expect(page.locator("tbody")).to_contain_text("По этим фильтрам операций нет")
                page.locator(".clubs button").filter(has_text="Аврора · DEMO").click()
                page.get_by_role("button", name="Компьютеры", exact=True).click()
                page.get_by_role("checkbox", name="Выбрать ПК-01", exact=True).check()
                # Unknown uses the delivered snapshot, even if both game and club change.
                created = admin.post(URL + "/api/jobs", headers=csrf_headers, data={"deviceIds":["aurora-5"],"gameId":"fortnite","operation":"apply_marking","variant":36})
                assert created.status == 201
                uncertain = created.json()[0]
                card = page.locator('article.job[data-job-id="' + uncertain['id'] + '"]')
                expect(card.locator(".badge")).to_have_text("Неизвестно", timeout=10000)
                before = next(d for d in admin.get(URL + "/api/state").json()["devices"] if d["id"] == "aurora-5")["rules"]
                assert admin.put(URL + "/api/admin/games/fortnite", headers=csrf_headers, data={"name":"Fortnite — новая ревизия","exes":["NewRevision.exe"]}).status == 200
                assert admin.put(URL + "/api/admin/clubs/aurora", headers=csrf_headers, data={"name":long_club,"variants":[{"id":40,"name":"Остался вариант 40"}]}).status == 200
                expect(page.locator(".action-fields select").first).to_contain_text("новая ревизия", timeout=10000)
                expect(page.locator(".action-fields select").nth(1).locator("option")).to_have_count(1)
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_disabled()
                expect(page.locator("td.recommendation").first).to_contain_text("ревизия изменилась")
                expect(page.locator("td.recommendation").first).to_contain_text("сейчас недоступен")
                blocked = admin.post(URL + "/api/jobs", headers=csrf_headers, data={"deviceIds":["aurora-5"],"gameId":"fortnite","operation":"apply_marking","variant":40}).json()[0]
                assert blocked["code"] == "busy"
                card.get_by_role("button", name="Сверить фактические правила симулятора").click()
                expect(card.locator(".badge")).to_have_text("Выполнено")
                expect(card).to_contain_text(f"по снимку задания r{uncertain['revision']}")
                checked = next(j for j in admin.get(URL + "/api/history").json() if j["id"] == uncertain["id"])
                assert checked["exes"] == uncertain["exes"] and checked["variant"] == 36 and checked["attempts"] == 1
                assert next(d for d in admin.get(URL + "/api/state").json()["devices"] if d["id"] == "aurora-5")["rules"] == before
                # Choosing an available variant is explicit; no automatic restore/new mutation.
                page.locator(".action-fields select").nth(1).select_option("40")
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_enabled()
                admin_context.close()
                # No runtime JS errors; source assets are local.
                assert not errors, errors
                (ROOT / "test-results").mkdir(exist_ok=True)
                issues = contrast_issues(page)
                assert not issues, f"Visible text contrast below WCAG AA: {issues[:12]}"
                page.screenshot(path=str(ROOT / "test-results/dashboard.png"), full_page=True)
                page.set_viewport_size({"width":390,"height":844})
                expect(page.get_by_role("button", name="Применить к 1 ПК")).to_be_visible()
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile viewport has horizontal page overflow"
                assert not contrast_issues(page)
                page.screenshot(path=str(ROOT / "test-results/mobile.png"), full_page=True)
                page.emulate_media(reduced_motion="reduce")
                assert page.get_by_role("button", name="Применить к 1 ПК").evaluate("el => getComputedStyle(el).transitionDuration") == "0s"
                browser.close()
                print("PASS Chromium: modal keyboard/focus/Enter safety; bulk outcomes; stale-history response; feedback across accounts; API loss/reconnect/no mutation replay; residual rollback failure; catalog/variant changes during unknown; reboot; desktop/mobile; no JS errors")
        finally:
            stop()
            log.close()


if __name__ == "__main__":
    run()
