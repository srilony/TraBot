"""Optional end-to-end demo check. Requires Python Playwright and Chromium.

The app must already be running. This test resets the shared demo dataset before
and after its scenarios, so run it only against a disposable demonstration.

DEMO_BASE_URL defaults to http://127.0.0.1:3000.
DEMO_ARTIFACT_DIR defaults to /tmp/commerce-hub-browser.
CHROMIUM_PATH defaults to /usr/bin/chromium.
"""

import json
import os
import re
from decimal import Decimal
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("DEMO_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
ARTIFACTS = Path(os.environ.get("DEMO_ARTIFACT_DIR", "/tmp/commerce-hub-browser"))


def cents(text):
    return int(Decimal(re.sub(r"[^0-9.-]", "", text)) * 100)


def euro(value):
    return f"€{Decimal(value) / 100:,.2f}"


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            headless=True,
            args=["--no-sandbox"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 1100})
        context.set_default_timeout(10000)
        errors = []
        page = context.new_page()
        second = context.new_page()
        for tab in (page, second):
            tab.on("pageerror", lambda error: errors.append(str(error)))
            tab.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

        def reset_api():
            response = context.request.post(f"{BASE_URL}/api/demo/reset", data={})
            assert response.ok, f"Reset failed: {response.status}"

        def loaded(tab):
            expect(tab.locator("#totalEvents")).not_to_have_text("—")
            expect(tab.locator("#streamStatus")).to_have_text("Event hub connected")

        try:
            reset_api()
            for tab in (page, second):
                tab.goto(BASE_URL, wait_until="domcontentloaded")
                loaded(tab)
            assert page.locator(".metric-card").count() == 4
            print("PASS: dashboard loads with a connected event subscription")

            baseline = cents(page.locator("#monthRevenue").inner_text())
            second_baseline = second.locator("#monthRevenue").inner_text()
            order_button = page.get_by_role("button", name="Publish order")
            page.locator("#simAmount").fill("123.45")
            order_button.click()
            expect(page.locator("#toast")).to_have_text("Order event published. Booked sales updated across the hub.")
            expect(second.locator("#monthRevenue")).not_to_have_text(second_baseline)
            assert cents(page.locator("#monthRevenue").inner_text()) == baseline + 12345
            assert cents(second.locator("#monthRevenue").inner_text()) == baseline + 12345
            expect(order_button).to_be_enabled()
            print("PASS: €123.45 order updates both browser subscriptions exactly once")

            # One-cent events must remain observable in the primary metrics.
            page.locator("#simAmount").fill("0.01")
            order_button.click()
            expect(page.locator("#monthRevenue")).to_have_text(euro(baseline + 12346))
            expect(order_button).to_be_enabled()
            expect(second.locator("#monthRevenue")).to_have_text(euro(baseline + 12346))
            assert cents(page.locator("#monthRevenue").inner_text()) == baseline + 12346
            print("PASS: a one-cent order remains visible in portfolio metrics")

            page.locator("#simAmount").fill("87.65")
            original_cart_count = int(page.locator("#cartsCount").inner_text())
            original_opportunity = cents(page.locator("#cartValue").inner_text())
            original_recovered = cents(page.locator("#recoveredValue").inner_text())
            abandon_button = page.get_by_role("button", name="Abandon a cart")
            with page.expect_response(lambda response: response.url.endswith("/api/demo/abandon")) as published:
                abandon_button.click()
            cart_id = published.value.json()["event"]["payload"]["cartId"]
            new_cart = page.locator(".cart-item").filter(has=page.locator(f'[data-cart="{cart_id}"]'))
            expect(page.locator("#cartsCount")).to_have_text(str(original_cart_count + 1))
            expect(abandon_button).to_be_enabled()
            assert cents(page.locator("#cartValue").inner_text()) == original_opportunity + 8765
            new_cart.get_by_role("button", name="Record nudge", exact=False).click()
            expect(page.locator("#toast")).to_have_text("Nudge recorded in the hub. No message was sent.")
            expect(new_cart.locator(".nudge-tag")).to_be_visible()
            assert cents(page.locator("#cartValue").inner_text()) == original_opportunity + 8765
            new_cart.get_by_role("button", name="Simulate checkout", exact=False).click()
            expect(page.locator("#cartsCount")).to_have_text(str(original_cart_count))
            expect(page.locator("#toast")).to_have_text("Checkout simulated. Cart value moved into booked sales.")
            assert cents(page.locator("#cartValue").inner_text()) == original_opportunity
            assert cents(page.locator("#recoveredValue").inner_text()) == original_recovered + 8765
            assert cents(page.locator("#monthRevenue").inner_text()) == baseline + 12346 + 8765
            print("PASS: cart → recorded nudge → linked checkout updates opportunity and booked sales")

            page.locator("#brandFilter").select_option("atelier")
            expect(page.locator("#brandTable tr")).to_have_count(1)
            expect(page.locator("#brandTable")).to_contain_text("Atelier")
            expect(page.locator("#simBrand")).to_have_value("atelier")
            print("PASS: brand filter updates the portfolio and simulator selection")

            page.locator("#brandFilter").select_option("all")
            expect(page.locator("#brandTable tr")).to_have_count(3)
            before_reload = page.locator("#monthRevenue").inner_text()
            second.reload(wait_until="domcontentloaded")
            loaded(second)
            expect(second.locator("#monthRevenue")).to_have_text(before_reload)
            print("PASS: reload reconnects with authoritative persisted state")

            page.once("dialog", lambda dialog: dialog.accept())
            page.locator("#resetDemo").click()
            expect(page.locator("#toast")).to_have_text("Demo restored. Your portfolio is ready for a new story.")
            expect(page.locator("#recoveredValue")).to_have_text("€0.00")
            expect(second.locator("#monthRevenue")).to_have_text(page.locator("#monthRevenue").inner_text())
            print("PASS: confirmed reset restores the shared demo baseline")

            # Neutral screenshots without transient notifications or edited controls.
            page.locator("#simAmount").fill("149.00")
            page.locator("#simBrand").select_option("northstar")
            expect(page.locator("#toast")).to_be_hidden(timeout=6500)
            page.evaluate("scrollTo(0, 0)")
            page.screenshot(path=str(ARTIFACTS / "desktop.png"), full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Desktop has horizontal overflow"
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(180)  # Responsive SVG redraw is deliberately debounced.
            page.screenshot(path=str(ARTIFACTS / "mobile.png"), full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile has horizontal overflow"
            page.set_viewport_size({"width": 320, "height": 740})
            page.wait_for_timeout(180)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "320px viewport has horizontal overflow"
            assert not errors, "Browser errors: " + json.dumps(errors)
            print("PASS: responsive 1440px, 390px, and 320px layouts; no browser script/console errors")
            print(f"Screenshots: {ARTIFACTS / 'desktop.png'} and {ARTIFACTS / 'mobile.png'}")
        finally:
            reset_api()
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
