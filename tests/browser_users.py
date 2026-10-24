"""Private local owner and employee password flow; isolated SQLite and loopback only."""
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_smoke import contrast_issues

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:3104'
OWNER='OwnerBrowserFixture-2026!'
OLD='StaffBrowserFixture-2026!'
NEW='ChangedBrowserFixture-2026!'
LAST='LastBrowserFixture-2026!'


def login(page,name,password):
    page.goto(URL)
    page.get_by_label('Логин',exact=True).fill(name)
    page.get_by_label('Пароль',exact=True).fill(password)
    page.get_by_role('button',name='Войти в панель').click()


def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-users-') as temp:
        env=dict(os.environ,DB_PATH=str(Path(temp)/'local.sqlite'),PORT='3104',ENABLE_REAL_AGENTS='0',FIXTURE_OWNER_PASSWORD=OWNER)
        subprocess.run(['node','--import','tsx','--input-type=module','-e',"import {Store} from './server/store.ts';import {initializeLocalOwner} from './server/local-owner.ts';const s=new Store(process.env.DB_PATH);initializeLocalOwner(s,'chief',process.env.FIXTURE_OWNER_PASSWORD);s.close();"],cwd=ROOT,env=env,check=True,capture_output=True)
        with open(Path(temp)/'server.log','w+') as log:
            process=subprocess.Popen(['node','--import','tsx','server/index.ts','--local'],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(URL+'/api/health',timeout=1).close();break
                    except OSError:
                        if process.poll() is not None:raise AssertionError('Private fixture server exited')
                        time.sleep(.1)
                else:raise AssertionError('Private fixture server did not start')
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
                    owner=browser.new_context(viewport={'width':1512,'height':982})
                    employee=browser.new_context()
                    page=owner.new_page();staff=employee.new_page();errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    try:
                        page.route('**/api/health',lambda route:route.abort('failed'))
                        page.goto(URL)
                        expect(page.get_by_role('alert')).to_be_visible()
                        expect(page.get_by_text('Демонстрационные учётные записи')).to_have_count(0)
                        expect(page.get_by_label('Пароль',exact=True)).to_have_value('')
                        page.unroute('**/api/health')
                        expect(page.get_by_text('Личные учётные записи:',exact=False)).to_be_visible(timeout=10000)
                        expect(page.get_by_label('Логин',exact=True)).to_have_value('')
                        expect(page.get_by_label('Пароль',exact=True)).to_have_value('')
                        expect(page.get_by_text('Демонстрационные учётные записи')).to_have_count(0)
                        login(page,'chief',OWNER)
                        page.get_by_role('button',name='Управление',exact=True).click()
                        form=page.get_by_role('form',name='Новый сотрудник')
                        form.get_by_label('Логин',exact=True).fill('staff')
                        form.get_by_label('Пароль, минимум 12 символов').fill(OLD)
                        form.get_by_role('button',name='Создать пользователя').click()
                        row=page.locator('.user-row').filter(has_text='staff')
                        expect(row).to_have_count(1)
                        login(staff,'staff',OLD)
                        expect(staff.get_by_role('heading',name='Компьютеры')).to_be_visible()
                        expect(staff.get_by_role('button',name='Управление',exact=True)).to_have_count(0)
                        reset_requests=[]
                        page.on('request',lambda r:reset_requests.append(r.url) if r.method=='POST' and r.url.endswith('/password') else None)
                        trigger=row.get_by_role('button',name='Сбросить пароль staff',exact=True)
                        trigger.click()
                        dialog=page.get_by_role('dialog',name='Сброс пароля: staff')
                        cancel=dialog.get_by_role('button',name='Отмена',exact=True)
                        expect(cancel).to_be_focused()
                        page.keyboard.press('Enter')
                        expect(dialog).not_to_be_visible();expect(trigger).to_be_focused();assert not reset_requests
                        trigger.click()
                        expect(dialog.get_by_role('button',name='Сменить пароль')).to_be_disabled()
                        page.keyboard.press('Tab')
                        expect(dialog.get_by_label('Новый пароль',exact=True)).to_be_focused()
                        page.keyboard.press('Shift+Tab')
                        expect(cancel).to_be_focused()
                        (ROOT/'test-results').mkdir(exist_ok=True)
                        assert not contrast_issues(page)
                        dialog.screenshot(path=str(ROOT/'test-results/password-reset-desktop.png'))
                        page.set_viewport_size({'width':390,'height':844})
                        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                        dialog.screenshot(path=str(ROOT/'test-results/password-reset-mobile.png'))
                        page.set_viewport_size({'width':1512,'height':982})
                        dialog.get_by_label('Новый пароль',exact=True).fill('short')
                        dialog.get_by_label('Повторите новый пароль').fill('short')
                        dialog.get_by_role('checkbox').check()
                        dialog.get_by_role('button',name='Сменить пароль').click()
                        expect(dialog.get_by_role('alert')).to_contain_text('от 12 до 200')
                        expect(dialog.get_by_role('alert')).to_be_focused();assert not reset_requests
                        dialog.get_by_label('Новый пароль',exact=True).fill(NEW)
                        dialog.get_by_label('Повторите новый пароль').fill(OLD)
                        dialog.get_by_role('button',name='Сменить пароль').click()
                        expect(dialog.get_by_role('alert')).to_have_text('Пароли не совпали.')
                        page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
                        trigger.click();expect(dialog.get_by_label('Новый пароль',exact=True)).to_have_value('')
                        dialog.get_by_label('Новый пароль',exact=True).fill(NEW)
                        dialog.get_by_label('Повторите новый пароль').fill(NEW)
                        dialog.get_by_role('checkbox').check()
                        dialog.get_by_role('button',name='Сменить пароль').click()
                        expect(dialog).not_to_be_visible()
                        expect(trigger).to_be_focused()
                        expect(page.get_by_role('status').filter(has_text='Прежние сеансы завершены')).to_be_visible()
                        expect(staff.get_by_role('button',name='Войти в панель')).to_be_visible(timeout=10000)
                        assert employee.request.post(URL+'/api/login',data={'username':'staff','password':OLD}).status==401
                        login(staff,'staff',NEW)
                        expect(staff.get_by_role('heading',name='Компьютеры')).to_be_visible()
                        assert len(reset_requests)==1
                        # Even a locally edited role must not be saved as a side effect of resetting a password.
                        row.get_by_role('combobox').select_option('admin')
                        trigger.click()
                        dialog.get_by_label('Новый пароль',exact=True).fill(LAST)
                        dialog.get_by_label('Повторите новый пароль').fill(LAST)
                        dialog.get_by_role('checkbox').check()
                        def lose_response(route):
                            response=route.fetch();assert response.status==200;route.abort('failed')
                        page.route('**/api/admin/users/*/password',lose_response)
                        dialog.get_by_role('button',name='Сменить пароль').click()
                        expect(dialog.get_by_role('alert')).to_contain_text('могло быть выполнено')
                        expect(dialog.get_by_label('Новый пароль',exact=True)).to_have_value('')
                        expect(dialog.get_by_label('Повторите новый пароль')).to_have_value('')
                        assert len(reset_requests)==2,'An ambiguous password reset must never replay automatically'
                        page.unroute('**/api/admin/users/*/password')
                        listed=owner.request.get(URL+'/api/admin/users').json()
                        target=next(u for u in listed if u['username']=='staff')
                        assert target['role']=='operator' and not target['disabled'] and 'password' not in target
                        assert employee.request.post(URL+'/api/login',data={'username':'staff','password':LAST}).status==200
                        cancel.click();expect(dialog).not_to_be_visible()
                        # Reload authoritative role then disable staff using the existing UI.
                        page.get_by_role('button',name='Каталог игр',exact=True).click()
                        page.get_by_role('button',name='Управление',exact=True).click()
                        expect(row.get_by_role('combobox')).to_have_value('operator')
                        row.get_by_role('checkbox').check()
                        row.get_by_role('button',name='Сохранить',exact=True).click()
                        expect(staff.get_by_role('button',name='Войти в панель')).to_be_visible(timeout=10000)
                        assert employee.request.post(URL+'/api/login',data={'username':'staff','password':LAST}).status==401
                        expect(page.locator('.user-row').filter(has_text='chief').get_by_role('button',name='Сбросить пароль chief')).to_be_disabled()
                        assert not errors,errors
                        print('PASS private owner browser: create staff, separate login, confirmed reset, revoked session, cancellation/focus, lost response without replay, unchanged role, disable, desktop/mobile')
                    finally:
                        owner.close();employee.close();browser.close()
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            log.seek(0);contents=log.read()
            for secret in [OWNER,OLD,NEW,LAST]:assert secret not in contents

if __name__=='__main__':run()
