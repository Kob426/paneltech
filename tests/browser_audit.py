"""Two independent admins, real API/SQLite, conflicts and append-only audit; Linux DEMO only."""
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_smoke import contrast_issues
ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:3108'
SECRET='BrowserAudit-Password-2026!'
def login(page,name,secret):
    page.goto(URL)
    page.get_by_label('Логин',exact=True).fill(name)
    page.get_by_label('Пароль',exact=True).fill(secret)
    page.get_by_role('button',name='Войти в панель').click()
    expect(page.get_by_role('button',name='Управление',exact=True)).to_be_visible()
def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-browser-audit-') as temp, sync_playwright() as pw:
        with open(Path(temp)/'api.log','w+') as log:
            server=subprocess.Popen(['node','--import','tsx','server/index.ts'],cwd=ROOT,env=dict(os.environ,DB_PATH=str(Path(temp)/'test.sqlite'),PORT='3108',ENABLE_REAL_AGENTS='0'),stdout=log,stderr=log)
            browser=None
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(URL+'/api/health',timeout=1).close();break
                    except OSError:
                        assert server.poll() is None,'Fixture server exited'
                        time.sleep(.1)
                browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
                ca=browser.new_context(viewport={'width':1512,'height':982});cb=browser.new_context(viewport={'width':1512,'height':982})
                a=ca.new_page();b=cb.new_page();errors=[]
                for page in [a,b]:page.on('pageerror',lambda e:errors.append(str(e)))
                login(a,'admin','DemoAdmin-2026!')
                csrf=a.request.get(URL+'/api/me').json()['csrf']
                def post(path,body):
                    return a.request.post(URL+'/api'+path,headers={'X-CSRF-Token':csrf},data=body)
                assert post('/admin/users',{'username':'second','password':SECRET,'role':'admin'}).status==201
                assert post('/admin/users',{'username':'staff','password':SECRET,'role':'operator'}).status==201
                login(b,'second',SECRET)
                for page in [a,b]:
                    page.get_by_role('button',name='Каталог игр',exact=True).click()
                    page.locator('.catalog-item').filter(has_text='Epic Games + Fortnite').get_by_role('button',name='Редактировать').click()
                fa=a.get_by_role('form',name='Карточка игры');fb=b.get_by_role('form',name='Карточка игры')
                fa.get_by_label('Название',exact=True).fill('Каталог первого сотрудника')
                fb.get_by_label('Название',exact=True).fill('Несохранённый черновик коллеги')
                fa.get_by_role('button',name='Сохранить игру').click()
                expect(a.get_by_role('status').filter(has_text='Каталог сохранён')).to_be_visible()
                # Cached forms keep both the draft and its captured revision across tabs.
                b.get_by_role('button',name='Компьютеры',exact=True).click()
                expect(b.get_by_role('form',name='Карточка игры')).to_have_count(0)
                b.get_by_role('button',name='Каталог игр',exact=True).click()
                expect(fb.get_by_label('Название',exact=True)).to_have_value('Несохранённый черновик коллеги')
                fb.get_by_role('button',name='Сохранить игру').click()
                expect(fb.get_by_role('alert')).to_contain_text('другой сотрудник')
                expect(fb.get_by_role('alert')).to_be_focused()
                expect(fb.get_by_label('Название',exact=True)).to_have_value('Несохранённый черновик коллеги')
                b.wait_for_timeout(1700)
                expect(fb.get_by_label('Название',exact=True)).to_have_value('Несохранённый черновик коллеги')
                for width in [1512,390]:
                    b.set_viewport_size({'width':width,'height':982 if width>700 else 844})
                    assert b.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                    assert not contrast_issues(b)
                    (ROOT/'test-results').mkdir(exist_ok=True)
                    b.screenshot(path=str(ROOT/f'test-results/edit-conflict-{width}.png'),full_page=True)
                b.set_viewport_size({'width':1512,'height':982})
                fb.get_by_role('button',name='Загрузить актуальную игру').click()
                expect(fb.get_by_label('Название',exact=True)).to_have_value('Каталог первого сотрудника')
                fb.get_by_label('Название',exact=True).fill('Согласованная карточка игры')
                fb.get_by_role('button',name='Сохранить игру').click()
                expect(b.get_by_role('status').filter(has_text='Каталог сохранён')).to_be_visible()
                # A lost response must not silently replace the captured edit version or replay PUT.
                a.locator('.catalog-item').filter(has_text='Согласованная карточка игры').get_by_role('button',name='Редактировать').click()
                fa.get_by_label('Название',exact=True).fill('Сохранено, но ответ потерян')
                attempts=[]
                def lose(route):
                    if route.request.method=='PUT':
                        attempts.append(route.request.post_data_json);r=route.fetch();assert r.status==200;route.abort('failed')
                    else:route.continue_()
                a.route('**/api/admin/games/fortnite',lose)
                fa.get_by_role('button',name='Сохранить игру').click()
                expect(fa.get_by_role('alert')).to_contain_text('могло быть выполнено')
                a.unroute('**/api/admin/games/fortnite')
                expect(a.locator('.connection-status')).to_contain_text('API подключён',timeout=8000)
                assert len(attempts)==1
                fa.get_by_role('button',name='Сохранить игру').click()
                expect(fa.get_by_role('alert')).to_contain_text('другой сотрудник')
                fa.get_by_role('button',name='Загрузить актуальную игру').click()
                for page in [a,b]:
                    page.get_by_role('button',name='Управление',exact=True).click()
                    page.locator('.catalog-item').filter(has_text='Аврора').get_by_role('button',name='Редактировать').click()
                ac=a.get_by_role('form',name='Клуб и варианты');bc=b.get_by_role('form',name='Клуб и варианты')
                ac.get_by_label('Название',exact=True).fill('Клуб после согласования')
                bc.get_by_label('Название',exact=True).fill('Старый черновик клуба')
                ac.get_by_role('button',name='Сохранить клуб').click()
                expect(a.get_by_role('status').filter(has_text='Клуб сохранён')).to_be_visible()
                b.get_by_role('button',name='Каталог игр',exact=True).click()
                expect(b.get_by_role('form',name='Клуб и варианты')).to_have_count(0)
                b.get_by_role('button',name='Управление',exact=True).click()
                expect(bc.get_by_label('Название',exact=True)).to_have_value('Старый черновик клуба')
                expect(b.get_by_role('combobox',name='Роль staff')).to_be_visible()
                bc.get_by_role('button',name='Сохранить клуб').click()
                expect(bc.get_by_role('alert')).to_contain_text('другой сотрудник')
                expect(bc.get_by_label('Название',exact=True)).to_have_value('Старый черновик клуба')
                bc.get_by_role('button',name='Загрузить актуальный клуб').click()
                expect(bc.get_by_label('Название',exact=True)).to_have_value('Клуб после согласования')
                au=a.locator('.user-row').filter(has=a.get_by_text('staff',exact=True));bu=b.locator('.user-row').filter(has=b.get_by_text('staff',exact=True))
                au.get_by_role('combobox',name='Роль staff').select_option('admin')
                au.get_by_role('button',name='Сохранить',exact=True).click()
                expect(a.get_by_role('status').filter(has_text='Настройки сотрудника сохранены')).to_be_visible()
                bu.get_by_label('Отключён').check();bu.get_by_role('button',name='Сохранить',exact=True).click()
                expect(b.locator('#users-error')).to_contain_text('другой сотрудник')
                expect(bu.get_by_label('Отключён')).to_be_checked()
                bu.get_by_role('button',name='Загрузить актуальные данные staff').click()
                expect(bu.get_by_role('combobox')).to_have_value('admin');expect(bu.get_by_label('Отключён')).not_to_be_checked()
                bu.get_by_label('Отключён').check();bu.get_by_role('button',name='Сохранить',exact=True).click()
                expect(b.get_by_role('status').filter(has_text='Настройки сотрудника сохранены')).to_be_visible()
                # Reset also uses the captured version; passwords clear after a conflict.
                au.get_by_role('button',name='Сбросить пароль staff').click();dialog=a.get_by_role('dialog')
                dialog.get_by_label('Новый пароль',exact=True).fill(SECRET);dialog.get_by_label('Повторите новый пароль').fill(SECRET)
                dialog.get_by_label('Подтверждаю завершение').check();dialog.get_by_role('button',name='Сменить пароль').click()
                expect(dialog.get_by_role('alert')).to_contain_text('другой сотрудник');expect(dialog.get_by_label('Новый пароль',exact=True)).to_have_value('')
                dialog.get_by_role('button',name='Отмена',exact=True).click();au.get_by_role('button',name='Загрузить актуальные данные staff').click()
                made=post('/jobs',{'deviceIds':['aurora-1'],'gameId':'fortnite','operation':'apply_marking','variant':36}).json()[0]
                for page in [a,b]:page.get_by_role('button',name='Компьютеры',exact=True).click()
                ja=a.locator('article[data-job-id="'+made['id']+'"]');jb=b.locator('article[data-job-id="'+made['id']+'"]')
                expect(ja.locator('.feedback')).to_be_visible(timeout=8000);expect(jb.locator('.feedback')).to_be_visible(timeout=8000)
                ja.get_by_label('Результат со слов сотрудника').select_option('helped')
                jb.get_by_label('Комментарий').fill('Черновик второго сотрудника')
                ja.get_by_role('button',name='Сохранить отметку').click();expect(a.get_by_role('status').filter(has_text='Отметка сохранена')).to_be_visible()
                jb.get_by_role('button',name='Сохранить отметку').click();expect(jb.get_by_role('alert')).to_contain_text('другой сотрудник')
                expect(jb.get_by_label('Комментарий')).to_have_value('Черновик второго сотрудника')
                jb.get_by_role('button',name='Загрузить актуальную отметку').click()
                expect(jb.get_by_label('Результат со слов сотрудника')).to_have_value('helped');expect(jb.get_by_label('Комментарий')).to_have_value('')
                a.get_by_role('button',name='Журнал действий',exact=True).click()
                panel=a.get_by_role('region',name='Журнал действий')
                expect(panel.locator('.audit-event')).to_have_count(10)
                # The discarded/conflicting writes add no success event; no credentials or comments appear.
                payload=a.request.get(URL+'/api/admin/audit').text()
                assert SECRET not in payload and 'Черновик второго сотрудника' not in payload
                panel.get_by_label('Действие',exact=True).select_option('game.updated')
                panel.get_by_role('button',name='Применить фильтры').click();expect(panel.locator('.audit-event')).to_have_count(3)
                panel.locator('details').first.get_by_text('Изменения',exact=True).click()
                expect(panel.get_by_text('Сохранено, но ответ потерян',exact=False).first).to_be_visible()
                for width in [1512,390]:
                    a.set_viewport_size({'width':width,'height':982 if width>700 else 844})
                    assert a.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                    assert not contrast_issues(a)
                    a.screenshot(path=str(ROOT/f'test-results/audit-{width}.png'),full_page=True)
                panel.get_by_label('Сотрудник или агент').select_option('second')
                panel.get_by_role('button',name='Применить фильтры').click();expect(panel.locator('.audit-event')).to_have_count(1)
                assert not errors,errors
                print('PASS Chromium two-admin audit: game/club/staff/password/feedback conflicts, preserved drafts, explicit reload, lost PUT response without replay, safe audit filters, desktop/mobile contrast/overflow; Linux DEMO only')
            finally:
                if browser:browser.close()
                server.terminate()
                try:server.wait(timeout=5)
                except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
if __name__=='__main__':run()
