"use strict";
// Browser tests for admin part 2: weekly hours, days off / extra hours, the week view, and how the
// Add booking form follows the hours. Real Chromium + the real page code + the real supabase-js, against FakeSupabase.
// "Today" is Sunday 25 Oct 2026, 13:10 UK time (the day the clocks go back).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openPage } = require("./helpers/site");
const { USERS, D, mattyHours, hrow, bk, exc, backendWith, at } = require("./helpers/fixtures");

let env;
before(async () => { env = await launch(); });
after(async () => { await env.close(); });

function ui(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  test(name, async () => {
    const backend = opts.backend || backendWith(opts.data || {});
    const page = await openPage(env, backend, { signedInAs: USERS.matty, ...opts.page });
    try {
      await fn({ page, backend });
      assert.deepEqual(page.errors, [], "no uncaught errors in the page");
    } finally {
      await page.context().close();
    }
  });
}

const ready = async (page) => { await page.locator("#v-app").waitFor(); await page.locator(".card, .empty").first().waitFor(); };
const toastText = (page) => page.locator("#toast-text");
const hoursTab = async (page, barber) => {
  await ready(page);
  await page.click("#tab-hours");
  await page.locator(".hday").first().waitFor();
  if (barber) { await page.click(`#hours-barbers .chip[data-barber="${barber}"]`); await page.waitForFunction((b) => document.querySelector(`#hours-barbers .chip[data-barber="${b}"]`).getAttribute("aria-checked") === "true", barber); await page.locator(".hday").first().waitFor(); }
};
const weekTab = async (page) => { await ready(page); await page.click("#tab-week"); await page.locator(".wday").first().waitFor(); };
const day = (page, wd) => page.locator(`.hday[data-wd="${wd}"]`);
const setSel = (page, label, value) => page.selectOption(`select[aria-label="${label}"]`, value);
const sets = (backend) => backend.requests.filter((r) => r.key === "admin_set_hours").length;
const status = (page) => page.textContent("#hours-status");
const hoursFor = (backend, barber) => backend.hours.filter((h) => h.barber === barber).sort((a, b) => a.weekday - b.weekday);

// ================================================================ tabs
ui("the admin page has Day, Week and Hours tabs; Day is the one you land on, exactly as before", async ({ page }) => {
  await ready(page);
  assert.equal(await page.getAttribute("#tab-day", "aria-selected"), "true");
  assert.equal(await page.locator("#pane-week").isVisible(), false);
  assert.equal(await page.locator("#pane-hours").isVisible(), false);
  assert.equal(await page.locator("#add-open").isVisible(), true);
  await page.click("#tab-hours");
  assert.equal(await page.getAttribute("#tab-hours", "aria-selected"), "true");
  assert.equal(await page.locator("#pane-day").isVisible(), false);
  assert.equal(await page.locator("#add-open").isVisible(), false, "the Add booking button belongs to Day and Week only");
  await page.click("#tab-day");
  assert.equal(await page.locator("#add-open").isVisible(), true);
});

// ================================================================ weekly hours editor
ui("the editor shows each day's saved hours and break, for the signed-in barber first", async ({ page }) => {
  await hoursTab(page);
  assert.equal(await page.getAttribute('#hours-barbers .chip[data-barber="Matty"]', "aria-checked"), "true");
  assert.deepEqual(await page.locator(".hday-name").allTextContents(), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  assert.equal(await page.inputValue('select[aria-label="Monday start"]'), "09:00");
  assert.equal(await page.inputValue('select[aria-label="Wednesday start"]'), "10:00");
  assert.equal(await page.inputValue('select[aria-label="Wednesday end"]'), "16:00");
  assert.equal(await page.inputValue('select[aria-label="Tuesday break start"]'), "12:00");
  assert.equal(await page.inputValue('select[aria-label="Tuesday break end"]'), "13:00");
  assert.equal(await day(page, 1).locator(".break-row").count(), 0, "no break on Monday");
  assert.equal(await day(page, 7).locator(".switch").getAttribute("aria-checked"), "false");
  assert.equal(await day(page, 7).locator(".switch").textContent(), "Day off");
  assert.equal(await day(page, 7).locator("select").count(), 0, "a day off has no time pickers to confuse");
  assert.match(await status(page), /hours are saved/);
});

ui("a barber with no hours yet starts from what customers get today (09:00–18:00 every day) and says so", async ({ page }) => {
  await hoursTab(page, "Alfie");
  assert.match(await status(page), /Alfie has no hours saved yet.*09:00–18:00 every day/);
  for (let wd = 1; wd <= 7; wd++) assert.equal(await day(page, wd).locator(".switch").getAttribute("aria-checked"), "true");
  assert.equal(await page.inputValue('select[aria-label="Monday start"]'), "09:00");
  assert.equal(await page.inputValue('select[aria-label="Monday end"]'), "18:00");
});

ui("set the week: Sunday off, a Tuesday break, Friday ends early. Save, and the saved hours are exactly that", async ({ page, backend }) => {
  await hoursTab(page, "Alfie");
  await day(page, 7).locator(".switch").click();
  await day(page, 2).getByRole("button", { name: /add a break/i }).click();
  await setSel(page, "Tuesday break start", "12:30");
  await setSel(page, "Tuesday break end", "13:30");
  await setSel(page, "Friday end", "17:00");
  assert.match(await status(page), /unsaved changes/i);
  assert.equal(await page.getAttribute("#tab-hours", "data-dirty"), "true", "a dot on the tab shows there's something unsaved");
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(await toastText(page).textContent(), "Alfie's hours saved. Customers can now only book inside them.");
  const rows = hoursFor(backend, "Alfie");
  assert.equal(rows.length, 7);
  const by = (wd) => rows.find((r) => r.weekday === wd);
  assert.equal(by(7).working, false);
  assert.deepEqual([by(2).start_time, by(2).end_time, by(2).break_start, by(2).break_end], ["09:00:00", "18:00:00", "12:30:00", "13:30:00"]);
  assert.equal(by(5).end_time, "17:00:00");
  assert.equal(by(1).break_start, null);
  assert.match(await status(page), /hours are saved/);
  assert.equal(await page.getAttribute("#tab-hours", "data-dirty"), "false");
  assert.equal(hoursFor(backend, "Matty").length, 7, "Matty's hours are untouched");
});

ui("a saved day off keeps its times, so switching it back on is one tap", async ({ page, backend }) => {
  await hoursTab(page);
  await day(page, 7).locator(".switch").click();
  assert.equal(await page.inputValue('select[aria-label="Sunday start"]'), "09:00");
  assert.equal(await page.inputValue('select[aria-label="Sunday end"]'), "18:00");
  await day(page, 1).locator(".switch").click(); // and turning a day off
  assert.equal(await day(page, 1).locator("select").count(), 0);
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "saved" }).waitFor();
  assert.equal(hoursFor(backend, "Matty").find((r) => r.weekday === 1).working, false);
  assert.equal(hoursFor(backend, "Matty").find((r) => r.weekday === 7).working, true);
});

ui("'Use Monday's hours Mon–Fri' copies Monday (with its break) to Tuesday to Friday only", async ({ page, backend }) => {
  await hoursTab(page);
  await day(page, 1).getByRole("button", { name: /add a break/i }).click();
  await setSel(page, "Monday break start", "13:00");
  await setSel(page, "Monday break end", "14:00");
  await setSel(page, "Monday end", "19:00");
  await page.click("#hours-same");
  for (const wd of [2, 3, 4, 5]) {
    const name = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][wd];
    assert.equal(await page.inputValue(`select[aria-label="${name} start"]`), "09:00");
    assert.equal(await page.inputValue(`select[aria-label="${name} end"]`), "19:00");
    assert.equal(await page.inputValue(`select[aria-label="${name} break start"]`), "13:00");
  }
  assert.equal(await page.inputValue('select[aria-label="Saturday end"]'), "13:00", "Saturday is not touched");
  assert.equal(await day(page, 7).locator(".switch").getAttribute("aria-checked"), "false", "Sunday is not touched");
  assert.equal(sets(backend), 0, "nothing is saved until Save is tapped");
  assert.match(await status(page), /unsaved/i);
});

ui("'Copy Alfie's hours' copies the other barber's saved week into the editor (still unsaved); nothing to copy says so", async ({ page, backend }) => {
  await hoursTab(page);
  assert.equal(await page.textContent("#hours-copy"), "Copy Alfie's hours");
  await page.click("#hours-copy");
  await toastText(page).filter({ hasText: "no hours saved yet" }).waitFor();
  assert.equal(await page.inputValue('select[aria-label="Wednesday start"]'), "10:00", "unchanged");
  // give Alfie a week, then copy it to Matty
  backend.hours.push(...[1, 2, 3, 4, 5, 6, 7].map((wd) => hrow("Alfie", wd, wd !== 6 && wd !== 7, "08:00", "16:00")));
  await page.click("#tab-day");
  await page.click("#tab-hours");
  await page.locator(".hday").first().waitFor();
  await page.click("#hours-copy");
  await toastText(page).filter({ hasText: "copied" }).waitFor();
  assert.equal(await page.inputValue('select[aria-label="Wednesday start"]'), "08:00");
  assert.equal(await day(page, 6).locator(".switch").getAttribute("aria-checked"), "false");
  assert.match(await status(page), /unsaved/i);
  assert.equal(hoursFor(backend, "Matty")[2].start_time, "10:00:00", "not saved yet");
});

ui("a bad day is explained on that day and nothing is sent", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday start", "17:00");
  await setSel(page, "Monday end", "09:00");
  await page.click("#hours-save");
  assert.match(await day(page, 1).locator(".hday-problem").textContent(), /end time must be after the start/);
  assert.match(await page.textContent("#hours-problem"), /Fix the day marked above/);
  assert.equal(sets(backend), 0);
  await setSel(page, "Monday start", "09:00");
  await setSel(page, "Monday end", "18:00");
  assert.equal(await day(page, 1).locator(".hday-problem").isVisible(), false, "the message goes once it's fixed");

  await day(page, 3).getByRole("button", { name: /add a break/i }).click();
  await setSel(page, "Wednesday break start", "09:30"); // before Wednesday opens at 10:00
  await setSel(page, "Wednesday break end", "10:30");
  await page.click("#hours-save");
  assert.match(await day(page, 3).locator(".hday-problem").textContent(), /break must be inside working hours/);
  await setSel(page, "Wednesday break start", "13:00");
  await setSel(page, "Wednesday break end", "12:00");
  await page.click("#hours-save");
  assert.match(await day(page, 3).locator(".hday-problem").textContent(), /break must end after it starts/);
  assert.equal(sets(backend), 0);
});

ui("saving with nothing changed says so instead of doing anything", async ({ page, backend }) => {
  await hoursTab(page);
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "Nothing to change" }).waitFor();
  assert.equal(sets(backend), 0);
});

ui("a barber with no hours can save the default week to start using hours", async ({ page, backend }) => {
  await hoursTab(page, "Alfie");
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(hoursFor(backend, "Alfie").length, 7);
  assert.ok(hoursFor(backend, "Alfie").every((r) => r.working && r.start_time === "09:00:00" && r.end_time === "18:00:00"));
});

ui("unsaved changes: switching barber asks first; Keep editing stays, Discard throws the changes away", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  await page.click('#hours-barbers .chip[data-barber="Alfie"]');
  await page.locator("#hours-warn").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-warn"), /unsaved changes to Matty's hours/);
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(await page.inputValue('select[aria-label="Monday end"]'), "17:00", "still there");
  assert.equal(await page.getAttribute('#hours-barbers .chip[data-barber="Matty"]', "aria-checked"), "true");
  await page.click('#hours-barbers .chip[data-barber="Alfie"]');
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.waitForFunction(() => document.querySelector('#hours-barbers .chip[data-barber="Alfie"]').getAttribute("aria-checked") === "true");
  assert.match(await status(page), /Alfie has no hours/);
  await page.click('#hours-barbers .chip[data-barber="Matty"]');
  await page.waitForFunction(() => document.querySelector('#hours-barbers .chip[data-barber="Matty"]').getAttribute("aria-checked") === "true");
  assert.equal(await page.inputValue('select[aria-label="Monday end"]'), "18:00", "the discarded change did not stick");
  assert.equal(sets(backend), 0);
});

// ---- hours that would leave bookings outside
ui("shortening hours over existing bookings warns clearly, lists them, and NEVER cancels or moves them", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Late Larry", D.mon, "17:00"), bk("Matty", "Fine Fred", D.mon, "10:00"), bk("Matty", "Sunday Sue", D.sun2, "11:00"));
  const before = JSON.stringify(backend.bookings.map((b) => [b.cancel_token, b.status, b.appointment_time]));
  await hoursTab(page);
  await setSel(page, "Monday end", "16:00");
  await day(page, 7).locator(".switch").click(); // Sunday back on (so Sunday Sue is fine)
  await setSel(page, "Sunday start", "10:00");
  await page.click("#hours-save");
  await page.locator("#hours-warn").waitFor({ state: "visible" });
  const warn = await page.textContent("#hours-warn");
  assert.match(warn, /1 existing booking falls outside these hours/);
  assert.match(warn, /Late Larry/);
  assert.ok(!warn.includes("Fine Fred") && !warn.includes("Sunday Sue"), "only the affected booking is listed");
  assert.match(warn, /NOT be cancelled or changed/);
  assert.equal(sets(backend), 0, "nothing saved yet");
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(sets(backend), 0);
  await page.click("#hours-save");
  await page.getByRole("button", { name: "Save hours anyway" }).click();
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(sets(backend), 1);
  assert.equal(JSON.stringify(backend.bookings.map((b) => [b.cancel_token, b.status, b.appointment_time])), before, "every booking exactly as it was");
  assert.equal(backend.emails.length, 0, "and nobody was emailed");
});

ui("making a day a day off over bookings warns the same way, and cancelled bookings don't count", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Booked Bob", D.thu, "11:00"), bk("Matty", "Cancelled Cat", D.thu, "12:00", { status: "cancelled" }), bk("Alfie", "Alfie's Al", D.thu, "11:00"));
  await hoursTab(page);
  await day(page, 4).locator(".switch").click();
  await page.click("#hours-save");
  await page.locator("#hours-warn").waitFor({ state: "visible" });
  const warn = await page.textContent("#hours-warn");
  assert.match(warn, /Booked Bob/);
  assert.ok(!warn.includes("Cancelled Cat") && !warn.includes("Alfie's Al"));
});

ui("if existing bookings can't be checked, nothing is saved and they're told", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("GET bookings", { mode: "fail-before" });
  await page.click("#hours-save");
  await page.locator("#hours-problem").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-problem"), /Couldn't check your existing bookings.*nothing was saved/);
  assert.equal(sets(backend), 0);
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(sets(backend), 1);
});

// ---- slow / unreliable connections
ui("saving hours on a slow connection: 'Saving…', locked, and a second tap sends nothing extra", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("admin_set_hours", { delay: 800 });
  await page.click("#hours-save");
  assert.equal(await page.textContent("#hours-save"), "Saving…");
  assert.equal(await page.locator("#hours-save").isDisabled(), true);
  await page.locator("#hours-save").dispatchEvent("click");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(sets(backend), 1);
});

ui("hours: the connection drops AFTER saving: the page checks and confirms, no scare", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("admin_set_hours", { mode: "lose-response" });
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(hoursFor(backend, "Matty")[0].end_time, "17:00:00");
});

ui("hours: the connection drops BEFORE saving: they're told it's unclear, the edits are kept, and Save again works", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("admin_set_hours", { mode: "fail-before" });
  backend.once("GET barber_hours", {}); // the check for affected bookings gets through...
  backend.once("GET barber_hours", { mode: "fail-before" }); // ...but "did it save?" can't
  await page.click("#hours-save");
  await page.locator("#hours-problem").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-problem"), /couldn't tell if that saved.*safe to repeat/);
  assert.equal(await page.inputValue('select[aria-label="Monday end"]'), "17:00", "their edit is still on screen");
  assert.equal(hoursFor(backend, "Matty")[0].end_time, "18:00:00");
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  assert.equal(hoursFor(backend, "Matty")[0].end_time, "17:00:00");
  assert.equal(hoursFor(backend, "Matty").length, 7);
});

ui("hours: a request that hangs times out with a clear message", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("admin_set_hours", { mode: "hang" });
  backend.once("GET barber_hours", {});
  backend.once("GET barber_hours", { mode: "hang" });
  await page.click("#hours-save");
  await page.locator("#hours-problem").waitFor({ state: "visible", timeout: 8000 });
  assert.match(await page.textContent("#hours-problem"), /couldn't tell if that saved/);
});

ui("hours: when the database refuses (e.g. stale page), the reason is shown and the old hours stay", async ({ page, backend }) => {
  await hoursTab(page);
  await setSel(page, "Monday end", "17:00");
  backend.once("admin_set_hours", { mode: "http", status: 200, body: "invalid_hours" });
  await page.click("#hours-save");
  await page.locator("#hours-problem").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-problem"), /don't look right/);
});

ui("hours can't be loaded: a clear message and a working Try again", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET barber_hours", { mode: "fail-before" });
  await page.click("#tab-hours");
  await page.locator("#hours-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-error-text"), /Couldn't load the hours/);
  assert.equal(await page.locator(".hday").count(), 0, "no half-loaded editor to mislead anyone");
  await page.click("#hours-error-retry");
  await page.locator(".hday").first().waitFor();
});

// ================================================================ days off and extra hours
const openOff = async (page) => { await page.click("#ex-open-off"); await page.locator("#ex-dialog").waitFor({ state: "visible" }); };
const excRows = (page) => page.locator("#exc-list .exc");
const excCount = (page, n) => page.waitForFunction((n) => document.querySelectorAll("#exc-list .exc").length === n, n);

ui("block a whole day: saved, listed, and removing it asks first", async ({ page, backend }) => {
  await hoursTab(page);
  assert.match(await page.textContent("#exc-list"), /No days off or extra hours coming up for Matty/);
  await openOff(page);
  assert.equal(await page.getAttribute('#ex-barbers .chip[data-barber="Matty"]', "aria-checked"), "true");
  await page.fill("#ex-from", D.wed);
  await page.fill("#ex-to", D.wed);
  await page.fill("#ex-note", "Dentist");
  await page.click("#ex-save");
  await page.locator("#ex-dialog").waitFor({ state: "hidden" });
  assert.match(await toastText(page).textContent(), /^Blocked Matty: Wed 28 Oct\. Customers can't book it now\. No existing bookings were changed\.$/);
  await excCount(page, 1);
  assert.match(await excRows(page).first().textContent(), /Day off · Wed 28 Oct/);
  assert.match(await excRows(page).first().textContent(), /Dentist/);
  const saved = backend.exceptions[0];
  assert.deepEqual([saved.barber, saved.kind, saved.date_from, saved.date_to, saved.start_time, saved.end_time, saved.note], ["Matty", "off", D.wed, D.wed, null, null, "Dentist"]);

  await excRows(page).first().getByRole("button", { name: "Remove this block" }).click();
  assert.match(await page.textContent("#exc-list .confirm"), /Are you sure\?.*bookable again.*Bookings aren't affected/);
  await page.getByRole("button", { name: "Keep it" }).click();
  assert.equal(backend.exceptions.length, 1);
  await excRows(page).first().getByRole("button", { name: "Remove this block" }).click();
  await page.getByRole("button", { name: "Yes, remove it" }).click();
  await toastText(page).filter({ hasText: "Removed" }).waitFor();
  assert.equal(backend.exceptions.length, 0);
  assert.match(await page.textContent("#exc-list"), /No days off/);
});

ui("block several days in a row (a holiday) with one save", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  await page.fill("#ex-to", D.fri);
  await page.fill("#ex-note", "Holiday");
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.match(await toastText(page).textContent(), /Mon 26 Oct to Fri 30 Oct/);
  assert.equal(backend.exceptions.length, 1);
  assert.match(await excRows(page).first().textContent(), /Day off · Mon 26 Oct to Fri 30 Oct/);
});

ui("block a few hours on one day", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.click('#ex-type .chip[data-type="range"]');
  assert.equal(await page.locator("#ex-to-field").isVisible(), false, "one date for a time range");
  assert.equal(await page.locator("#ex-times").isVisible(), true);
  await page.fill("#ex-from", D.tue);
  await page.selectOption("#ex-start", "14:00");
  await page.selectOption("#ex-end", "15:30");
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.match(await toastText(page).textContent(), /Tomorrow|Tue 27 Oct 14:00–15:30/);
  const x = backend.exceptions[0];
  assert.deepEqual([x.start_time, x.end_time, x.date_from, x.date_to], ["14:00:00", "15:30:00", D.tue, D.tue]);
  assert.match(await excRows(page).first().textContent(), /Off · .*14:00–15:30/);
});

ui("open extra hours on a day off", async ({ page, backend }) => {
  await hoursTab(page);
  await page.click("#ex-open-extra");
  await page.locator("#ex-dialog").waitFor({ state: "visible" });
  assert.equal(await page.textContent("#ex-title"), "Open extra hours");
  assert.equal(await page.locator("#ex-type-field").isVisible(), false);
  await page.fill("#ex-from", D.sun2);
  await page.selectOption("#ex-start", "10:00");
  await page.selectOption("#ex-end", "13:00");
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Extra hours saved" }).waitFor();
  assert.equal(backend.exceptions[0].kind, "extra");
  assert.match(await excRows(page).first().textContent(), /Extra hours · .*10:00–13:00/);
  await excRows(page).first().getByRole("button", { name: "Remove extra hours" }).click();
  await page.getByRole("button", { name: "Yes, remove it" }).click();
  await toastText(page).filter({ hasText: "Removed" }).waitFor();
  assert.equal(backend.exceptions.length, 0);
});

ui("overlapping blocks are allowed and both are listed", async ({ page, backend }) => {
  await hoursTab(page);
  for (const [from, to] of [["10:00", "12:00"], ["11:00", "13:00"]]) {
    await openOff(page);
    await page.click('#ex-type .chip[data-type="range"]');
    await page.fill("#ex-from", D.thu);
    await page.selectOption("#ex-start", from);
    await page.selectOption("#ex-end", to);
    await page.click("#ex-save");
    await page.locator("#ex-dialog").waitFor({ state: "hidden" });
  }
  assert.equal(backend.exceptions.length, 2);
  await excCount(page, 2);
});

ui("the list is in date order, only upcoming, and only for the barber shown", async ({ page, backend }) => {
  backend.exceptions.push(
    exc("a1", "Matty", "off", D.fri, D.fri, null, null, "Later"),
    exc("a2", "Matty", "off", D.mon, D.mon, "10:00", "11:00", "Sooner"),
    exc("a3", "Alfie", "off", D.tue, D.tue, null, null, "Alfie's"),
    exc("a4", "Matty", "off", "2026-10-10", "2026-10-12", null, null, "Gone by"),
  );
  await hoursTab(page);
  assert.deepEqual(await page.locator("#exc-list .exc-note").allTextContents(), ["Sooner", "Later"]);
  await page.click('#hours-barbers .chip[data-barber="Alfie"]');
  await page.waitForFunction(() => document.querySelector("#exc-list .exc-note")?.textContent === "Alfie's");
});

ui("a bad entry is explained and nothing is saved: past date, last day before first, too long, end before start", async ({ page, backend }) => {
  await hoursTab(page);
  const add = () => backend.requests.filter((r) => r.key === "admin_add_exception").length;
  await openOff(page);
  await page.fill("#ex-from", "2026-10-20");
  await page.fill("#ex-to", "2026-10-20");
  await page.click("#ex-save");
  assert.match(await page.textContent("#ex-error"), /already passed/);
  await page.fill("#ex-from", D.fri);
  await page.fill("#ex-to", D.mon);
  await page.click("#ex-save");
  assert.match(await page.textContent("#ex-error"), /last day can't be before the first/);
  await page.fill("#ex-from", D.mon);
  await page.fill("#ex-to", "2027-02-01");
  await page.click("#ex-save");
  assert.match(await page.textContent("#ex-error"), /more than 2 months/);
  await page.click('#ex-type .chip[data-type="range"]');
  await page.fill("#ex-from", D.mon);
  await page.selectOption("#ex-start", "15:00");
  await page.selectOption("#ex-end", "14:00");
  await page.click("#ex-save");
  assert.match(await page.textContent("#ex-error"), /end time must be after the start/);
  await page.fill("#ex-from", "");
  await page.click("#ex-save");
  assert.match(await page.textContent("#ex-error"), /Pick a date/);
  assert.equal(add(), 0);
  assert.equal(backend.exceptions.length, 0);
});

ui("blocking over existing bookings: a clear warning listing them, 'Go back' saves nothing, 'Block anyway' keeps every booking", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Ten Tim", D.thu, "10:00"), bk("Matty", "Eleven Ed", D.thu, "11:00"), bk("Matty", "Afternoon Al", D.thu, "15:00"), bk("Alfie", "Alfie's Ann", D.thu, "10:00"));
  const before = JSON.stringify(backend.bookings.map((b) => [b.cancel_token, b.status, b.appointment_time]));
  await hoursTab(page);
  await openOff(page);
  await page.click('#ex-type .chip[data-type="range"]');
  await page.fill("#ex-from", D.thu);
  await page.selectOption("#ex-start", "10:00");
  await page.selectOption("#ex-end", "12:00");
  await page.click("#ex-save");
  await page.locator("#ex-warn").waitFor({ state: "visible" });
  const warn = await page.textContent("#ex-warn");
  assert.match(warn, /Matty already has 2 bookings in this time/);
  assert.match(warn, /Ten Tim/);
  assert.match(warn, /Eleven Ed/);
  assert.ok(!warn.includes("Afternoon Al") && !warn.includes("Alfie's Ann"));
  assert.match(warn, /07700 900123/, "with the phone number so they can be called");
  assert.match(warn, /will NOT be cancelled/);
  assert.equal(backend.exceptions.length, 0, "not saved yet");
  assert.equal(await page.locator("#ex-actions").isVisible(), false, "the normal Save is replaced by the clear choice");

  await page.getByRole("button", { name: "Go back" }).click();
  assert.equal(backend.exceptions.length, 0);
  assert.equal(await page.locator("#ex-actions").isVisible(), true);

  await page.click("#ex-save");
  await page.getByRole("button", { name: "Block anyway, keep the bookings" }).click();
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.match(await toastText(page).textContent(), /The 2 existing bookings were not changed/);
  assert.equal(backend.exceptions.length, 1);
  assert.equal(JSON.stringify(backend.bookings.map((b) => [b.cancel_token, b.status, b.appointment_time])), before, "no booking cancelled, moved or edited");
  assert.equal(backend.emails.length, 0, "nobody was emailed");
});

ui("a whole-day block over bookings, and those bookings then show a note in the Day list", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Sam Jones", D.mon, "10:00"));
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  await page.fill("#ex-to", D.mon);
  await page.click("#ex-save");
  await page.locator("#ex-warn").waitFor({ state: "visible" });
  assert.match(await page.textContent("#ex-warn"), /1 booking in this time/);
  await page.getByRole("button", { name: "Block anyway, keep the bookings" }).click();
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  await page.click("#tab-day");
  await page.fill("#day-input", D.mon);
  const card = page.locator(".card", { hasText: "Sam Jones" });
  await card.waitFor();
  assert.equal(await card.locator(".pill").textContent(), "Confirmed", "still confirmed");
  assert.match(await card.locator(".flag").textContent(), /In blocked time\. The booking is still on\./);
  assert.equal(await card.getByRole("button", { name: "Cancel booking" }).count(), 1, "and can still be cancelled by hand");
});

ui("if existing bookings can't be checked, nothing is blocked and they're told", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  backend.once("GET bookings", { mode: "fail-before" });
  await page.click("#ex-save");
  await page.locator("#ex-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#ex-error"), /Couldn't check your existing bookings.*nothing was saved/);
  assert.equal(backend.exceptions.length, 0);
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.equal(backend.exceptions.length, 1);
});

ui("blocking on a slow connection: 'Saving…' and a double tap makes ONE block", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  backend.once("admin_add_exception", { delay: 800 });
  await page.click("#ex-save");
  assert.equal(await page.textContent("#ex-save"), "Saving…");
  assert.equal(await page.locator("#ex-save").isDisabled(), true);
  assert.equal(await page.locator("#ex-close").isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#ex-dialog").isVisible(), true, "Esc doesn't lose a save in flight");
  await page.locator("#ex-save").dispatchEvent("click");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.equal(backend.exceptions.length, 1);
  assert.equal(backend.requests.filter((r) => r.key === "admin_add_exception").length, 1);
});

ui("blocking: the connection drops AFTER it saved: the page checks, confirms, and there is exactly one block", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  backend.once("admin_add_exception", { mode: "lose-response" });
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.equal(backend.exceptions.length, 1);
  await excCount(page, 1);
});

ui("blocking: the connection drops BEFORE it arrives: told it's unclear, the form is kept, and Save again makes exactly one block", async ({ page, backend }) => {
  await hoursTab(page);
  await openOff(page);
  await page.fill("#ex-from", D.mon);
  await page.fill("#ex-note", "Holiday");
  backend.once("admin_add_exception", { mode: "fail-before" });
  backend.once("GET barber_exceptions", {}); // the check for affected bookings gets through...
  backend.once("GET barber_exceptions", { mode: "fail-before" }); // ...but "did it save?" can't
  await page.click("#ex-save");
  await page.locator("#ex-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#ex-error"), /couldn't tell if that saved.*safe to repeat/);
  assert.equal(await page.inputValue("#ex-note"), "Holiday");
  assert.equal(backend.exceptions.length, 0);
  await page.click("#ex-save");
  await toastText(page).filter({ hasText: "Blocked Matty" }).waitFor();
  assert.equal(backend.exceptions.length, 1);
});

ui("removing a block: slow, dropped before, and dropped after are all handled; a second Yes is safe", async ({ page, backend }) => {
  backend.exceptions.push(exc("x1", "Matty", "off", D.mon, D.mon, null, null, "One"), exc("x2", "Matty", "off", D.tue, D.tue, null, null, "Two"));
  await hoursTab(page);
  const row = (id) => page.locator(`#exc-list .exc[data-id="${id}"]`);
  await row("x1").getByRole("button", { name: "Remove this block" }).click();
  backend.once("admin_remove_exception", { mode: "fail-before" });
  await row("x1").getByRole("button", { name: "Yes, remove it" }).click();
  await row("x1").locator(".msg-error").waitFor();
  assert.match(await row("x1").locator(".msg-error").textContent(), /Couldn't confirm that.*safe to repeat/);
  assert.equal(backend.exceptions.length, 2);
  backend.once("admin_remove_exception", { mode: "lose-response" });
  await row("x1").getByRole("button", { name: "Yes, remove it" }).click();
  await row("x1").waitFor({ state: "detached" });
  assert.equal(backend.exceptions.length, 1, "it did go through");
  await row("x2").getByRole("button", { name: "Remove this block" }).click();
  backend.once("admin_remove_exception", { delay: 600 });
  await row("x2").getByRole("button", { name: "Yes, remove it" }).click();
  assert.equal(await row("x2").getByRole("button", { name: "Removing…" }).isDisabled(), true);
  await row("x2").waitFor({ state: "detached" });
  assert.equal(backend.exceptions.length, 0);
});

// ================================================================ week view
ui("the week view lays out Monday to Sunday for one barber: hours, breaks, blocks, extra hours and bookings", async ({ page, backend }) => {
  backend.exceptions.push(exc("b1", "Matty", "off", D.wed, D.wed, null, null, "Dentist"), exc("b2", "Matty", "off", D.fri, D.fri, "14:00", "15:30", "School run"), exc("b3", "Matty", "extra", D.sun2, D.sun2, "10:00", "13:00"));
  backend.bookings.push(bk("Matty", "Sam Jones", D.mon, "10:00"), bk("Matty", "Pete Brown", D.mon, "11:30"), bk("Matty", "Priya Patel", D.tue, "14:00"),
    bk("Matty", "Cancelled Cat", D.tue, "15:00", { status: "cancelled" }), bk("Alfie", "Alfie's Al", D.mon, "10:00"));
  await ready(page);
  await page.click("#tab-week");
  await page.click("#week-next");
  await page.waitForFunction(() => document.querySelector("#week-label").textContent.includes("26 Oct"));
  await page.locator(".wday").first().waitFor();
  assert.equal(await page.textContent("#week-label"), "26 Oct – 1 Nov");
  const days = await page.locator(".wday .wday-name").allTextContents();
  assert.deepEqual(days, ["Mon 26 Oct", "Tue 27 Oct", "Wed 28 Oct", "Thu 29 Oct", "Fri 30 Oct", "Sat 31 Oct", "Sun 1 Nov"]);
  const text = (i) => page.locator(".wday").nth(i).textContent();
  assert.match(await text(0), /09:00–18:00/);
  assert.match(await text(0), /2 bookings/, "Alfie's booking is not counted for Matty");
  assert.match(await text(1), /09:00–18:00 · break 12:00–13:00/);
  assert.match(await text(1), /1 booking/, "the cancelled one isn't counted");
  assert.match(await text(2), /Off all day · Dentist/);
  assert.match(await text(4), /Off 14:00–15:30 · School run/);
  assert.match(await text(5), /09:00–13:00/);
  assert.match(await text(6), /Day off · extra 10:00–13:00/);
  assert.match(await text(3), /No bookings/);
  assert.equal(await page.locator(".wday").nth(1).locator(".seg.break").count(), 1);
  assert.equal(await page.locator(".wday").nth(2).locator(".seg.off").count(), 1);
  assert.equal(await page.locator(".wday").nth(6).locator(".seg.extra").count(), 1);
  assert.equal(await page.locator(".wday").nth(0).locator(".seg.booking").count(), 2);
  assert.equal(await page.locator(".wday").nth(1).locator(".seg.booking").count(), 1);
  assert.match(await page.textContent("#week-summary"), /Matty: 3 bookings this week/);
  assert.equal(await page.locator("#week-today").isVisible(), true);
});

ui("the week view switches barber, and a barber with no hours says so", async ({ page, backend }) => {
  backend.bookings.push(bk("Alfie", "Alfie's Al", D.mon, "10:00"));
  await weekTab(page);
  await page.click("#week-next");
  await page.locator(".wday .wday-name", { hasText: "Mon 26 Oct" }).waitFor();
  await page.click('#week-barbers .chip[data-barber="Alfie"]');
  await page.locator(".weekhint").waitFor();
  assert.match(await page.textContent(".weekhint"), /Alfie has no hours set yet.*09:00–18:00 every day/);
  assert.match(await page.locator(".wday").first().textContent(), /09:00–18:00/);
  assert.match(await page.locator(".wday").first().textContent(), /1 booking/);
  assert.match(await page.textContent("#week-summary"), /Alfie: 1 booking this week/);
});

ui("previous / next week and 'Back to this week'", async ({ page }) => {
  await weekTab(page);
  assert.equal(await page.textContent("#week-label"), "19–25 Oct");
  assert.equal(await page.locator("#week-today").isVisible(), false);
  assert.equal(await page.textContent("#week-sub"), "This week");
  await page.click("#week-next");
  await page.waitForFunction(() => document.querySelector("#week-label").textContent === "26 Oct – 1 Nov");
  await page.click("#week-next");
  await page.waitForFunction(() => document.querySelector("#week-label").textContent === "2–8 Nov");
  await page.click("#week-prev");
  await page.click("#week-prev");
  await page.click("#week-prev");
  await page.waitForFunction(() => document.querySelector("#week-label").textContent === "12–18 Oct");
  await page.click("#week-today");
  await page.waitForFunction(() => document.querySelector("#week-label").textContent === "19–25 Oct");
});

ui("the clocks-change week: bookings land on the right day and hours are the same wall-clock times", async ({ page, backend }) => {
  backend.bookings.push(
    bk("Matty", "Saturday Sid", D.sun.replace("25", "24"), "09:00"),   // last BST day (08:00 UTC)
    bk("Matty", "Late Lenny", D.sun, "23:30"),                          // last half hour of the 25-hour Sunday
    bk("Matty", "Monday Early", D.mon, "00:00"),                        // first minute of the next week
  );
  await weekTab(page);
  const sat = page.locator(".wday", { hasText: "Sat 24 Oct" });
  const sun = page.locator(".wday", { hasText: "Sun 25 Oct" });
  assert.match(await sat.textContent(), /1 booking/);
  assert.match(await sat.textContent(), /09:00–13:00/);
  assert.match(await sun.textContent(), /1 booking/, "23:30 is still Sunday");
  assert.match(await sun.textContent(), /Day off/);
  assert.match(await sun.textContent(), /Today/);
  await page.click("#week-next");
  await page.locator(".wday", { hasText: "Mon 26 Oct" }).waitFor();
  assert.match(await page.locator(".wday", { hasText: "Mon 26 Oct" }).textContent(), /1 booking/, "00:00 Monday belongs to Monday");
  assert.equal((await page.locator(".wday .wday-name").allTextContents()).length, 7);
});

ui("tap a day in the week view to open it in the Day tab, for that barber", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Sam Jones", D.tue, "10:00"), bk("Alfie", "Alfie's Al", D.tue, "11:00"));
  await weekTab(page);
  await page.click("#week-next");
  await page.locator(".wday", { hasText: "Tue 27 Oct" }).waitFor();
  await page.locator(".wday", { hasText: "Tue 27 Oct" }).click();
  assert.equal(await page.getAttribute("#tab-day", "aria-selected"), "true");
  await page.locator(".card", { hasText: "Sam Jones" }).waitFor();
  assert.match(await page.textContent("#day-label"), /Tue 27 Oct/);
  assert.deepEqual(await page.locator(".card .cust").allTextContents(), ["Sam Jones"], "filtered to Matty");
  assert.equal(await page.getAttribute('#barber-filter .chip[data-barber="Matty"]', "aria-pressed"), "true");
});

ui("the week view flags bookings that sit in blocked time or outside hours, without touching them", async ({ page, backend }) => {
  backend.exceptions.push(exc("b1", "Matty", "off", D.mon, D.mon, "10:00", "11:00"));
  backend.bookings.push(bk("Matty", "Blocked Bea", D.mon, "10:30"), bk("Matty", "Sunday Sam", D.sun2, "11:00"), bk("Matty", "Fine Fay", D.mon, "12:00"));
  await weekTab(page);
  await page.click("#week-next");
  await page.locator(".wday", { hasText: "Mon 26 Oct" }).waitFor();
  assert.match(await page.locator(".wday", { hasText: "Mon 26 Oct" }).locator(".wday-flag").textContent(), /1 booking is in blocked time/);
  assert.match(await page.locator(".wday", { hasText: "Sun 1 Nov" }).locator(".wday-flag").textContent(), /1 booking is outside working hours/);
  assert.equal(await page.locator(".wday", { hasText: "Tue 27 Oct" }).locator(".wday-flag").count(), 0);
  assert.match(await page.textContent("#week-summary"), /2 need a look/);
  assert.equal(await page.locator(".seg.booking.flagged").count(), 2);
  assert.ok(backend.bookings.every((b) => b.status !== "cancelled"), "no booking was cancelled");
});

ui("the week view fails gracefully and a quick change of week never shows the wrong week", async ({ page, backend }) => {
  await weekTab(page);
  backend.once("GET bookings", { mode: "fail-before" });
  await page.click("#week-next");
  await page.locator("#week-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#week-error-text"), /Couldn't load the week/);
  await page.click("#week-error-retry");
  await page.locator(".wday .wday-name", { hasText: "Mon 26 Oct" }).waitFor();
  assert.equal(await page.locator("#week-error").isVisible(), false);

  backend.once("GET bookings", { delay: 900 }); // the next week's answer is slow...
  await page.click("#week-next");
  await page.click("#week-prev");              // ...and they've already gone back
  await page.waitForTimeout(1300);
  assert.equal(await page.textContent("#week-label"), "26 Oct – 1 Nov");
  assert.equal((await page.locator(".wday .wday-name").first().textContent()), "Mon 26 Oct");
});

// ================================================================ Add booking follows the hours
const openAdd = async (page) => { await page.click("#add-open"); await page.locator("#times-msg, #add-times .chip").first().waitFor(); };
const addTimes = async (page) => { await page.waitForFunction(() => !document.querySelector("#times-msg") || document.querySelector("#times-msg").hidden || !/Checking/.test(document.querySelector("#times-msg").textContent)); return page.locator("#add-times .chip").allTextContents(); };

ui("Add booking only offers times inside hours, outside the break, not blocked, and not booked", async ({ page, backend }) => {
  backend.exceptions.push(exc("b1", "Matty", "off", D.tue, D.tue, "14:00", "15:00"));
  backend.bookings.push(bk("Matty", "Booked Bob", D.tue, "10:00"));
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", D.tue);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  const times = await addTimes(page);
  assert.deepEqual(times, ["09:00", "09:30", "10:30", "11:00", "11:30", "13:00", "13:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"]);
  assert.ok(!times.includes("12:00") && !times.includes("12:30"), "the break");
  assert.ok(!times.includes("14:00") && !times.includes("14:30"), "blocked");
  assert.ok(!times.includes("10:00"), "already booked");
  assert.ok(!times.includes("18:00"), "the last start is 17:30 when hours end at 18:00");
});

ui("Add booking: a day off shows a message instead of times; extra hours open it", async ({ page, backend }) => {
  backend.exceptions.push(exc("e1", "Matty", "extra", D.sun2, D.sun2, "10:00", "12:00"));
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", D.sun2.replace("11-01", "11-08")); // a plain Sunday
  await page.locator("#times-msg", { hasText: "No free times for Matty on this day" }).waitFor();
  assert.match(await page.textContent("#times-msg"), /day off, blocked or fully booked/);
  await page.fill("#add-date", D.sun2);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "10:00");
  assert.deepEqual(await addTimes(page), ["10:00", "10:30", "11:00", "11:30"]);
});

ui("Add booking: a barber with no hours yet still gets the original 09:00–18:00 grid", async ({ page }) => {
  await ready(page);
  await openAdd(page);
  await page.click('#add-barbers .chip[data-barber="Alfie"]');
  await page.fill("#add-date", D.mon);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  const times = await addTimes(page);
  assert.equal(times.length, 19);
  assert.equal(times.at(-1), "18:00");
});

ui("Add booking: the time becomes blocked while the form is open: the save is refused clearly, nothing is booked, the times refresh", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", D.mon);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  await page.click('#add-times .chip[data-time="11:00"]');
  await page.fill("#add-name", "Walk In Wendy");
  await page.fill("#add-phone", "07700 900123");
  backend.exceptions.push(exc("late", "Matty", "off", D.mon, D.mon, "10:30", "12:00")); // someone blocks it just now
  await page.click("#add-save");
  await page.locator("#add-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#add-error"), /outside working hours or is blocked/);
  assert.equal(backend.bookings.some((b) => b.customer_name === "Walk In Wendy"), false);
  assert.equal(await page.inputValue("#add-name"), "Walk In Wendy", "what they typed is kept");
  await page.waitForFunction(() => !document.querySelector('#add-times .chip[data-time="11:00"]') && document.querySelector("#add-times .chip"));
});

ui("Add booking then lands on the right day, and a new booking in the week view appears", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", D.mon);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  await page.click('#add-times .chip[data-time="09:30"]');
  await page.fill("#add-name", "Walk In Wendy");
  await page.fill("#add-phone", "07700 900123");
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.equal(backend.bookings.find((b) => b.customer_name === "Walk In Wendy").appointment_time, at(D.mon, "09:30"));
  await page.click("#tab-week");
  await page.click("#week-next");
  await page.locator(".wday", { hasText: "Mon 26 Oct" }).waitFor();
  assert.match(await page.locator(".wday", { hasText: "Mon 26 Oct" }).textContent(), /1 booking/);
});

ui("hours saved on the Hours tab are what Add booking offers straight away", async ({ page }) => {
  await hoursTab(page);
  await setSel(page, "Monday start", "11:00");
  await setSel(page, "Monday end", "13:00");
  await page.click("#hours-save");
  await toastText(page).filter({ hasText: "hours saved" }).waitFor();
  await page.click("#tab-day");
  await openAdd(page);
  await page.fill("#add-date", D.mon);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "11:00");
  assert.deepEqual(await addTimes(page), ["11:00", "11:30", "12:00", "12:30"]);
});

// ================================================================ phone layout
for (const width of [360, 390]) {
  ui(`phone ${width}px: week, hours and the block form have no sideways scroll and big tap targets`, { page: { viewport: { width, height: 780 } } }, async ({ page, backend }) => {
    backend.exceptions.push(exc("l1", "Matty", "off", D.mon, D.fri, null, null, "A very long note about the holiday that keeps going and going so it has to wrap nicely on a narrow screen"));
    const overflow = () => page.evaluate((w) => Math.max(document.documentElement.scrollWidth - w, window.innerWidth - w, window.visualViewport.scale < 0.999 ? 1 : 0), width);
    const small = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent && !e.closest("[hidden]") && !e.closest("dialog:not([open])"))
      .map((e) => ({ t: (e.getAttribute("aria-label") || e.textContent || e.id).trim().slice(0, 28), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((x) => x.h < 44 || x.w < 44), sel);
    await weekTab(page);
    assert.ok((await overflow()) <= 0, "week: no sideways scroll");
    assert.deepEqual(await small("#pane-week button"), []);
    await page.click("#tab-hours");
    await page.locator(".hday").first().waitFor();
    assert.ok((await overflow()) <= 0, "hours: no sideways scroll");
    assert.deepEqual(await small("#pane-hours button, #pane-hours select, .tab"), [], "every button and picker is at least 44px");
    await day(page, 2).getByRole("button", { name: /Tuesday: remove break/ }).waitFor();
    await page.click("#ex-open-off");
    await page.locator("#ex-dialog").waitFor({ state: "visible" });
    assert.ok((await overflow()) <= 0, "dialog: no sideways scroll");
    assert.deepEqual(await small("#ex-dialog button, #ex-dialog input, #ex-dialog select"), []);
    const fonts = await page.evaluate(() => [...document.querySelectorAll("#ex-dialog input, #ex-dialog select, #pane-hours select")].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(fonts.every((f) => f >= 16), "16px+ so iPhones don't zoom in");
  });
}

// ================================================================ before hours.sql has been run
ui("before hours.sql is run: the day list and Add booking still work (original grid), and Week/Hours explain what's missing", async ({ page, backend }) => {
  const gone = { mode: "http", status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.barber_hours'" } };
  backend.always("GET barber_hours", gone);
  backend.always("GET barber_exceptions", gone);
  backend.always("bookable_slots", { mode: "http", status: 404, body: { code: "PGRST202", message: "Could not find the function" } });
  await ready(page);
  assert.equal(await page.locator("#list-error").isVisible(), false, "today's list loads as before, with no error");
  assert.match(await page.textContent(".empty"), /No bookings on this day/);
  await page.click("#add-open");
  await page.fill("#add-date", D.mon);
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  assert.equal((await page.locator("#add-times .chip").allTextContents()).length, 19, "the original grid");
  await page.click('#add-times .chip[data-time="10:00"]');
  await page.fill("#add-name", "Walk In Wendy");
  await page.fill("#add-phone", "07700 900123");
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  await page.click("#tab-week");
  await page.locator("#week-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#week-error-text"), /aren't set up yet.*supabase\/hours\.sql/);
  await page.click("#tab-hours");
  await page.locator("#hours-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#hours-error-text"), /aren't set up yet.*HOURS_SETUP\.md/);
});

ui("while a hours warning is open there is just one clear Save choice, and it comes back after", async ({ page, backend }) => {
  backend.bookings.push(bk("Matty", "Late Larry", D.mon, "17:00"));
  await hoursTab(page);
  await setSel(page, "Monday end", "16:00");
  await page.click("#hours-save");
  await page.locator("#hours-warn").waitFor({ state: "visible" });
  assert.equal(await page.locator("#hours-save").isVisible(), false, "the ordinary Save is hidden");
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(await page.locator("#hours-save").isVisible(), true);
  assert.equal(await page.locator("#hours-warn").isVisible(), false);
});
