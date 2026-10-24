"""Admin errors/empty catalog against real API + temporary seeded SQLite; no real PCs."""
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
URL = 'http://127.0.0.1:3102'


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
        try:
            for width in [1512, 390]:
                with tempfile.TemporaryDirectory(prefix='paneltech-admin-') as temp:
                    env = dict(os.environ, DB_PATH=str(Path(temp)/'demo.sqlite'), PORT='3102', ENABLE_REAL_AGENTS='0')
                    # Seed once, then remove games before starting the unmodified real server.
                    subprocess.run(['node','--import','tsx','--input-type=module','-e',
                        "import {Store} from './server/store.ts';import {Core} from './server/core.ts';const s=new Store(process.env.DB_PATH);new Core(s).seed();for(const g of s.all('game'))s.del('game',g.id);s.close();"], cwd=ROOT, env=env, check=True, capture_output=True)
                    with open(Path(temp)/'api.log','w+') as log:
                        server = subprocess.Popen(['node','--import','tsx','server/index.ts'], cwd=ROOT, env=env, stdout=log, stderr=log)
                        context = browser.new_context(viewport={'width':width,'height':982 if width>700 else 844})
                        errors = []
                        context.on('page', lambda page: page.on('pageerror', lambda e: errors.append(str(e))))
                        try:
                            for _ in range(100):
                                try:
                                    urllib.request.urlopen(URL+'/api/health',timeout=1).close()
                                    break
                                except OSError:
                                    if server.poll() is not None:
                                        raise AssertionError('Fixture server exited')
                                    time.sleep(.1)
                            page = context.new_page()
                            page.goto(URL)
                            page.get_by_role('button',name='Войти в панель').click()
                            expect(page.get_by_text('Каталог игр пуст',exact=True)).to_be_visible()
                            page.get_by_role('checkbox',name='Выбрать ПК-01',exact=True).check()
                            for name in ['Применить к 1 ПК','Удалить правила игры','Инспекция','Проверка агента']:
                                expect(page.get_by_role('button',name=name,exact=name!='Применить к 1 ПК')).to_be_disabled()
                            assert page.request.get(URL+'/api/history').json()['items'] == []
                            assert not contrast_issues(page)
                            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                            (ROOT/'test-results').mkdir(exist_ok=True)
                            page.screenshot(path=str(ROOT/f'test-results/empty-catalog-{width}.png'),full_page=True)
                            # Operator has a clear empty state and no administration controls.
                            operator_context = browser.new_context(viewport={'width':width,'height':844})
                            op = operator_context.new_page()
                            op.goto(URL)
                            op.get_by_label('Логин',exact=True).fill('operator')
                            op.get_by_label('Пароль',exact=True).fill('DemoOperator-2026!')
                            op.get_by_role('button',name='Войти в панель').click()
                            expect(op.get_by_text('Попросите администратора добавить игру и её exe.')).to_be_visible()
                            expect(op.get_by_role('button',name='Добавить игру',exact=True)).to_have_count(0)
                            expect(op.locator('form[aria-label="Карточка игры"], form[aria-label="Клуб и варианты"], form[aria-label="Новый сотрудник"]')).to_have_count(0)
                            operator_context.close()
                            page.get_by_role('button',name='Добавить игру',exact=True).click()
                            expect(page.get_by_text('Игр пока нет.',exact=False)).to_be_visible()
                            game = page.get_by_role('form',name='Карточка игры')
                            game.get_by_role('button',name='Сохранить игру').click()
                            expect(game.get_by_role('alert')).to_have_text('Введите название.')
                            expect(game.get_by_role('alert')).to_be_focused()
                            game.get_by_label('Название',exact=True).fill('Тестовая игра')
                            game.get_by_role('textbox',name='Имена exe').fill('C:\\game.exe')
                            game.get_by_role('button',name='Сохранить игру').click()
                            expect(game.get_by_role('alert')).to_contain_text('без путей')
                            expect(game.get_by_role('textbox',name='Имена exe')).to_have_value('C:\\game.exe')
                            game.get_by_role('textbox',name='Имена exe').fill('game.exe\nGAME.exe')
                            game.get_by_role('button',name='Сохранить игру').click()
                            expect(game.get_by_role('alert')).to_contain_text('не должны повторяться')
                            game.get_by_role('textbox',name='Имена exe').fill('game.exe')
                            writes = []
                            def lost_response(route):
                                if route.request.method == 'POST':
                                    writes.append(route.request.post_data)
                                    route.fetch()  # API commits, browser loses only the response.
                                    route.abort('failed')
                                else:
                                    route.continue_()
                            page.route('**/api/admin/games',lost_response)
                            game.get_by_role('button',name='Сохранить игру').click()
                            expect(game.get_by_role('alert')).to_contain_text('могло быть выполнено')
                            expect(game.get_by_label('Название',exact=True)).to_have_value('Тестовая игра')
                            expect(page.locator('.catalog-item').filter(has_text='Тестовая игра')).to_have_count(1,timeout=10000)
                            assert len(writes)==1, 'No automatic retry after ambiguous save'
                            page.unroute('**/api/admin/games',lost_response)
                            game.get_by_role('button',name='Новая карточка').click()
                            expect(game.get_by_role('alert')).to_have_count(0)
                            page.get_by_role('button',name='Управление',exact=True).click()
                            club = page.get_by_role('form',name='Клуб и варианты')
                            expect(page.get_by_role('button',name='Сменить токен ПК-01')).to_be_disabled()
                            expect(page.get_by_role('button',name='Восстановить доступ ПК-01')).to_be_disabled()
                            club.get_by_label('Название',exact=True).fill('Тестовый клуб')
                            for value, message in [('36','формат ID:название'),('64:Нет','от 0 до 63'),('36:A\n36:B','не должны повторяться')]:
                                club.get_by_role('textbox',name='Варианты, ID:название').fill(value)
                                club.get_by_role('button',name='Сохранить клуб').click()
                                expect(club.get_by_role('alert')).to_contain_text(message)
                            club.get_by_role('textbox',name='Варианты, ID:название').fill('0:Без маркировки\n63:Максимум')
                            # Distinguish a committed write from a failed follow-up list refresh.
                            club_writes = []
                            def saved_without_refresh(route):
                                club_writes.append(route.request.method)
                                response = route.fetch()
                                assert response.status == 201
                                page.route('**/api/state*',lambda state: state.fulfill(status=503,json={'message':'Unavailable'}),times=1)
                                route.fulfill(response=response)
                            page.route('**/api/admin/clubs',saved_without_refresh)
                            club.get_by_role('button',name='Сохранить клуб').click()
                            expect(club.get_by_role('heading',name='Изменить клуб')).to_be_visible()
                            expect(page.get_by_role('alert').filter(has_text='Изменения сохранены, но обновить список не удалось')).to_be_visible()
                            expect(page.locator('.connection-status')).to_contain_text('API подключён',timeout=8000)
                            page.unroute('**/api/admin/clubs')
                            assert club_writes == ['POST'], 'No replay after a committed write with failed GET'
                            club.get_by_role('button',name='Сохранить клуб').click()
                            expect(page.locator('.clubs button').filter(has_text='Тестовый клуб')).to_have_count(1)
                            club.get_by_role('button',name='Новый',exact=True).click()
                            expect(club.get_by_role('textbox',name='Варианты, ID:название')).to_have_value('36:Вариант 36\n40:Вариант 40')
                            employee = page.get_by_role('form',name='Новый сотрудник')
                            # Moving cached forms between tabs must not reset unsaved fields.
                            club.get_by_label('Название',exact=True).fill('Черновик клуба при навигации')
                            employee.get_by_label('Логин',exact=True).fill('draft_staff')
                            employee.get_by_label('Пароль, минимум 12 символов').fill('DraftPassword-2026!')
                            page.get_by_role('button',name='Каталог игр',exact=True).click()
                            game.get_by_label('Название',exact=True).fill('Черновик игры при навигации')
                            game.get_by_role('textbox',name='Имена exe').fill('draft.exe')
                            page.get_by_role('button',name='Управление',exact=True).click()
                            expect(club.get_by_label('Название',exact=True)).to_have_value('Черновик клуба при навигации')
                            expect(employee.get_by_label('Логин',exact=True)).to_have_value('draft_staff')
                            expect(employee.get_by_label('Пароль, минимум 12 символов')).to_have_value('DraftPassword-2026!')
                            page.get_by_role('button',name='Каталог игр',exact=True).click()
                            expect(game.get_by_label('Название',exact=True)).to_have_value('Черновик игры при навигации')
                            expect(game.get_by_role('textbox',name='Имена exe')).to_have_value('draft.exe')
                            page.get_by_role('button',name='Управление',exact=True).click()
                            club.get_by_role('button',name='Новый',exact=True).click()
                            employee.get_by_label('Логин',exact=True).fill('ab')
                            employee.get_by_label('Пароль, минимум 12 символов').fill('short')
                            employee.get_by_role('button',name='Создать пользователя').click()
                            expect(employee.get_by_role('alert')).to_contain_text('Логин:')
                            employee.get_by_label('Логин',exact=True).fill('admin')
                            employee.get_by_role('button',name='Создать пользователя').click()
                            expect(employee.get_by_role('alert')).to_contain_text('Пароль должен')
                            employee.get_by_label('Пароль, минимум 12 символов').fill('TestPassword-2026!')
                            employee.get_by_role('button',name='Создать пользователя').click()
                            expect(employee.get_by_role('alert')).to_have_text('Логин занят')  # Real API 409.
                            expect(employee.get_by_label('Пароль, минимум 12 символов')).to_have_value('TestPassword-2026!')
                            employee.get_by_label('Логин',exact=True).fill('colleague')
                            employee.get_by_role('button',name='Создать пользователя').click()
                            expect(page.locator('.user-row').filter(has_text='colleague')).to_have_count(1)
                            expect(employee.get_by_label('Пароль, минимум 12 символов')).to_have_value('')
                            # Reachable 403 preserves the unsaved user draft and gives local feedback.
                            row = page.locator('.user-row').filter(has_text='colleague')
                            page.route('**/api/admin/users/*',lambda route: route.fulfill(status=403,json={'message':'Требуется администратор'}))
                            row.get_by_role('combobox').select_option('admin')
                            row.get_by_role('button',name='Сохранить',exact=True).click()
                            expect(page.locator('#users-error')).to_have_text('Требуется администратор')
                            page.unroute('**/api/admin/users/*')
                            # GET list error has an explicit retry; not an empty successful list.
                            page.route('**/api/admin/users',lambda route: route.fulfill(status=403,json={'message':'Список сотрудников недоступен'}))
                            page.get_by_role('button',name='Каталог игр',exact=True).click()
                            page.get_by_role('button',name='Управление',exact=True).click()
                            expect(page.get_by_role('button',name='Повторить загрузку сотрудников')).to_be_visible()
                            page.unroute('**/api/admin/users')
                            page.get_by_role('button',name='Повторить загрузку сотрудников').click()
                            expect(page.get_by_role('button',name='Повторить загрузку сотрудников')).to_have_count(0)
                            # 503 on a write keeps draft and disables other writes until polling recovers.
                            def unavailable_club(route):
                                page.route('**/api/state*',lambda state: state.abort('failed'))
                                route.fulfill(status=503,json={'message':'Unavailable'})
                            page.route('**/api/admin/clubs',unavailable_club)
                            club.get_by_label('Название',exact=True).fill('Сохранить черновик')
                            club.get_by_role('button',name='Сохранить клуб').click()
                            expect(club.get_by_role('alert')).to_contain_text('могло быть выполнено')
                            expect(club.get_by_label('Название',exact=True)).to_have_value('Сохранить черновик')
                            for button in [club.get_by_role('button',name='Сохранить клуб'),employee.get_by_role('button',name='Создать пользователя'),row.get_by_role('button',name='Сохранить',exact=True)]:
                                expect(button).to_be_disabled()
                            page.unroute('**/api/admin/clubs')
                            page.unroute('**/api/state*')
                            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Page overflow'
                            issues=contrast_issues(page)
                            assert not issues, issues[:10]
                            (ROOT/'test-results').mkdir(exist_ok=True)
                            page.screenshot(path=str(ROOT/f'test-results/admin-{width}.png'),full_page=True)
                            page.get_by_role('button',name='Компьютеры',exact=True).click()
                            expect(page.get_by_role('button',name='Применить к 1 ПК')).to_be_enabled()
                            # A lost session clears sensitive drafts before another login.
                            page.get_by_role('button',name='Управление',exact=True).click()
                            employee.get_by_label('Пароль, минимум 12 символов').fill('TransientSecret-2026!')
                            employee.get_by_label('Логин',exact=True).fill('another')
                            page.route('**/api/admin/users',lambda route: route.fulfill(status=401,json={'message':'Войдите в панель'}))
                            employee.get_by_role('button',name='Создать пользователя').click()
                            expect(page.get_by_role('button',name='Войти в панель')).to_be_visible()
                            expect(page.get_by_role('alert')).to_have_text('Войдите в панель')
                            page.unroute('**/api/admin/users')
                            page.get_by_label('Пароль',exact=True).fill('DemoAdmin-2026!')
                            page.get_by_role('button',name='Войти в панель').click()
                            page.get_by_role('button',name='Управление',exact=True).click()
                            expect(page.get_by_role('form',name='Новый сотрудник').get_by_label('Пароль, минимум 12 символов')).to_have_value('')
                            expect(employee.get_by_label('Логин',exact=True)).to_have_value('')
                            expect(club.get_by_label('Название',exact=True)).to_have_value('')
                            page.get_by_role('button',name='Каталог игр',exact=True).click()
                            expect(game.get_by_label('Название',exact=True)).to_have_value('')
                            expect(game.get_by_role('textbox',name='Имена exe')).to_have_value('')
                            assert not errors, errors
                        finally:
                            context.close()
                            server.terminate()
                            try:
                                server.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                server.kill();server.wait()
            print('PASS admin Chromium desktop/mobile: real empty catalog, validation, API 409, lost POST, no replay, draft retention, retry, permissions and layout')
        finally:
            browser.close()


if __name__=='__main__':
    run()
