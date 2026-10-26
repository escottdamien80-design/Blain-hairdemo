"use strict";
// The customer booking page: which times it offers now follows each barber's working hours, breaks, days off
// and extra hours (and falls back to the original 09:00–18:00 grid when none are set).
// "Today" is Sunday 25 Oct 2026, 13:10 UK time. Matty's week: Mon 09–18, Tue 09–18 (break 12–13), Wed 10–16,
// Thu 09–18, Fri 09–17, Sat 09–13, Sun off. Alfie has no hours yet.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openPage } = require("./helpers/site");
const { USERS, D, bk, exc, hrow, backendWith, at } = require("./helpers/fixtures");

let env;
before(async () => { env = await launch(); });
after(async () => { await env.close(); });

function shop(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  test(name, async () => {
    const backend = opts.backend || backendWith(opts.data || {});
    const page = await openPage(env, backend, { path: "/index.html", viewport: { width: 390, height: 844 }, ...opts.page });
    try {
      await fn({ page, backend });
      assert.deepEqual(page.errors, [], "no uncaught errors in the page");
    } finally {
      await page.context().close();
    }
  });
}

const pick = async (page, who) => {
  await page.click(`#barber-${who}`);
  await page.locator(".day-chip").first().waitFor();
};
const chips = (page) => page.locator(".day-chip").allTextContents();
const times = (page) => page.locator(".slot .slot-btn:not([disabled])").allTextContents();
const allTimes = (page) => page.locator(".slot .slot-btn").allTextContents();
const chip = (page, text) => page.locator(".day-chip", { hasText: text });
const gotoDay = async (page, text) => { await chip(page, text).click(); await page.waitForFunction((t) => [...document.querySelectorAll(".day-chip")].find((c) => c.textContent.includes(t))?.getAttribute("aria-pressed") === "true", text); };
const range = (from, to) => { const o = []; for (let m = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)); m <= Number(to.slice(0, 2)) * 60 + Number(to.slice(3)); m += 30) o.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return o; };

shop("Matty's page offers only his hours: days he works, minus his break, and skips his day off", async ({ page }) => {
  await pick(page, "matty");
  assert.deepEqual(await chips(page), ["Tomorrow", "Tue 27 Oct", "Wed 28 Oct", "Thu 29 Oct", "Fri 30 Oct", "Sat 31 Oct"], "today (Sunday) is his day off, so there's no chip for it; 7 days ahead ends Saturday");
  assert.equal(await page.getAttribute(".day-chip[aria-pressed='true']", "data-date"), D.mon, "starts on the first day with a free time");
  assert.deepEqual(await allTimes(page), range("09:00", "17:30"));
  await gotoDay(page, "Tue 27 Oct");
  assert.deepEqual(await allTimes(page), [...range("09:00", "11:30"), ...range("13:00", "17:30")], "no times in the 12–13 break");
  await gotoDay(page, "Wed 28 Oct");
  assert.deepEqual(await allTimes(page), range("10:00", "15:30"));
  await gotoDay(page, "Fri 30 Oct");
  assert.deepEqual(await allTimes(page), range("09:00", "16:30"));
  await gotoDay(page, "Sat 31 Oct");
  assert.deepEqual(await allTimes(page), range("09:00", "12:30"));
});

shop("a blocked day has no chip; a blocked few hours has no times; extra hours open a day off", async ({ page, backend }) => {
  backend.exceptions.push(exc("o1", "Matty", "off", D.wed, D.wed), exc("o2", "Matty", "off", D.thu, D.thu, "14:00", "15:30"), exc("x1", "Matty", "extra", D.sun, D.sun, "15:00", "17:00"));
  await pick(page, "matty");
  const days = await chips(page);
  assert.ok(!days.includes("Wed 28 Oct"), "Wednesday is blocked all day");
  assert.equal(days[0], "Today", "extra hours open today even though Sunday is normally off");
  assert.deepEqual(await allTimes(page), ["15:00", "15:30", "16:00", "16:30"]);
  await gotoDay(page, "Thu 29 Oct");
  const thu = await allTimes(page);
  assert.ok(thu.includes("13:30") && thu.includes("15:30"));
  assert.ok(!["14:00", "14:30", "15:00"].some((t) => thu.includes(t)));
});

shop("booked times show as unavailable (struck out, not clickable) and cancelled bookings free up", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Taken Tim", D.mon, "10:00"), bk("Matty", "Cancelled Cat", D.mon, "11:00", { status: "cancelled" }), bk("Alfie", "Alfie's Al", D.mon, "12:00"));
  await pick(page, "matty");
  const off = await page.locator(".slot.taken .slot-btn").allTextContents();
  assert.deepEqual(off, ["10:00"]);
  assert.equal(await page.locator('.slot[data-time="10:00"] .slot-btn').isDisabled(), true);
  assert.equal(await page.locator('.slot[data-time="11:00"] .slot-btn').isDisabled(), false, "cancelled = free");
  assert.equal(await page.locator('.slot[data-time="12:00"] .slot-btn').isDisabled(), false, "another barber's booking doesn't matter");
  assert.match(await page.getAttribute('.slot[data-time="10:00"] .slot-btn', "aria-label"), /unavailable/);
});

shop("a barber with no hours yet gets the original 09:00–18:00 grid, every day, and times that have passed today are not shown", async ({ page }) => {
  await pick(page, "alfie");
  const days = await chips(page);
  assert.equal(days.length, 7);
  assert.equal(days[0], "Today");
  assert.deepEqual(await allTimes(page), range("13:30", "18:00"), "13:10 now: the first time left is 13:30");
  await gotoDay(page, "Tomorrow");
  assert.deepEqual(await allTimes(page), range("09:00", "18:00"));
  await gotoDay(page, "Sat 31 Oct");
  assert.equal((await allTimes(page)).length, 19, "Saturdays and Sundays too, as before");
});

shop("if hours.sql hasn't been run yet the page still works: original grid, with booked times from the old taken-slots list", async ({ page, backend }) => {
  backend.always("bookable_slots", { mode: "http", status: 404, body: { code: "PGRST202", message: "Could not find the function public.bookable_slots" } });
  backend.bookings.push(bk("Matty", "Taken Tim", D.mon, "10:00"));
  await pick(page, "matty");
  assert.equal((await chips(page)).length, 7);
  await gotoDay(page, "Tomorrow");
  assert.equal((await allTimes(page)).length, 19);
  assert.deepEqual(await page.locator(".slot.taken .slot-btn").allTextContents(), ["10:00"]);
  assert.equal(await page.locator("#notice").isVisible(), false, "no scary message");
});

shop("if the times can't be loaded at all, the page says so calmly and still shows the grid", async ({ page, backend }) => {
  backend.always("bookable_slots", { mode: "http", status: 500, body: { message: "boom" } });
  await page.click("#barber-matty");
  await page.locator("#notice").waitFor({ state: "visible" });
  assert.match(await page.textContent("#notice"), /Couldn't check live availability/);
  await page.locator(".slot").first().waitFor();
});

shop("'Next available' jumps to the earliest free time, on whichever day that is", async ({ page, backend }) => {
  backend.bookings.push(...range("09:00", "17:30").map((t) => bk("Matty", `Fill ${t}`, D.mon, t))); // Monday is full
  await pick(page, "matty");
  assert.equal(await page.getAttribute(".day-chip[aria-pressed='true']", "data-date"), D.tue, "opens on the first day that has a free time");
  await gotoDay(page, "Wed 28 Oct");
  await page.click("#next-available");
  await page.waitForFunction(() => document.querySelector(".day-chip[aria-pressed='true']")?.dataset.date === "2026-10-27");
  assert.equal(await page.locator(".slot.highlight").getAttribute("data-time"), "09:00");
});

shop("a day that's fully booked still has a chip (greyed) so nobody wonders where it went", async ({ page, backend }) => {
  backend.bookings.push(...range("09:00", "17:30").map((t) => bk("Matty", `Fill ${t}`, D.mon, t)));
  await pick(page, "matty");
  assert.ok((await chips(page)).includes("Tomorrow"));
  assert.match(await page.getAttribute(".day-chip[data-date='2026-10-26']", "class"), /full/);
  await chip(page, "Tomorrow").click();
  assert.equal((await times(page)).length, 0);
  assert.equal(await page.locator(".slot.taken").count(), 18);
});

shop("a barber with nothing at all in the next 7 days says so and points to the other barber", async ({ page, backend }) => {
  backend.exceptions.push(exc("big", "Matty", "off", D.sun, "2026-11-30", null, null, "Holiday"));
  await page.click("#barber-matty");
  await page.locator("#slots .loading", { hasText: "no times available" }).waitFor();
  assert.match(await page.textContent("#slots"), /Matty has no times available in the next 7 days.*other barber/);
  assert.equal(await page.locator("#next-available").isDisabled(), true);
});

shop("booking a time: details, confirm, and the slot is taken afterwards; the booking is saved at the right UK time", async ({ page, backend }) => {
  await pick(page, "matty");
  await gotoDay(page, "Tue 27 Oct");
  await page.click('.slot[data-time="13:00"] .slot-btn');
  assert.match(await page.textContent("#details-summary"), /Matty · Tuesday 27 October at 13:00 · £28/);
  assert.equal(await page.getAttribute('.slot[data-time="13:00"] .slot-btn', "aria-pressed"), "true");
  await page.fill("#customer-name", "Cathy Customer");
  await page.fill("#customer-phone", "07700 900123");
  await page.fill("#customer-email", "cathy@example.com");
  await page.click("#confirm-booking");
  await page.locator("#confirmation").waitFor({ state: "visible" });
  assert.match(await page.textContent("#confirmation"), /Tuesday 27 October at 13:00/);
  const saved = backend.bookings.find((b) => b.customer_name === "Cathy Customer");
  assert.equal(saved.appointment_time, at(D.tue, "13:00"));
  assert.equal(saved.barber, "Matty");
  assert.equal(saved.status, "confirmed");
  assert.equal(await page.locator('.slot[data-time="13:00"]').getAttribute("class"), "slot taken");
  assert.deepEqual(backend.emails.map((e) => e.kind), ["confirmed"]);
});

shop("someone blocks the time while the customer is typing: a clear message, nothing booked, the times refresh", async ({ page, backend }) => {
  await pick(page, "matty");
  await page.click('.slot[data-time="10:00"] .slot-btn');
  await page.fill("#customer-name", "Cathy Customer");
  await page.fill("#customer-phone", "07700 900123");
  await page.fill("#customer-email", "cathy@example.com");
  backend.exceptions.push(exc("late", "Matty", "off", D.mon, D.mon, "09:30", "11:00"));
  await page.click("#confirm-booking");
  await page.locator("#notice").waitFor({ state: "visible" });
  assert.match(await page.textContent("#notice"), /isn't available any more/);
  assert.equal(backend.bookings.length, 0);
  await page.locator(".slot").first().waitFor();
  assert.equal(await page.locator('.slot[data-time="10:00"]').count(), 0, "the blocked time is gone from the list");
  assert.equal(await page.locator("#details-step").isVisible(), false);
});

shop("someone else booked the same time first: told it was just taken, and the list refreshes", async ({ page, backend }) => {
  await pick(page, "matty");
  await page.click('.slot[data-time="10:00"] .slot-btn');
  await page.fill("#customer-name", "Slow Sam");
  await page.fill("#customer-phone", "07700 900123");
  await page.fill("#customer-email", "sam@example.com");
  backend.bookings.push(bk("Matty", "Quick Quentin", D.mon, "10:00"));
  await page.click("#confirm-booking");
  await page.locator("#notice").waitFor({ state: "visible" });
  assert.match(await page.textContent("#notice"), /just taken/);
  assert.equal(backend.bookings.filter((b) => b.appointment_time === at(D.mon, "10:00")).length, 1);
  await page.waitForFunction(() => document.querySelector('.slot[data-time="10:00"]')?.classList.contains("taken"));
});

shop("times are shown in UK time even if the phone is set to another time zone", { page: { timezoneId: "America/New_York" } }, async ({ page, backend }) => {
  await pick(page, "matty");
  assert.equal((await chips(page))[0], "Tomorrow");
  assert.equal((await allTimes(page))[0], "09:00", "09:00 UK, not 05:00 New York");
  await page.click('.slot[data-time="09:30"] .slot-btn');
  assert.match(await page.textContent("#details-summary"), /Monday 26 October at 09:30/);
  await page.fill("#customer-name", "Nate New York");
  await page.fill("#customer-phone", "07700 900123");
  await page.fill("#customer-email", "nate@example.com");
  await page.click("#confirm-booking");
  await page.locator("#confirmation").waitFor({ state: "visible" });
  assert.equal(backend.bookings.find((b) => b.customer_name === "Nate New York").appointment_time, at(D.mon, "09:30"));
});

shop("clock-change day: on the day the clocks go back the same wall-clock times are offered", { data: { now: Date.parse("2026-10-24T20:00:00Z") }, page: { now: Date.parse("2026-10-24T20:00:00Z") } }, async ({ page, backend }) => {
  // the evening of Sat 24 Oct (BST, UTC+1): tomorrow is the 25-hour Sunday
  backend.hours.push(hrow("Matty", 7, true, "09:00", "18:00")); // (Matty's Sunday is a day off by default; make it a working day)
  backend.hours.splice(backend.hours.findIndex((h) => h.barber === "Matty" && h.weekday === 7 && !h.working), 1);
  await pick(page, "matty");
  await gotoDay(page, "Tomorrow");
  const t = await allTimes(page);
  assert.equal(t[0], "09:00");
  assert.equal(t.at(-1), "17:30");
  assert.equal(await page.locator(".slot").first().getAttribute("data-iso"), "2026-10-25T09:00:00.000Z", "09:00 on the day the clocks go back is 09:00 UTC");
});

shop("customers cancelling with their link still works, and the time becomes available again", async ({ page, backend }) => {
  const mine = bk("Matty", "Cathy Customer", D.mon, "10:00");
  backend.bookings.push(mine);
  await pick(page, "matty");
  assert.equal(await page.locator('.slot[data-time="10:00"]').getAttribute("class"), "slot taken");
  await page.fill("#booking-code", mine.cancel_token);
  await page.click("#lookup-btn");
  await page.locator("#booking-card").waitFor({ state: "visible" });
  await page.click("#cancel-start");
  await page.click("#cancel-yes");
  await page.locator("#manage-message", { hasText: "cancelled" }).waitFor();
  await page.waitForFunction(() => document.querySelector('.slot[data-time="10:00"]')?.className === "slot");
  assert.equal(mine.status, "cancelled");
});

shop("phone layout: day chips and times are big enough to tap, and nothing scrolls sideways", async ({ page }) => {
  await pick(page, "matty");
  const small = await page.evaluate(() => [...document.querySelectorAll(".day-chip, .slot-btn")].filter((e) => !e.disabled)
    .map((e) => ({ t: e.textContent, h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })).filter((x) => x.h < 44 || x.w < 44));
  assert.deepEqual(small, []);
  const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - 390, window.innerWidth - 390, window.visualViewport.scale < 0.999 ? 1 : 0));
  assert.ok(over <= 0, "no sideways scroll");
});

shop("the day chips scroll sideways inside their own row (not the page) when there are many", async ({ page }) => {
  await pick(page, "alfie");
  const r = await page.evaluate(() => { const c = document.querySelector(".day-chips"); return { scrolls: c.scrollWidth > c.clientWidth, overflowX: getComputedStyle(c).overflowX }; });
  assert.equal(r.overflowX, "auto");
});
