"use strict";
// Not a test: screenshots for admin part 2. Usage: node tests/screenshots-hours.js <output-folder>
const fs = require("node:fs");
const path = require("node:path");
const { launch, openPage } = require("./helpers/site");
const { USERS, D, bk, exc, backendWith } = require("./helpers/fixtures");

const out = path.resolve(process.argv[2] || "tests/screenshots");
fs.mkdirSync(out, { recursive: true });
const data = () => backendWith({
  exceptions: [exc("e1", "Matty", "off", D.wed, D.wed, null, null, "Dentist"), exc("e2", "Matty", "off", D.fri, D.fri, "14:00", "15:30", "School run"), exc("e3", "Matty", "extra", D.sun2, D.sun2, "10:00", "13:00")],
  bookings: [bk("Matty", "Sam Jones", D.mon, "10:00"), bk("Matty", "Pete Brown", D.mon, "11:30"), bk("Matty", "Priya Patel", D.tue, "14:00"),
    bk("Matty", "Dave Smith", D.wed, "11:00"), bk("Matty", "Tom Hart", D.fri, "14:30"), bk("Matty", "Late Larry", D.thu, "17:00")],
});

(async () => {
  const env = await launch();
  for (const [label, viewport] of Object.entries({ phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } })) {
    const open = (opts = {}) => openPage(env, data(), { signedInAs: USERS.matty, viewport, ...opts });
    const clean = (page) => page.addStyleTag({ content: "#dock{display:none!important}" });
    let page = await open();
    await page.locator(".card, .empty").first().waitFor();

    await page.click("#tab-week"); await page.click("#week-next");
    await page.locator(".wday .wday-name", { hasText: "Mon 26 Oct" }).waitFor(); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${label}-1-week.png`) });
    await clean(page);
    await page.screenshot({ path: path.join(out, `${label}-1b-week-full.png`), fullPage: true });

    await page.click("#tab-hours"); await page.locator(".hday").first().waitFor(); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${label}-2-hours.png`) });
    await page.screenshot({ path: path.join(out, `${label}-2b-hours-full.png`), fullPage: true });

    // shorten Thursday over Larry's 17:00 booking -> warning
    await page.selectOption('select[aria-label="Thursday end"]', "16:00");
    await page.evaluate(() => { document.querySelector("#dock")?.style.removeProperty("display"); });
    await page.click("#hours-save");
    await page.locator("#hours-warn").waitFor({ state: "visible" }); await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${label}-3-hours-warning.png`) });
    await page.getByRole("button", { name: "Keep editing" }).click();
    await page.context().close();

    page = await open();
    await page.locator(".card, .empty").first().waitFor();
    await page.click("#tab-hours"); await page.locator(".hday").first().waitFor();
    await page.click("#ex-open-off");
    await page.click('#ex-type .chip[data-type="range"]');
    await page.fill("#ex-from", D.thu); await page.selectOption("#ex-start", "16:30"); await page.selectOption("#ex-end", "18:00");
    await page.fill("#ex-note", "Dentist");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, `${label}-4-block-form.png`) });
    await page.click("#ex-save");
    await page.locator("#ex-warn").waitFor({ state: "visible" }); await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `${label}-5-block-warning.png`) });
    await page.context().close();

    page = await open();
    await page.locator(".card, .empty").first().waitFor();
    await page.click("#add-open");
    await page.fill("#add-date", D.tue);
    await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00"); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${label}-6-add-booking-times.png`) });
    await page.context().close();

    page = await openPage(env, data(), { path: "/index.html", viewport });
    await page.click("#barber-matty"); await page.locator(".slot").first().waitFor();
    await page.locator('.day-chip', { hasText: "Tue 27 Oct" }).click(); await page.waitForTimeout(500);
    await page.locator("#slots-step").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${label}-7-customer-times.png`) });
    await page.context().close();
  }
  await env.close();
  console.log(fs.readdirSync(out).join("\n"));
})();
