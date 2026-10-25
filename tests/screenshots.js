"use strict";
// Not a test: takes the screenshots of the admin page. Usage: node tests/screenshots.js <output-folder>
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { launch, openPage, FakeSupabase, NOW, at } = require("./helpers/site");

const out = path.resolve(process.argv[2] || "tests/screenshots");
fs.mkdirSync(out, { recursive: true });
const T = "2026-10-25", N = "2026-10-26";
const bk = (barber, name, date, time, extra = {}) => ({
  barber, customer_name: name, appointment_time: at(date, time), customer_phone: "07700 900123",
  customer_email: `${name.split(" ")[0].toLowerCase()}@example.com`, cancel_token: crypto.randomUUID(), user_id: null, ...extra,
});
const matty = { id: "u1", email: "matty@example.com" };
const backend = () => new FakeSupabase({
  now: NOW, users: [matty, { id: "u2", email: "cust@example.com" }], admins: [{ email: "matty@example.com", barber_name: "Matty" }],
  bookings: [
    bk("Matty", "Dave Smith", T, "10:00"), bk("Matty", "Sam Jones", T, "14:00", { customer_phone: "07700 900222" }),
    bk("Alfie", "Pete Brown", T, "15:30", { customer_email: null }), bk("Matty", "Carl Cancelled", T, "16:00", { status: "cancelled" }),
    bk("Alfie", "Priya Patel", T, "17:00"), bk("Matty", "Tomorrow Tim", N, "10:00"),
  ],
});

(async () => {
  const env = await launch();
  const sizes = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
  for (const [label, viewport] of Object.entries(sizes)) {
    const open = (opts = {}) => openPage(env, backend(), { signedInAs: matty, viewport, ...opts });
    let page = await open();
    await page.locator(".card").first().waitFor();
    await page.screenshot({ path: path.join(out, `${label}-1-bookings.png`) });
    if (label === "phone") await page.screenshot({ path: path.join(out, `${label}-1b-bookings-full.png`), fullPage: true });

    await page.click('#barber-filter .chip[data-barber="Matty"]');
    await page.locator(".card", { hasText: "Sam Jones" }).locator(".btn-danger-ghost").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${label}-2-cancel-confirm.png`) });

    await page.getByRole("button", { name: "Yes, cancel booking" }).click();
    await page.locator("#toast").waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(out, `${label}-3-cancelled-toast.png`) });

    await page.click("#add-open");
    await page.locator("#add-times .chip").first().waitFor();
    await page.locator('#add-times .chip[data-time="17:00"]').click();
    await page.fill("#add-name", "Walk In Wendy");
    await page.fill("#add-phone", "07700 900555");
    await page.screenshot({ path: path.join(out, `${label}-4-add-booking.png`) });
    if (label === "phone") await page.locator("#add-save").scrollIntoViewIfNeeded(), await page.screenshot({ path: path.join(out, `${label}-4b-add-booking-bottom.png`) });
    await page.click("#add-save");
    await page.locator("#toast").waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `${label}-5-booked.png`) });
    await page.context().close();

    page = await openPage(env, backend(), { signedInAs: null, viewport });
    await page.locator("#v-signin").waitFor();
    await page.screenshot({ path: path.join(out, `${label}-6-signin.png`) });
    await page.context().close();

    page = await openPage(env, backend(), { signedInAs: { id: "u2", email: "cust@example.com" }, viewport });
    await page.locator("#v-denied").waitFor();
    await page.screenshot({ path: path.join(out, `${label}-7-not-admin.png`) });
    await page.context().close();

    page = await openPage(env, backend(), { path: "/index.html", signedInAs: matty, viewport });
    await page.locator("#nav-admin").waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(out, `${label}-8-site-nav-admin-link.png`), clip: { x: 0, y: 0, width: viewport.width, height: 140 } });
    await page.context().close();
  }
  await env.close();
  console.log(fs.readdirSync(out).join("\n"));
})();
