"""Real API/SQLite pagination, stale answers, stable membership, old focus and batch totals."""
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
URL='http://127.0.0.1:3106'

def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-pages-') as temp:
        env=dict(os.environ,DB_PATH=str(Path(temp)/'demo.sqlite'),PORT='3106',ENABLE_REAL_AGENTS='0')
        for script in ['tests/workspace-fixture.ts','tests/pages-fixture.ts']:
            subprocess.run(['node','--import','tsx',script],cwd=ROOT,env=env,check=True,capture_output=True)
        with open(Path(temp)/'server.log','w+') as log:
            server=subprocess.Popen(['node','--import','tsx','server/index.ts'],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:urllib.request.urlopen(URL+'/api/health',timeout=1).close();break
                    except OSError:
                        if server.poll() is not None:raise AssertionError('Pagination fixture exited')
                        time.sleep(.1)
                else:raise AssertionError('Pagination fixture did not start')
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
                    page=browser.new_page(viewport={'width':1512,'height':982});errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto(URL);page.get_by_role('button',name='Войти в панель').click()
                    page.get_by_role('button',name='Задания',exact=False).click()
                    expect(page.locator('article.job')).to_have_count(25)
                    nav=page.get_by_label('Страницы операций')
                    expect(nav).to_contain_text('201 операций')
                    expect(page.locator('article.job').first).to_contain_text('старый неизвестный результат')
                    page.get_by_label('Задание',exact=True).select_option('pagination-batch')
                    expect(page.locator('.batch-summary')).to_contain_text('Всего 120')
                    expect(page.locator('.batch-summary')).to_contain_text('Выполнено 60')
                    expect(page.locator('.batch-summary')).to_contain_text('Ошибка 60')
                    page.get_by_label('Сотрудник',exact=True).select_option('operator')
                    page.get_by_label('Статус операции',exact=True).select_option('failed')
                    expect(nav).to_contain_text('40 операций')
                    expect(page.locator('.batch-summary')).to_contain_text('Всего 120')
                    first=page.locator('article.job').evaluate_all('(els)=>els.map(e=>e.dataset.jobId)')
                    nav.get_by_role('button',name='Далее',exact=True).click()
                    expect(nav).to_contain_text('страница 2 из 2')
                    expect(page.locator('article.job')).to_have_count(15)
                    second=page.locator('article.job').evaluate_all('(els)=>els.map(e=>e.dataset.jobId)')
                    assert not set(first).intersection(second)
                    expect(page.get_by_label('Сотрудник',exact=True)).to_have_value('operator')
                    expect(page.get_by_label('Статус операции',exact=True)).to_have_value('failed')
                    # An old page response must not replace a newer author filter.
                    held=[]
                    def hold_old(route):
                        if 'page=1&' in route.request.url and 'author=operator' in route.request.url:held.append(route)
                        else:route.continue_()
                    page.route('**/api/history?**',hold_old)
                    nav.get_by_role('button',name='Назад',exact=True).click()
                    expect(page.get_by_text('Загрузка заданий…',exact=True)).to_be_visible()
                    page.get_by_label('Сотрудник',exact=True).select_option('retired')
                    page.get_by_label('Статус операции',exact=True).select_option('succeeded')
                    expect(page.locator('article.job')).to_have_count(1)
                    expect(page.locator('article.job')).to_contain_text('историческая операция 119')
                    assert held
                    for route in held:route.continue_()
                    page.unroute('**/api/history?**',hold_old)
                    expect(page.locator('article.job')).to_have_count(1)
                    # History -> exact operation must seek page five of a 120-member batch.
                    page.locator('article.job').get_by_role('button',name='В историю ПК и игры →').click()
                    expect(page.locator('tbody')).to_contain_text('историческая операция 119')
                    page.locator('tr[data-history-id="page-job-119"]').get_by_role('button',name='Открыть операцию').click()
                    expect(nav).to_contain_text('страница 5 из 5')
                    target=page.locator('article[data-job-id="page-job-119"]')
                    expect(target).to_be_focused()
                    # Reloading a page's statuses must not steal focus from filters.
                    employee=page.get_by_label('Сотрудник',exact=True);employee.focus()
                    page.wait_for_timeout(1800);expect(employee).to_be_focused()
                    # Stable snapshot excludes a genuinely new server job until refresh.
                    page.get_by_role('button',name='Сбросить фильтры',exact=True).click()
                    expect(nav).to_contain_text('201 операций')
                    auth=page.request.get(URL+'/api/me').json()
                    response=page.request.post(URL+'/api/jobs',headers={'X-CSRF-Token':auth['csrf']},data={'deviceIds':['aurora-fixture-1'],'gameId':'fortnite','operation':'health'})
                    assert response.status==201
                    page.wait_for_timeout(1800);expect(nav).to_contain_text('201 операций')
                    nav.get_by_role('button',name='Обновить выборку',exact=True).click()
                    expect(nav).to_contain_text('202 операций')
                    # History filters use the server, retain range on paging, reject reversed dates.
                    page.get_by_role('button',name='История',exact=True).click()
                    page.get_by_role('button',name='Сбросить фильтры',exact=True).click()
                    page.get_by_label('На странице',exact=True).select_option('10')
                    expect(page.locator('tbody tr')).to_have_count(10)
                    page.get_by_label('Сотрудник',exact=True).select_option('operator')
                    page.get_by_label('Статус операции',exact=True).select_option('failed')
                    expect(nav).to_contain_text('40 операций')
                    nav.get_by_role('button',name='Далее',exact=True).click();expect(nav).to_contain_text('страница 2 из 4')
                    page.get_by_label('С',exact=True).fill('2020-01-01T12:00')
                    page.get_by_label('По',exact=True).fill('2030-01-01T12:00')
                    expect(nav).to_contain_text('страница 1 из 4')
                    nav.get_by_role('button',name='Далее',exact=True).click()
                    expect(nav).to_contain_text('страница 2 из 4')
                    expect(page.get_by_label('С',exact=True)).to_have_value('2020-01-01T12:00')
                    expect(page.get_by_label('По',exact=True)).to_have_value('2030-01-01T12:00')
                    page.get_by_label('С',exact=True).fill('2030-01-01T12:00')
                    page.get_by_label('По',exact=True).fill('2020-01-01T12:00')
                    expect(page.get_by_role('alert')).to_contain_text('Начало периода')
                    page.get_by_role('button',name='Сбросить фильтры',exact=True).click()
                    expect(page.locator('tbody tr')).to_have_count(10)
                    assert not contrast_issues(page),contrast_issues(page)[:10]
                    (ROOT/'test-results').mkdir(exist_ok=True)
                    page.evaluate('window.scrollTo(0,0)')
                    page.screenshot(path=str(ROOT/'test-results/history-pagination-desktop.png'))
                    page.set_viewport_size({'width':390,'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    assert not contrast_issues(page),contrast_issues(page)[:10]
                    page.screenshot(path=str(ROOT/'test-results/history-pagination-mobile.png'),full_page=True)
                    page.get_by_role('button',name='Задания',exact=False).click()
                    expect(page.locator('article.job')).to_have_count(25)
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    assert not contrast_issues(page),contrast_issues(page)[:10]
                    page.screenshot(path=str(ROOT/'test-results/tasks-pagination-mobile.png'),full_page=True)
                    assert not errors,errors
                    browser.close()
                    print('PASS Chromium pagination: server filters, stable 201/202-row snapshot, 120-operation batch totals, page navigation, stale responses, old focus, no polling focus theft, historical author, date validation, desktop/mobile contrast and overflow')
            finally:
                server.terminate()
                try:server.wait(timeout=5)
                except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':run()
