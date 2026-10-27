"""Optional three-view browser smoke check (Python Playwright + Chromium).

Run only against a disposable demo database: this script changes subscriptions,
creates/updates/deletes source records, and resets demo history before and after.

Example: DEMO_BASE_URL=http://127.0.0.1:3001 python3 test/browser_smoke.py
The server must already be running. CHROMIUM_PATH defaults to /usr/bin/chromium;
DEMO_ARTIFACT_DIR defaults to /tmp/commerce-cdc-browser.
"""
import json
import os
from decimal import Decimal
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('DEMO_BASE_URL', 'http://127.0.0.1:3000').rstrip('/')
ARTIFACTS = Path(os.environ.get('DEMO_ARTIFACT_DIR', '/tmp/commerce-cdc-browser'))
DEFAULTS = [
    {'systemId': 'erp', 'table': 'orders', 'enabled': True},
    {'systemId': 'ecommerce', 'table': 'orders', 'enabled': False},
    {'systemId': 'ecommerce', 'table': 'carts', 'enabled': True},
]

def euro(value):
    return f'€{Decimal(value) / 100:,.2f}'

def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1050})
        context.set_default_timeout(10000)
        commerce, hub, simulator = [context.new_page() for _ in range(3)]
        errors = []
        for page in [commerce, hub, simulator]:
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)

        def get(path):
            response = context.request.get(BASE + path)
            assert response.ok, response.text()
            return response.json()

        def write(path, data, method='post'):
            response = getattr(context.request, method)(BASE + path, data=data)
            assert response.ok, response.text()
            return response.json()

        def loaded(page):
            expect(page.locator('#streamStatus')).to_have_text('Event hub connected')
            expect(page.locator('#errorBanner')).to_be_hidden()

        def prepare(system, table, op='c', record_id='', amount='100.00', status=None, cart_id=''):
            simulator.locator('#simOp').select_option('c')
            simulator.locator('#simSystem').select_option(system)
            simulator.locator('#simTable').select_option(table)
            simulator.locator('#simBrand').select_option('northstar')
            if op == 'c':
                simulator.locator('#simRecordId').fill(record_id)
            else:
                simulator.locator('#simOp').select_option(op)
                expect(simulator.locator(f'#simExisting option[value="{record_id}"]')).to_have_count(1)
                simulator.locator('#simExisting').select_option(record_id)
            if op != 'd':
                simulator.locator('#simAmount').fill(amount)
                simulator.locator('#simStatus').select_option(status or ('placed' if table == 'orders' else 'abandoned'))
                if table == 'orders':
                    simulator.locator('#simCartId').fill(cart_id)
            expect(simulator.locator('#publishEvent')).to_be_disabled()
            simulator.locator('#previewEvent').click()
            expect(simulator.locator('#publishEvent')).to_be_enabled()
            return json.loads(simulator.locator('#eventPreview').inner_text())

        def publish():
            with simulator.expect_response(lambda response: response.url.endswith('/api/hub/events') and response.request.method == 'POST') as received:
                simulator.locator('#publishEvent').click()
            response = received.value
            assert response.ok, response.text()
            result = response.json()
            expect(simulator.locator('#publishStatus')).to_contain_text('Published.')
            expect(simulator.locator('#publishEvent')).to_be_disabled()
            expect(simulator.locator('#previewEvent')).to_be_enabled()
            return result['event']

        def inspect(event, before, after):
            hub.locator(f'[data-event-id="{event["eventId"]}"]').click()
            expect(hub.locator('#eventDialog')).to_be_visible()
            assert json.loads(hub.locator('#eventBefore').inner_text()) == before
            assert json.loads(hub.locator('#eventAfter').inner_text()) == after
            expect(hub.locator('#eventMetadata')).to_contain_text(event['source']['name'])
            hub.locator('#closeEventDialog').click()

        try:
            write('/api/subscriptions', {'subscriptions': DEFAULTS}, method='put')
            write('/api/demo/reset', {})
            for page, path in [(commerce, '/'), (hub, '/event-hub'), (simulator, '/simulator')]:
                page.goto(BASE + path, wait_until='domcontentloaded')
                loaded(page)
            baseline = get('/api/dashboard')
            month = baseline['summary']['currentMonthValueCents']
            opportunity = baseline['summary']['openCartValueCents']
            total = get('/api/hub/events')['total']
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month))
            assert commerce.locator('#commerceView #simulatorForm').count() == 0
            assert commerce.locator('#commerceView [data-action="recover"]').count() == 0
            print('PASS: three separate connected views; commerce has no embedded event simulator')

            preview = prepare('ecommerce', 'orders', record_id='SMOKE-ECOM-ORDER', amount='123.45')
            assert preview['before'] is None and preview['after']['amountCents'] == 12345
            assert get('/api/hub/events')['total'] == total, 'Preview persisted an event'
            ecom_event = publish()
            expect(hub.locator('#hubTotal')).to_have_text(str(total + 1))
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month))
            inspect(ecom_event, None, ecom_event['after'])
            print('PASS: preview is side-effect free; unselected e-commerce orders reach hub but not commerce')

            commerce.locator('input[value="ecommerce.orders"]').check()
            commerce.locator('#saveSubscriptions').click()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month + 12345))
            commerce.reload(wait_until='domcontentloaded'); loaded(commerce)
            expect(commerce.locator('input[value="ecommerce.orders"]')).to_be_checked()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month + 12345))
            commerce.locator('input[value="ecommerce.orders"]').uncheck()
            commerce.locator('#saveSubscriptions').click()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month))
            print('PASS: saved source/data subscriptions include retained history and survive reload')

            prepare('erp', 'orders', record_id='SMOKE-ERP-ORDER', amount='100.00', cart_id='SMOKE-LINK')
            publish()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month + 10000))
            prepare('erp', 'orders', op='u', record_id='SMOKE-ERP-ORDER', amount='125.00')
            updated = publish()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month + 12500))
            inspect(updated, updated['before'], updated['after'])
            assert updated['before']['amountCents'] == 10000 and updated['after']['amountCents'] == 12500
            assert updated['before']['cartId'] == 'SMOKE-LINK' and 'cartId' not in updated['after'], 'Clearing a linked cart was not reflected in CDC'
            prepare('erp', 'orders', op='d', record_id='SMOKE-ERP-ORDER')
            deleted = publish()
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month))
            inspect(deleted, deleted['before'], None)
            print('PASS: subscribed ERP create/update/delete updates the monthly value and preserves CDC images')

            prepare('ecommerce', 'carts', record_id='SMOKE-CART', amount='75.00')
            publish()
            expect(commerce.locator('#cartValue')).to_have_text(euro(opportunity + 7500))
            prepare('ecommerce', 'carts', op='u', record_id='SMOKE-CART', amount='100.00')
            publish()
            expect(commerce.locator('#cartValue')).to_have_text(euro(opportunity + 10000))
            prepare('ecommerce', 'carts', op='d', record_id='SMOKE-CART')
            deleted_cart = publish()
            expect(commerce.locator('#cartValue')).to_have_text(euro(opportunity))
            inspect(deleted_cart, deleted_cart['before'], None)
            print('PASS: subscribed e-commerce cart create/update/delete changes opportunity without inflating sales')

            hub.locator('#hubSystem').select_option('erp')
            hub.locator('#hubTable').select_option('orders')
            hub.locator('#hubOp').select_option('u')
            hub.locator('#hubBrand').select_option('northstar')
            expect(hub.locator('#hubTotal')).to_have_text('1')
            expect(hub.locator('#hubRows')).to_contain_text('SMOKE-ERP-ORDER')
            hub.locator('#clearHubFilters').click()
            expect(hub.locator('#hubOlder')).to_be_enabled()
            hub.locator('#hubOlder').click()
            expect(hub.locator('#hubPageInfo')).to_contain_text('26–50')
            expect(hub.locator('#hubNewer')).to_be_enabled()
            hub.locator('#hubNewer').click()
            expect(hub.locator('#hubPageInfo')).to_contain_text('1–25')
            print('PASS: journal filters and pagination expose all retained events, including older history')

            for checkbox in commerce.locator('#subscriptionChoices input').all():
                checkbox.uncheck()
            commerce.locator('#saveSubscriptions').click()
            expect(commerce.locator('#monthRevenue')).to_have_text('€0.00')
            expect(commerce.locator('#cartValue')).to_have_text('€0.00')
            expect(commerce.locator('#eventList')).to_contain_text('No events match')
            assert get('/api/hub/events')['total'] > total
            print('PASS: zero subscriptions empties commerce while the event hub retains every accepted change')

            # Restore a presentation baseline before screenshots.
            write('/api/subscriptions', {'subscriptions': DEFAULTS}, method='put')
            write('/api/demo/reset', {})
            expect(commerce.locator('#monthRevenue')).to_have_text(euro(month))
            hub.locator('#clearHubFilters').click()
            prepare('ecommerce', 'carts', record_id='PREVIEW-CART', amount='75.00')
            for page, name in [(commerce, 'commerce'), (hub, 'event-hub'), (simulator, 'simulator')]:
                expect(page.locator('#toast')).to_be_hidden(timeout=6500)
                page.locator('h1').click()
                page.evaluate('scrollTo(0,0)')
                page.screenshot(path=str(ARTIFACTS / f'{name}-desktop.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name} desktop overflow'
                page.set_viewport_size({'width': 390, 'height': 844})
                page.wait_for_timeout(180)
                page.screenshot(path=str(ARTIFACTS / f'{name}-mobile.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name} 390px overflow'
                page.set_viewport_size({'width': 320, 'height': 740})
                page.wait_for_timeout(180)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name} 320px overflow'
            assert not errors, json.dumps(errors)
            print('PASS: all three views responsive at 1440/390/320px; no browser or console errors')
            print(f'Screenshots: {ARTIFACTS}')
        finally:
            write('/api/subscriptions', {'subscriptions': DEFAULTS}, method='put')
            write('/api/demo/reset', {})
            context.close(); browser.close()

if __name__ == '__main__':
    main()
