"""Working desktop/mobile panel: real API + fictional clubs of 65/20 PCs; no Windows."""
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
URL='http://127.0.0.1:3105'


def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-workspace-') as temp:
        env=dict(os.environ,DB_PATH=str(Path(temp)/'demo.sqlite'),PORT='3105',ENABLE_REAL_AGENTS='0')
        subprocess.run(['node','--import','tsx','tests/workspace-fixture.ts'],cwd=ROOT,env=env,check=True,capture_output=True)
        with open(Path(temp)/'server.log','w+') as log:
            process=subprocess.Popen(['node','--import','tsx','server/index.ts'],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(URL+'/api/health',timeout=1).close();break
                    except OSError:
                        if process.poll() is not None:raise AssertionError('Workspace fixture exited')
                        time.sleep(.1)
                else:raise AssertionError('Workspace fixture did not start')
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
                    page=browser.new_page(viewport={'width':1512,'height':982});errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto(URL);page.get_by_role('button',name='Войти в панель').click()
                    rows=page.locator('.device-table tbody tr')
                    expect(rows).to_have_count(65)
                    assert rows.locator('.pc-name').all_text_contents()[:4]==['1','2','10','63']
                    # An unknown older than the last 60 operations stays visible and blocks the card.
                    expect(page.locator('article.job').filter(has_text='старый неизвестный результат')).to_have_count(1)
                    page.get_by_role('button',name='Открыть незавершённые',exact=True).click()
                    expect(page.get_by_label('Задание',exact=True)).to_have_value('')
                    expect(page.locator('article.job').first).to_contain_text('старый неизвестный результат')
                    page.get_by_role('button',name='Компьютеры',exact=True).click()
                    search=page.get_by_label('Поиск ПК',exact=True)
                    search.fill('aurora-fixture-65');expect(rows).to_have_count(1)
                    rows.get_by_role('button',name='Открыть ПК room-pc65',exact=True).click()
                    card=page.get_by_role('complementary',name='Карточка ПК')
                    expect(card).to_contain_text('Требуется завершение или сверка')
                    expect(card.get_by_role('button',name='Применить к room-pc65',exact=True)).to_be_disabled()
                    # Search and same hostnames in another club never change device identity.
                    search.fill('1');expect(rows.locator('.pc-name').first).to_have_text('1')
                    search.fill('PUBG1-PC1');expect(rows).to_have_count(2)
                    expect(rows.locator('.pc-name').first).to_have_text('pubg1-pc1')
                    search.fill('missing');expect(rows).to_contain_text('ПК не найдены')
                    search.fill('aurora-fixture-1');expect(rows.locator('.pc-name').first).to_have_text('1')
                    page.get_by_role('checkbox',name='Выбрать 1',exact=True).check()
                    search.fill('pubg1-pc1')
                    page.get_by_role('button',name='Выбрать видимых',exact=True).click()
                    expect(page.locator('.selection-bar')).to_contain_text('выбрано 3')
                    expect(page.locator('.selection-bar')).to_contain_text('скрыто выбором фильтра: 1')
                    page.get_by_role('button',name='Применить к 3 ПК',exact=True).click()
                    dialog=page.get_by_role('dialog')
                    expect(dialog).to_contain_text('3: 1, pubg1-pc1, PUBG1-PC10')
                    dialog.get_by_role('button',name='Отмена',exact=True).click()
                    page.get_by_role('button',name='Снять весь выбор',exact=True).click()
                    search.fill('');page.get_by_label('Состояние ПК').select_option('offline')
                    expect(rows).to_have_count(1);expect(rows).to_contain_text('Недоступен')
                    page.get_by_label('Состояние ПК').select_option('unknown');expect(rows).to_have_count(1)
                    page.get_by_label('Состояние ПК').select_option('all')
                    page.locator('.clubs button').filter(has_text='Орбита').click()
                    expect(rows).to_have_count(20)
                    page.get_by_role('button',name='Открыть ПК 1',exact=True).click()
                    expect(card).to_contain_text('orbit-fixture-1');expect(card).not_to_contain_text('aurora-fixture-1')
                    page.locator('.clubs button').filter(has_text='Аврора').click()
                    expect(rows).to_have_count(65)
                    # A one-PC action doesn't reuse or expand the checkbox selection.
                    page.get_by_role('button',name='Открыть ПК 1',exact=True).click()
                    expect(page.get_by_role('button',name='Применить к 0 ПК',exact=True)).to_be_disabled()
                    card.get_by_role('button',name='Применить к 1',exact=True).click()
                    expect(page.locator('article.job').filter(has_text='правила симулятора применены')).to_have_count(1)
                    expect(card).to_contain_text('Свежий снимок')
                    expect(card).to_contain_text('5 собственных правил')
                    page.get_by_role('button',name='Открыть задание →',exact=True).click()
                    expect(page.get_by_role('heading',name='Задания',exact=True)).to_be_visible()
                    expect(page.locator('.batch-summary')).to_contain_text('Всего 1')
                    expect(page.locator('article.job')).to_have_count(1)
                    job=page.locator('article.job')
                    job.get_by_label('Результат со слов сотрудника').select_option('helped')
                    job.get_by_label('Симптом').select_option('voice')
                    job.get_by_role('button',name='Сохранить отметку').click()
                    expect(job).to_contain_text('Отметка: помогло')
                    job.get_by_role('button',name='В историю ПК и игры →',exact=True).click()
                    expect(page.locator('.filters select').nth(0)).to_have_value('aurora-fixture-1')
                    expect(page.locator('tbody')).to_contain_text('Помогло')
                    page.get_by_role('button',name='Компьютеры',exact=True).click()
                    page.get_by_role('button',name='Открыть ПК 1',exact=True).click()
                    expect(card).to_contain_text('Голосовой чат')
                    details=card.locator('details');details.locator('summary').click()
                    details.get_by_role('button',name='Имитировать перезагрузку').click()
                    expect(card).to_contain_text('Снимок устарел / отсутствует')
                    expect(card).to_contain_text('Голосовой чат')
                    # Another game's operation must never appear as the selected game's last operation.
                    auth=page.request.get(URL+'/api/me').json();headers={'X-CSRF-Token':auth['csrf']}
                    r=page.request.post(URL+'/api/jobs',headers=headers,data={'deviceIds':['aurora-fixture-2'],'gameId':'pubg','operation':'inspect_rules'})
                    assert r.status==201
                    expect(page.locator('article.job').filter(has_text='PUBG')).to_contain_text('DEMO: состояние симулятора прочитано')
                    expect(page.locator('tr[data-device-id="aurora-fixture-2"]')).to_contain_text('Нет операций')
                    # Mixed batch gets separate counters, not a single success flag.
                    page.get_by_role('checkbox',name='Выбрать 2',exact=True).check()
                    page.get_by_role('checkbox',name='Выбрать room-pc8',exact=True).check()
                    page.get_by_role('button',name='Применить к 2 ПК',exact=True).click()
                    page.get_by_role('button',name='Запустить для 2 ПК',exact=True).click()
                    page.get_by_role('button',name='Открыть задание →',exact=True).click()
                    expect(page.locator('.batch-summary')).to_contain_text('Всего 2')
                    expect(page.locator('.batch-summary')).to_contain_text('Выполнено 1')
                    expect(page.locator('.batch-summary')).to_contain_text('Ошибка 1')
                    page.get_by_label('Статус операции').select_option('failed');expect(page.locator('article.job')).to_have_count(1)
                    page.get_by_label('Статус операции').select_option('')
                    # Persisted job/batch survives a reload and is found by its stable ID.
                    batch=page.get_by_label('Задание',exact=True).input_value()
                    page.reload();page.get_by_role('button',name='Задания',exact=False).click()
                    page.get_by_label('Задание',exact=True).select_option(batch)
                    expect(page.locator('.batch-summary')).to_contain_text('Всего 2')
                    page.get_by_role('button',name='Компьютеры',exact=True).click()
                    page.get_by_role('button',name='Открыть ПК 1',exact=True).click()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    assert not contrast_issues(page),contrast_issues(page)[:10]
                    (ROOT/'test-results').mkdir(exist_ok=True)
                    page.evaluate('window.scrollTo(0,0)')
                    page.screenshot(path=str(ROOT/'test-results/workspace-desktop.png'),full_page=True)
                    page.screenshot(path=str(ROOT/'test-results/workspace-viewport.png'))
                    page.set_viewport_size({'width':390,'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'Mobile page overflow'
                    expect(card.get_by_role('button',name='Применить к 1',exact=True)).to_be_visible()
                    assert not contrast_issues(page),contrast_issues(page)[:10]
                    page.screenshot(path=str(ROOT/'test-results/workspace-mobile.png'),full_page=True)
                    card.scroll_into_view_if_needed()
                    page.screenshot(path=str(ROOT/'test-results/workspace-mobile-card.png'))
                    assert not errors,errors
                    browser.close()
                    print('PASS Chromium workspace: 65/20 PCs, arbitrary names/IDs, natural/exact search, visible/hidden selection, cross-club identity, game-specific card, stale reboot, old unknown, one-PC action, feedback, task/batch/status/history/reload, desktop/mobile contrast/overflow; no Windows')
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':run()
