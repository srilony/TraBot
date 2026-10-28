"""Workflow editor browser check. Requires Python Playwright and Chromium.

Run against a DISPOSABLE demo: it creates workflows and commerce events, briefly
enables workflows using demo-outbox delivery, and restores subscription settings.
No real email is sent. Tests of Resend-configured blocks use test mode only.

WORKFLOW_BASE_URL defaults to http://127.0.0.1:3002; the server must be running.
WORKFLOW_ARTIFACT_DIR defaults to /tmp/trabot-workflow-browser.
CHROMIUM_PATH defaults to /usr/bin/chromium.
"""
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('WORKFLOW_BASE_URL', 'http://127.0.0.1:3002').rstrip('/')
ARTIFACTS = Path(os.environ.get('WORKFLOW_ARTIFACT_DIR', '/tmp/trabot-workflow-browser'))


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1100}, timezone_id='Europe/Amsterdam')
        context.set_default_timeout(12000)
        page = context.new_page()
        errors, created = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('dialog', lambda dialog: dialog.accept())

        def get(path):
            result = context.request.get(BASE + path)
            assert result.ok, result.text()
            return result.json()

        def write(path, data, method='post'):
            result = getattr(context.request, method)(BASE + path, data=data)
            assert result.ok, result.text()
            return result.json()

        def save():
            page.locator('#saveWorkflow').click()
            expect(page.locator('#dirtyLabel')).to_be_hidden()
            expect(page.locator('#saveWorkflow')).to_be_enabled()
            result = page.locator('#workflowSelect').input_value()
            assert result
            if result not in created:
                created.append(result)
            return result

        def node(identifier):
            page.locator(f'[data-node="{identifier}"] .wf-node-header').click()

        def wait_run(identifier, count=1, mode=None, trigger_type=None):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                runs = get(f'/api/workflows/{identifier}/runs')['runs']
                matches = [run for run in runs if (mode is None or run['mode'] == mode) and (trigger_type is None or run['triggerType'] == trigger_type)]
                if len(matches) >= count and matches[0]['status'] in ('succeeded', 'failed', 'interrupted'):
                    assert matches[0]['status'] == 'succeeded', json.dumps(matches[0])
                    return matches[0]
                page.wait_for_timeout(150)
            raise AssertionError('Workflow did not complete the expected run')

        def publish(system, amount):
            preview = write('/api/simulator/preview', {'systemId': system, 'table': 'orders', 'op': 'c', 'brandId': 'northstar', 'recordId': 'WF-BROWSER-' + uuid.uuid4().hex[:10], 'amountCents': amount, 'status': 'placed'})
            return write('/api/hub/events', preview['event'])['event']

        subscriptions = get('/api/subscriptions')['subscriptions']
        try:
            page.goto(BASE + '/workflows', wait_until='networkidle')
            expect(page.locator('#wfServiceStatus')).to_have_text('Automation ready')
            expect(page.locator('#wfError')).to_be_hidden()
            assert page.locator('.wf-palette-block').count() == 5
            print('PASS: workflow feature loads with five component blocks and existing navigation')

            # Use the actual palette, drag movement, output/input ports, and persisted layout.
            page.locator('#newWorkflow').click()
            page.locator('[data-add-node="event_trigger"]').click()
            source = page.locator('[data-node="event1"] .wf-node-header').bounding_box()
            page.mouse.move(source['x'] + 60, source['y'] + 20)
            page.mouse.down()
            page.mouse.move(source['x'] - 130, source['y'] - 100, steps=8)
            page.mouse.up()
            page.locator('[data-add-node="http_get"]').drag_to(page.locator('#canvasViewport'), target_position={'x': 450, 'y': 160})
            expect(page.locator('[data-node="lookup1"]')).to_have_count(1)
            page.locator('[data-output="event1"]').click()
            page.locator('[data-input="lookup1"]').click()
            expect(page.locator('.wf-edge')).to_have_count(1)
            page.locator('.wf-connection-details summary').click()
            page.locator('[data-remove-edge]').click()
            expect(page.locator('.wf-edge')).to_have_count(0)
            page.locator('[data-output="event1"]').click()
            page.locator('[data-input="lookup1"]').click()
            page.locator('[data-add-node="condition"]').click()
            expect(page.locator('[data-node]')).to_have_count(3)
            page.locator('#removeNode').click()
            expect(page.locator('[data-node]')).to_have_count(2)
            page.locator('#workflowName').fill('[Browser] Visual connections')
            visual_id = save()
            definition = get(f'/api/workflows/{visual_id}')['workflow']
            assert len(definition['nodes']) == 2 and len(definition['edges']) == 1
            assert definition['nodes'][0]['position']['x'] < 200, definition
            page.reload(wait_until='networkidle')
            page.locator('#workflowSelect').select_option(visual_id)
            expect(page.locator('[data-node]')).to_have_count(2)
            expect(page.locator('.wf-edge')).to_have_count(1)
            print('PASS: palette drag/drop, block movement, connect/remove/reconnect, and save/reload layout')

            # The provided example uses actual GET output as a condition operand.
            page.locator('#exampleSelect').select_option('0')
            page.locator('#workflowName').fill('[Browser] Event routing')
            node('trigger')
            page.locator('[data-match="3"]').check()  # E-commerce orders created in addition to ERP orders.
            page.locator('[data-add-mapping]').click()
            page.locator('[data-mapping="2"][data-map-part="key"]').fill('brand')
            page.locator('[data-mapping="2"][data-map-part="path"]').fill('event.brandId')
            event_id = save()
            page.locator('#testWorkflow').click()
            expect(page.locator('#testDialog')).to_be_visible()
            page.locator('#runTest').click()
            expect(page.locator('#runDialog')).to_be_visible()
            test_run = wait_run(event_id, mode='test')
            assert test_run['context']['vars']['amount'] == test_run['context']['event']['after']['amountCents']
            assert test_run['context']['vars']['brand'] == test_run['context']['event']['brandId']
            assert test_run['context']['nodes']['lookup']['data']['limitCents'] == 15000
            assert any(step['nodeId'] == 'check' for step in test_run['steps'])
            email_step = next(step for step in test_run['steps'] if step['nodeType'] == 'email')
            assert email_step['output']['delivery'] == 'outbox'
            assert email_step['output']['status'] == 'demo'
            page.locator('[data-close="runDialog"]').click()
            page.locator('#outboxTab').click()
            expect(page.locator('#outboxList')).to_contain_text('Demo outbox')
            page.locator('[data-message]').first.click()
            expect(page.locator('#messageMetadata')).to_contain_text('no message sent')
            page.locator('[data-close="messageDialog"]').click()
            print('PASS: full event mapping, real HTTP GET, variable comparison, branch inspection, and safe Resend test capture')

            # Live runs explicitly use demo outbox; commerce subscriptions do not control workflow triggers.
            page.locator('#builderTab').click()
            for identifier in ('alert', 'routine'):
                node(identifier)
                page.locator('#wfEmailDelivery').select_option('outbox')
            save()
            write('/api/subscriptions', {'subscriptions': [{**rule, 'enabled': False} for rule in subscriptions]}, method='put')
            page.locator('#toggleWorkflow').click()
            expect(page.locator('#workflowState')).to_have_text('Enabled')
            publish('ecommerce', 25000)
            first_live = wait_run(event_id, mode='live')
            assert first_live['context']['event']['systemId'] == 'ecommerce'
            assert first_live['context']['nodes']['alert']['status'] == 'demo'
            publish('erp', 1000)
            second_live = wait_run(event_id, count=2, mode='live')
            assert second_live['context']['event']['systemId'] == 'erp'
            assert second_live['context']['nodes']['routine']['status'] == 'demo'
            assert get('/api/dashboard')['summary']['currentMonthValueCents'] == 0
            page.locator('#toggleWorkflow').click()
            expect(page.locator('#workflowState')).to_have_text('Draft')
            print('PASS: multiple event subscriptions execute true/false branches independently of commerce filters')

            page.locator('#exampleSelect').select_option('1')
            page.locator('#workflowName').fill('[Browser] Schedule')
            node('schedule')
            start = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=5)
            page.locator('#wfScheduleStart').fill(start.astimezone(ZoneInfo('Europe/Amsterdam')).strftime('%Y-%m-%dT%H:%M:%S'))
            page.locator('#wfScheduleInterval').fill('2')
            page.locator('#wfScheduleUnit').select_option('seconds')
            node('email')
            page.locator('#wfEmailDelivery').select_option('outbox')
            schedule_id = save()
            definition = get(f'/api/workflows/{schedule_id}')['workflow']
            assert datetime.fromisoformat(definition['nodes'][0]['config']['startAt'].replace('Z', '+00:00')) == start
            page.locator('#toggleWorkflow').click()
            expect(page.locator('#workflowState')).to_have_text('Enabled')
            scheduled = wait_run(schedule_id, mode='live', trigger_type='schedule')
            assert scheduled['context']['schedule']['scheduledAt']
            assert scheduled['context']['nodes']['email']['status'] == 'demo'
            page.locator('#toggleWorkflow').click()
            expect(page.locator('#workflowState')).to_have_text('Draft')
            print('PASS: local start time converts correctly and enabled interval schedule produces a persisted run')

            page.reload(wait_until='networkidle')
            page.locator('#workflowSelect').select_option(event_id)
            expect(page.locator('#workflowState')).to_have_text('Draft')
            page.locator('#runsTab').click()
            expect(page.locator('#runList')).to_contain_text('succeeded')
            page.locator('[data-run]').first.click()
            expect(page.locator('#runSteps')).to_contain_text('Get data')
            page.screenshot(path=str(ARTIFACTS / 'run-details.png'), full_page=True)
            page.locator('[data-close="runDialog"]').click()
            page.locator('#builderTab').click()
            node('check')
            expect(page.locator('#toast')).to_be_hidden(timeout=9000)
            page.screenshot(path=str(ARTIFACTS / 'workflows-desktop.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Desktop overflow'
            page.set_viewport_size({'width': 390, 'height': 844})
            page.screenshot(path=str(ARTIFACTS / 'workflows-mobile.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '390px overflow'
            page.set_viewport_size({'width': 320, 'height': 740})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '320px overflow'
            assert not errors, json.dumps(errors)
            print('PASS: run history survives reload; desktop/390px/320px layouts have no page overflow or browser errors')
            print('Artifacts:', ARTIFACTS)
        finally:
            for identifier in created:
                try:
                    flow = get(f'/api/workflows/{identifier}')['workflow']
                    if flow['enabled']:
                        write(f'/api/workflows/{identifier}', {**flow, 'enabled': False}, method='put')
                    context.request.delete(BASE + f'/api/workflows/{identifier}', headers={'content-type': 'application/json'}, data={})
                except Exception as error:
                    print('Cleanup note:', error)
            write('/api/subscriptions', {'subscriptions': subscriptions}, method='put')
            context.close()
            browser.close()


if __name__ == '__main__':
    main()
