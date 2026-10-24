"""Access controls against a private API fixture; no hardware or Windows agent is connected."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid
from playwright.sync_api import sync_playwright, expect
from browser_smoke import contrast_issues

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:3112'

def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-browser-access-') as temp,sync_playwright() as pw:
        with open(Path(temp)/'server.log','w+') as log:
            server=subprocess.Popen(['node','--import','tsx','server/index.ts'],cwd=ROOT,
                env=dict(os.environ,DB_PATH=str(Path(temp)/'test.sqlite'),PORT='3112',ENABLE_REAL_AGENTS='1',
                    ADMIN_USERNAME='fixture',ADMIN_PASSWORD='BrowserAccess-2026!'),stdout=log,stderr=log)
            browser=None
            try:
                for _ in range(100):
                    try:urllib.request.urlopen(URL+'/api/health',timeout=1).close();break
                    except OSError:
                        assert server.poll() is None
                        time.sleep(.1)
                browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
                page=browser.new_page(viewport={'width':1512,'height':982});errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(URL);page.get_by_label('Логин',exact=True).fill('fixture');page.get_by_label('Пароль',exact=True).fill('BrowserAccess-2026!')
                page.get_by_role('button',name='Войти в панель').click()
                expect(page.get_by_role('button',name='Управление',exact=True)).to_be_visible()
                csrf=page.request.get(URL+'/api/me').json()['csrf']
                def post(path,body,bearer=None):
                    headers={'X-CSRF-Token':csrf}
                    if bearer:headers['Authorization']='Bearer '+bearer
                    return page.request.post(URL+'/api'+path,headers=headers,data=body)
                club=post('/admin/clubs',{'name':'TEST ACCESS ONLY','variants':[{'id':36,'name':'36'}]}).json()
                enrollment=post('/admin/enrollments',{'clubId':club['id']}).json()
                device_id=str(uuid.uuid4());old='a1'*32;new='b2'*32
                assert post('/agent/register',{'enrollmentToken':enrollment['token'],'deviceId':device_id,'deviceToken':old,'name':'SYNTHETIC-PC','bootId':'boot'}).status==200
                page.get_by_role('button',name='Управление',exact=True).click()
                panel=page.get_by_role('region',name='Доступ агентов',exact=True)
                expect(panel.get_by_role('button',name='Сменить токен SYNTHETIC-PC')).to_be_visible(timeout=8000)
                panel.get_by_role('button',name='Сменить токен SYNTHETIC-PC').click()
                expect(panel).to_contain_text('Ожидает смены токена')
                assert post('/agent/poll',{'bootId':'boot','rules':[],'inspectionVerified':False},old).json()['rotateToken']
                assert post('/agent/access/rotate',{'newToken':new,'expectedAccessVersion':1},old).status==200
                expect(panel).to_contain_text('v2',timeout=8000)
                panel.get_by_role('button',name='Восстановить доступ SYNTHETIC-PC').click()
                confirm=page.get_by_role('region',name='Подтверждение восстановления агента')
                expect(confirm).to_contain_text('Старый токен перестанет работать')
                assert page.request.get(URL+'/api/agent/access',headers={'Authorization':'Bearer '+new}).status==200
                confirm.get_by_role('button',name='Отозвать доступ и выдать файл').click()
                file_panel=page.get_by_role('region',name='Файл восстановления агента')
                expect(file_panel).to_be_visible()
                with page.expect_download() as download_info:file_panel.get_by_role('button',name='Скачать файл восстановления').click()
                download=download_info.value;path=Path(temp)/'recovery.json';download.save_as(path)
                grant=json.loads(path.read_text());assert grant['deviceId']==device_id and grant['serverOrigin']==URL and grant['format']=='paneltech-agent-recovery'
                assert grant['recoveryToken'] not in page.locator('body').inner_text()
                assert page.request.get(URL+'/api/agent/access',headers={'Authorization':'Bearer '+new}).status==401
                for width in [1512,390]:
                    page.set_viewport_size({'width':width,'height':982 if width>700 else 844})
                    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
                    assert not contrast_issues(page)
                    (ROOT/'test-results').mkdir(exist_ok=True)
                    panel.screenshot(path=str(ROOT/f'test-results/device-access-{width}.png'))
                page.set_viewport_size({'width':1512,'height':982})
                page.get_by_role('button',name='Компьютеры',exact=True).click();page.get_by_role('button',name='Управление',exact=True).click()
                expect(file_panel).to_have_count(0)
                restored='c3'*32
                assert post('/agent/recover',{'recoveryToken':grant['recoveryToken'],'deviceId':device_id,'deviceToken':restored,'bootId':'boot'}).status==200
                expect(panel).to_contain_text('v4',timeout=8000)
                # An external change after opening confirmation cannot be overwritten silently.
                panel.get_by_role('button',name='Восстановить доступ SYNTHETIC-PC').click()
                assert post('/agent/access/rotate',{'newToken':'d4'*32,'expectedAccessVersion':4},restored).status==200
                confirm.get_by_role('button',name='Отозвать доступ и выдать файл').click()
                expect(panel.get_by_role('alert')).to_contain_text('Доступ ПК уже изменён')
                expect(panel.get_by_role('alert')).to_be_focused()
                expect(file_panel).to_have_count(0)
                confirm.get_by_role('button',name='Отмена',exact=True).click()
                assert not errors,errors
                print('PASS Chromium access: rotation request, confirmation before revocation, bound recovery download, no secret DOM, hide on navigation, original ID recovery, stale-version conflict, dark desktop/mobile; private HTTP fixture only, no Windows')
            finally:
                if browser:browser.close()
                server.terminate()
                try:server.wait(timeout=5)
                except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':run()
