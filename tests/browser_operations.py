"""Real private DEMO API/SQLite + Chromium; backups and restore drills, no Windows."""
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_smoke import contrast_issues

ROOT = Path(__file__).resolve().parents[1]
URL = 'http://127.0.0.1:3113'


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
        try:
            for width in [1512, 390]:
                with tempfile.TemporaryDirectory(prefix='paneltech-operations-browser-') as temporary:
                    directory = Path(temporary)
                    env = dict(os.environ, DB_PATH=str(directory/'demo.sqlite'), PORT='3113', ENABLE_REAL_AGENTS='0', AUTO_BACKUP='0', BACKUP_KEEP='2', BACKUP_DIRECTORY=str(directory/'backups'))
                    with open(directory/'api.log', 'w+') as log:
                        server = subprocess.Popen(['node', '--import', 'tsx', 'server/index.ts'], cwd=ROOT, env=env, stdout=log, stderr=log)
                        context = browser.new_context(viewport={'width': width, 'height': 982 if width > 700 else 844})
                        errors = []
                        context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
                        try:
                            for _ in range(100):
                                try:
                                    urllib.request.urlopen(URL+'/api/health', timeout=1).close()
                                    break
                                except OSError:
                                    if server.poll() is not None:
                                        raise AssertionError('Fixture server exited')
                                    time.sleep(.1)
                            page = context.new_page()
                            page.goto(URL)
                            page.get_by_role('button', name='Войти в панель').click()
                            page.get_by_role('button', name='Сервер', exact=True).click()
                            panel = page.get_by_role('region', name='Состояние сервера')
                            expect(panel.get_by_text('Автоматическое расписание выключено;', exact=False)).to_be_visible()
                            button = panel.get_by_role('button', name='Создать и проверить копию')
                            expect(button).to_be_enabled()
                            # A lost response commits exactly once. Client offers status checking, no POST replay.
                            posts = []
                            def lose_response(route):
                                posts.append(route.request.post_data)
                                route.fetch()
                                route.abort('failed')
                            page.route('**/api/admin/operations/backup', lose_response)
                            button.click()
                            expect(panel.get_by_role('alert')).to_contain_text('проверьте состояние копирования')
                            expect(panel.get_by_role('alert')).to_be_focused()
                            page.unroute('**/api/admin/operations/backup', lose_response)
                            expect(panel.get_by_text('Восстановление в отдельную временную БД проверено:', exact=False)).to_be_visible(timeout=15000)
                            assert len(posts) == 1
                            response = page.request.get(URL+'/api/admin/operations')
                            assert response.ok
                            status = response.json()
                            assert status['backup']['count'] == 1
                            assert status['backup']['latest']['drill']['checkedAt'] > 0
                            assert str(directory) not in response.text()
                            root = next((directory/'backups').iterdir())
                            assert len(list(root.glob('backup-*'))) == 1
                            assert not list(root.glob('.drill-*'))
                            # Existing lock is a real filesystem failure, not a fabricated HTTP response.
                            (root/'.running.lock').write_text('CANARY_SECRET')
                            expect(button).to_be_enabled()
                            button.click()
                            expect(panel.get_by_text('Каталог занят другим процессом', exact=False)).to_be_visible(timeout=15000)
                            assert len(list(root.glob('backup-*'))) == 1
                            assert 'CANARY_SECRET' not in page.locator('body').inner_text()
                            (root/'.running.lock').unlink()
                            button.click()
                            expect(panel.get_by_text('Каталог занят другим процессом', exact=False)).to_have_count(0, timeout=15000)
                            deadline = time.monotonic()+15
                            while time.monotonic() < deadline:
                                state = page.request.get(URL+'/api/admin/operations').json()
                                if state['backup']['count'] == 2 and state['backup']['phase'] == 'idle':
                                    break
                                page.wait_for_timeout(200)
                            assert state['backup']['count'] == 2
                            panel.get_by_role('button', name='Обновить состояние').click()
                            expect(button).to_be_enabled()
                            assert not contrast_issues(page)
                            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                            (ROOT/'test-results').mkdir(exist_ok=True)
                            page.screenshot(path=str(ROOT/f'test-results/server-operations-{width}.png'), full_page=True)
                            # Failed GET keeps the last snapshot and disables manual creation.
                            page.route('**/api/admin/operations', lambda route: route.abort('failed'))
                            panel.get_by_role('button', name='Обновить состояние').click()
                            expect(panel.get_by_text('Последний снимок.', exact=False)).to_be_visible()
                            expect(button).to_be_disabled()
                            page.unroute('**/api/admin/operations')
                            panel.get_by_role('button', name='Обновить состояние').click()
                            expect(button).to_be_enabled()
                            operator = browser.new_context()
                            op = operator.new_page()
                            op.goto(URL)
                            op.get_by_label('Логин', exact=True).fill('operator')
                            op.get_by_label('Пароль', exact=True).fill('DemoOperator-2026!')
                            op.get_by_role('button', name='Войти в панель').click()
                            expect(op.get_by_role('button', name='Компьютеры', exact=True)).to_be_visible()
                            expect(op.get_by_role('button', name='Сервер', exact=True)).to_have_count(0)
                            assert op.request.get(URL+'/api/admin/operations').status == 403
                            operator.close()
                            assert errors == [], errors
                            print(f'PASS operations {width}: real backup/restore, lost reply, lock/retry, stale snapshot, roles, contrast')
                        finally:
                            context.close()
                            server.terminate()
                            server.wait(timeout=15)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
