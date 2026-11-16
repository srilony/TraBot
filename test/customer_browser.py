"""Self-contained customer browser integration. No real webhook calls or retained data.

Run: python3 test/customer_browser.py (requires Playwright Chromium).
Optional CHROMIUM_PATH overrides Playwright's bundled browser.
"""
import json
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
server = subprocess.Popen(['node', 'test/fixtures/customer-browser-server.mjs'], cwd=ROOT, stdout=subprocess.PIPE, text=True)
try:
    base = server.stdout.readline().strip()
    assert base.startswith('http://127.0.0.1:'), base
    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}), args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        page.goto(base + '/simulator')
        customer = {'table': 'customers', 'idField': 'customerid', 'data': {'customerid': 902001, 'name': 'SYNTHETIC browser customer', 'emailid': 'browser@example.invalid', 'phone': '0000000000', 'nationality': 'Indian', 'documentID': 'DEMO-BROWSER'}}
        page.locator('#customerJSON').fill(json.dumps(customer))
        page.get_by_role('button', name='Preview customer event').click()
        expect(page.locator('#eventPreview')).to_contain_text('902001')
        expect(page.locator('#publishEvent')).to_be_enabled()
        page.locator('#publishEvent').click()
        expect(page.locator('#publishStatus')).to_contain_text('Published')
        page.goto(base + '/event-hub')
        page.locator('#hubSystem').select_option('custom')
        page.locator('#hubTable').select_option('customers')
        expect(page.locator('#hubRows')).to_contain_text('902001')
        page.locator('[data-event-id]').first.click()
        expect(page.locator('#eventEnvelope')).to_contain_text('"emailid": "browser@example.invalid"')
        page.locator('#eventDialog').evaluate('(dialog) => dialog.close()')
        page.goto(base + '/workflows')
        page.locator('#newWorkflow').click()
        page.locator('#workflowName').fill('SYNTHETIC customer browser integration')
        page.locator('[data-add-node="event_trigger"]').click()
        page.get_by_label('Custom customer events · Customer event created').check()
        while page.locator('[data-remove-mapping]').count():
            page.locator('[data-remove-mapping]').first.click()
        page.locator('[data-add-mapping]').click()
        page.locator('[data-mapping="0"][data-map-part="key"]').fill('customerId')
        page.locator('[data-mapping="0"][data-map-part="path"]').fill('event.data.customerid')
        page.locator('[data-add-node="update_crm"]').click()
        fields = {key: {'kind': 'path', 'value': 'event.data.' + key} for key in customer['data']}
        fields['customerid'] = {'kind': 'path', 'value': 'vars.customerId'}
        fields['name'] = {'kind': 'constant', 'value': 'SYNTHETIC constant customer'}
        page.locator('#wfCrmFields').fill(json.dumps(fields))
        page.locator('#wfCrmFields').press('Tab')
        page.locator('[data-output="event1"]').dispatch_event('pointerdown', {'button': 0})
        page.locator('[data-input="crm1"]').dispatch_event('pointerdown', {'button': 0})
        page.locator('#saveWorkflow').click()
        expect(page.locator('#dirtyLabel')).to_be_hidden()
        page.locator('#testWorkflow').click()
        page.locator('#runTest').click()
        expect(page.locator('#runOverview')).to_contain_text('succeeded')
        expect(page.locator('#runSteps')).to_contain_text('"status": 202')
        expect(page.locator('#runSteps')).to_contain_text('"persistence": "unverified"')
        assert 'browser-fake-password' not in page.locator('#runContext').inner_text()
        assert 'Authorization' not in page.locator('#runSteps').inner_text()
        page.locator('#runDialog').evaluate('(dialog) => dialog.close()')
        page.locator('#builderTab').click()
        # A real adapter failure reaches the run inspector without exposing response content.
        page.locator('[data-node="crm1"] .wf-node-header').click()
        fields['name']['value'] = 'SYNTHETIC FAIL customer'
        page.locator('#wfCrmFields').fill(json.dumps(fields))
        page.locator('#wfCrmFields').press('Tab')
        page.locator('#testWorkflow').click()
        page.locator('#runTest').click()
        expect(page.locator('#runOverview')).to_contain_text('HTTP 404')
        expect(page.locator('#runOverview')).to_contain_text('Listen for test event')
        expect(page.locator('#runSteps')).to_contain_text('No automatic retry')
        page.locator('#runDialog').evaluate('(dialog) => dialog.close()')
        page.locator('#builderTab').click()
        page.locator('[data-node="crm1"] .wf-node-header').click()
        fields['name']['value'] = 'SYNTHETIC automatic customer'
        page.locator('#wfCrmFields').fill(json.dumps(fields))
        page.locator('#wfCrmFields').press('Tab')
        page.locator('#toggleWorkflow').click()
        expect(page.locator('#workflowState')).to_have_text('Enabled')
        page.goto(base + '/simulator')
        customer['data']['customerid'] += 1
        page.locator('#customerJSON').fill(json.dumps(customer))
        page.get_by_role('button', name='Preview customer event').click()
        expect(page.locator('#publishEvent')).to_be_enabled()
        page.locator('#publishEvent').click()
        expect(page.locator('#publishStatus')).to_contain_text('Published')
        page.goto(base + '/workflows')
        page.locator('#runsTab').click()
        expect(page.locator('#runList tbody tr').first).to_contain_text('Live')
        expect(page.locator('#runList tbody tr').first).to_contain_text('succeeded')
        assert not errors, errors
        browser.close()
        print('Customer browser integration passed: simulator → hub → visual editor → CRM adapter → success/error history.')
finally:
    server.terminate()
    server.wait(timeout=10)
