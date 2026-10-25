"use strict";
// Browser tests for the admin page (admin.html) and the Admin link on the main site.
// Real Chromium, the real page code and the real supabase-js, talking to FakeSupabase (see helpers/),
// on a fixed clock: Sunday 25 Oct 2026, 13:10 UK time. That is the day the clocks go back, so the day is 25 hours long.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { launch, openPage, FakeSupabase, NOW, at } = require("./helpers/site");

const TODAY = "2026-10-25";
const TOMORROW = "2026-10-26";
const YESTERDAY = "2026-10-24";

const USERS = {
  matty: { id: "u-matty", email: "matty@example.com" },
  alfie: { id: "u-alfie", email: "alfie@example.com" },
  cust: { id: "u-cust", email: "cust@example.com" },
  stranger: { id: "u-stranger", email: "stranger@example.com" },
};

const b = (barber, name, date, time, extra = {}) => ({
  barber, customer_name: name, appointment_time: at(date, time), customer_phone: "07700 900111",
  customer_email: `${name.split(" ")[0].toLowerCase()}@example.com`, cancel_token: crypto.randomUUID(), user_id: null, ...extra,
});

function makeBackend() {
  return new FakeSupabase({
    now: NOW,
    users: Object.values(USERS),
    admins: [{ email: "matty@example.com", barber_name: "Matty" }, { email: "Alfie@Example.com", barber_name: "Alfie" }],
    bookings: [
      b("Matty", "Dave Smith", TODAY, "10:00"),                                     // already over
      b("Matty", "Sam Jones", TODAY, "14:00", { customer_phone: "07700 900222" }),
      b("Alfie", "Pete Brown", TODAY, "15:30", { customer_email: null }),            // no email on file
      b("Matty", "Carl Cancelled", TODAY, "16:00", { status: "cancelled" }),
      b("Matty", "Late Larry", TODAY, "23:30"),                                      // last minutes of the 25-hour day
      b("Alfie", "Early Ed", TOMORROW, "00:00"),                                     // first minute of the NEXT day
      b("Matty", "Tomorrow Tim", TOMORROW, "10:00"),
      b("Alfie", "Yesterday Yan", YESTERDAY, "09:00"),
      b("Matty", "Cathy Customer", "2026-10-27", "11:00", { user_id: USERS.cust.id, customer_email: USERS.cust.email }),
    ],
  });
}

let env;
before(async () => { env = await launch(); });
after(async () => { await env.close(); });

// run a test with a fresh backend + page
function ui(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  test(name, async () => {
    const backend = opts.backend || makeBackend();
    const page = await openPage(env, backend, { signedInAs: USERS.matty, ...opts });
    try {
      await fn({ page, backend });
      assert.deepEqual(page.errors, [], "no uncaught errors in the page");
    } finally {
      await page.context().close();
    }
  });
}

const card = (page, name) => page.locator(".card", { hasText: name });
const names = (page) => page.locator(".card .cust").allTextContents();
const toastText = (page) => page.locator("#toast-text");
const ready = async (page) => { await page.locator("#v-app").waitFor(); await page.locator(".card, .empty").first().waitFor(); };
const chip = (page, time) => page.locator(`#add-times .chip[data-time="${time}"]`);
const openAdd = async (page) => { await page.click("#add-open"); await page.locator("#add-times .chip").first().waitFor(); };
const fillCustomer = async (page, name = "Walk In Wendy", phone = "07700 900123", email = "") => {
  await page.fill("#add-name", name); await page.fill("#add-phone", phone); await page.fill("#add-email", email);
};
const bookingRequests = (backend) => backend.requests.filter((r) => r.key === "GET bookings");

// ================================================================ access
ui("a signed-out visitor sees only a sign-in form, and nothing is requested", { signedInAs: null }, async ({ page, backend }) => {
  await page.locator("#v-signin").waitFor();
  assert.equal(await page.locator("#v-app").isVisible(), false);
  assert.equal(await page.locator("#add-open").isVisible(), false);
  assert.equal(backend.requests.filter((r) => r.path.startsWith("/rest/")).length, 0, "no data requests at all");
});

ui("sign-in sends a magic link that comes back to the admin page", { signedInAs: null }, async ({ page, backend }) => {
  await page.fill("#signin-email", "matty@example.com");
  await page.click("#signin-submit");
  await page.locator("#signin-msg[data-kind=ok]").waitFor();
  assert.match(await page.textContent("#signin-msg"), /Check your inbox/);
  assert.equal(backend.otpRequests.length, 1);
  assert.equal(backend.otpRequests[0].body.email, "matty@example.com");
  assert.match(backend.otpRequests[0].redirect, /\/admin\.html$/);
});

ui("sign-in: a bad email is caught, and a failure is explained", { signedInAs: null }, async ({ page, backend }) => {
  await page.fill("#signin-email", "nope");
  await page.click("#signin-submit");
  assert.match(await page.textContent("#signin-msg"), /valid email/);
  assert.equal(backend.otpRequests.length, 0);
  backend.once("otp", { mode: "http", status: 429, body: { message: "email rate limit exceeded" } });
  await page.fill("#signin-email", "matty@example.com");
  await page.click("#signin-submit");
  await page.locator("#signin-msg[data-kind=error]").waitFor();
  assert.match(await page.textContent("#signin-msg"), /Too many/);
  assert.equal(await page.locator("#signin-submit").isEnabled(), true, "they can try again");
});

ui("a signed-in customer who is not an admin gets 'No admin access' and no data is ever requested", { signedInAs: USERS.cust }, async ({ page, backend }) => {
  await page.locator("#v-denied").waitFor();
  assert.match(await page.textContent("#v-denied"), /No admin access/);
  assert.match(await page.textContent("#denied-email"), /cust@example\.com/);
  assert.equal(await page.locator("#v-app").isVisible(), false);
  assert.equal(await page.locator("#add-open").isVisible(), false);
  assert.equal(bookingRequests(backend).length, 0, "the page never even asks for bookings");
  const body = await page.textContent("body");
  for (const secret of ["Dave Smith", "Sam Jones", "07700"]) assert.ok(!body.includes(secret), `page does not contain ${secret}`);
});

ui("a customer cannot get bookings even by calling the API from the console: the database refuses", { signedInAs: USERS.cust }, async ({ page }) => {
  await page.locator("#v-denied").waitFor();
  const seen = await page.evaluate(async () => {
    const c = window.supabase.createClient("https://mddhykzuxrywhtmjwajy.supabase.co", "anon", { auth: { storageKey: "blain-auth", persistSession: true } });
    const all = await c.from("bookings").select("customer_name, customer_phone");
    const made = await c.rpc("admin_create_booking", { p_barber: "Matty", p_service: "Haircut", p_time: new Date(Date.now() + 864e5 * 9).toISOString(), p_name: "Hax", p_phone: "07700900999", p_email: null, p_token: crypto.randomUUID() });
    return { names: (all.data || []).map((r) => r.customer_name), made: made.error && made.error.code };
  });
  assert.deepEqual(seen.names, ["Cathy Customer"], "a customer only ever sees their own booking");
  assert.equal(seen.made, "42501", "and cannot add bookings");
});

ui("a guest cannot call the admin functions or read bookings", { signedInAs: null }, async ({ page }) => {
  await page.locator("#v-signin").waitFor();
  const r = await page.evaluate(async () => {
    const c = window.supabase.createClient("https://mddhykzuxrywhtmjwajy.supabase.co", "anon", { auth: { persistSession: false } });
    const rows = await c.from("bookings").select("*");
    const me = await c.rpc("admin_me");
    return { rows: rows.error && rows.error.code, data: rows.data, me: me.error && me.error.code };
  });
  assert.equal(r.rows, "42501");
  assert.equal(r.data, null);
  assert.equal(r.me, "42501");
});

ui("a second admin (Alfie, email in a different letter case) gets in too, and a 'Hi' greeting", { signedInAs: USERS.alfie }, async ({ page }) => {
  await ready(page);
  assert.equal(await page.textContent("#who"), "Hi Alfie");
});

ui("an admin whose access is removed while the page is open is shown 'No admin access' on their next action", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  backend.admins.length = 0;
  await chip(page, "17:00").click();
  await fillCustomer(page);
  await page.click("#add-save");
  await page.locator("#v-denied").waitFor();
  assert.equal(backend.bookings.some((x) => x.customer_name === "Walk In Wendy"), false);
});

ui("sign out returns to the sign-in form", async ({ page }) => {
  await ready(page);
  await page.click("#signout");
  await page.locator("#v-signin").waitFor();
  assert.equal(await page.locator("#add-open").isVisible(), false);
});

ui("an expired sign-in sends them back to sign in, with a clear message", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET bookings", { mode: "http", status: 401, body: { code: "PGRST301", message: "JWT expired" } });
  await page.click("#refresh");
  await page.locator("#v-signin").waitFor();
  assert.match(await page.textContent("#signin-msg"), /expired/);
});

// ================================================================ the Admin link on the main site
async function navAdminVisible(user) {
  const backend = makeBackend();
  const page = await openPage(env, backend, { path: "/index.html", signedInAs: user, viewport: { width: 1280, height: 800 } });
  try {
    if (user) await page.locator("#nav-account").waitFor({ state: "visible" });
    await page.waitForTimeout(400); // give the admin check time to answer
    return { visible: await page.locator("#nav-admin").isVisible(), asked: backend.requests.some((r) => r.key === "admin_me"), errors: page.errors, page: null };
  } finally {
    await page.context().close();
  }
}
test("main site: an admin sees the Admin link; customers and guests never do", async () => {
  const admin = await navAdminVisible(USERS.matty);
  assert.equal(admin.visible, true);
  assert.deepEqual(admin.errors, []);
  assert.equal((await navAdminVisible(USERS.cust)).visible, false);
  assert.equal((await navAdminVisible(USERS.stranger)).visible, false);
  const guest = await navAdminVisible(null);
  assert.equal(guest.visible, false);
  assert.equal(guest.asked, false, "guests don't even trigger the check");
});

test("main site: the Admin link goes to the admin page, and disappears on sign out", async () => {
  const backend = makeBackend();
  const page = await openPage(env, backend, { path: "/index.html", signedInAs: USERS.matty, viewport: { width: 1280, height: 800 } });
  try {
    await page.locator("#nav-admin").waitFor({ state: "visible" });
    assert.equal(await page.getAttribute("#nav-admin", "href"), "admin.html");
    await page.click("#nav-signout");
    await page.locator("#nav-signin").waitFor({ state: "visible" });
    assert.equal(await page.locator("#nav-admin").isVisible(), false);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test("main site: if the admin check fails (e.g. admin.sql not run yet) there is simply no link and nothing breaks", async () => {
  const backend = makeBackend();
  backend.always("admin_me", { mode: "http", status: 404, body: { code: "PGRST202", message: "function not found" } });
  const page = await openPage(env, backend, { path: "/index.html", signedInAs: USERS.matty, viewport: { width: 1280, height: 800 } });
  try {
    await page.locator("#nav-account").waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#nav-admin").isVisible(), false);
    assert.equal(await page.locator("#nav-mybookings").isVisible(), true, "My bookings still works");
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

// ================================================================ the bookings view
ui("today's bookings are listed in time order with everything the barber needs", async ({ page }) => {
  await ready(page);
  assert.match(await page.textContent("#day-label"), /Today · Sun 25 Oct/);
  assert.deepEqual(await names(page), ["Dave Smith", "Sam Jones", "Pete Brown", "Carl Cancelled", "Late Larry"]);
  const times = await page.locator(".card .time").allTextContents();
  assert.deepEqual(times, ["10:00", "14:00", "15:30", "16:00", "23:30"]);

  const sam = card(page, "Sam Jones");
  assert.match(await sam.textContent(), /Matty · Haircut/);
  assert.equal(await sam.locator(".pill").textContent(), "Confirmed");
  assert.equal(await sam.locator(".callbtn").textContent(), "07700 900222");
  assert.equal(await sam.locator(".callbtn").getAttribute("href"), "tel:07700900222");
  assert.equal(await sam.locator(".mailto").textContent(), "sam@example.com");
  assert.equal(await sam.locator(".mailto").getAttribute("href"), "mailto:sam@example.com");
  assert.match(await card(page, "Pete Brown").textContent(), /No email/);
  assert.equal(await card(page, "Dave Smith").locator(".pill").textContent(), "Done");
  assert.equal(await card(page, "Carl Cancelled").locator(".pill").textContent(), "Cancelled");
  assert.match(await page.textContent("#summary"), /4 bookings · 1 cancelled/);
});

ui("the day runs midnight to midnight UK time, on a 25-hour clocks-change day", async ({ page }) => {
  await ready(page);
  assert.ok((await names(page)).includes("Late Larry"), "23:30 is still the 25th");
  assert.ok(!(await names(page)).includes("Early Ed"), "00:00 on the 26th is not");
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Tomorrow"));
  await ready(page);
  assert.deepEqual(await names(page), ["Early Ed", "Tomorrow Tim"]);
  assert.deepEqual(await page.locator(".card .time").allTextContents(), ["00:00", "10:00"]);
});

ui("previous / next day, the date picker and 'Back to today'", async ({ page }) => {
  await ready(page);
  assert.equal(await page.locator("#today-btn").isVisible(), false);
  await page.click("#prev");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Yesterday"));
  await ready(page);
  assert.deepEqual(await names(page), ["Yesterday Yan"]);
  assert.equal(await card(page, "Yesterday Yan").locator(".pill").textContent(), "Done");
  assert.equal(await card(page, "Yesterday Yan").locator(".btn").count(), 0, "a finished booking has no cancel button");
  assert.equal(await page.locator("#today-btn").isVisible(), true);

  await page.fill("#day-input", "2026-10-27");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Tue 27 Oct"));
  await ready(page);
  assert.deepEqual(await names(page), ["Cathy Customer"]);

  await page.click("#today-btn");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Today"));
  await ready(page);
  assert.equal((await names(page)).length, 5);
  assert.equal(await page.locator("#today-btn").isVisible(), false);
});

ui("an empty day says so, with no confusing blanks", async ({ page }) => {
  await ready(page);
  await page.fill("#day-input", "2026-12-01");
  await page.locator(".empty").waitFor();
  assert.equal(await page.textContent(".empty"), "No bookings on this day.");
  assert.match(await page.textContent("#summary"), /^0 bookings/);
});

ui("filter by barber", async ({ page }) => {
  await ready(page);
  await page.click('#barber-filter .chip[data-barber="Alfie"]');
  assert.deepEqual(await names(page), ["Pete Brown"]);
  assert.match(await page.textContent("#summary"), /1 booking for Alfie/);
  await page.click('#barber-filter .chip[data-barber="Matty"]');
  assert.deepEqual(await names(page), ["Dave Smith", "Sam Jones", "Carl Cancelled", "Late Larry"]);
  assert.equal(await page.getAttribute('#barber-filter .chip[data-barber="Matty"]', "aria-pressed"), "true");
  assert.equal(await page.getAttribute('#barber-filter .chip[data-barber="all"]', "aria-pressed"), "false");
  await page.click("#next"); // the filter sticks when changing day
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Tomorrow"));
  await ready(page);
  assert.deepEqual(await names(page), ["Tomorrow Tim"]);
  await page.click('#barber-filter .chip[data-barber="all"]');
  assert.equal((await names(page)).length, 2);
});

ui("filtering to a barber with no bookings that day says so", async ({ page }) => {
  await ready(page);
  await page.fill("#day-input", "2026-10-27");
  await page.locator(".card").first().waitFor();
  await page.click('#barber-filter .chip[data-barber="Alfie"]');
  assert.equal(await page.textContent(".empty"), "No bookings for Alfie on this day.");
});

ui("customer details are shown as plain text: no HTML or script from a customer name can run", async ({ page, backend }) => {
  await ready(page);
  backend.bookings.push(b("Matty", '<img src=x onerror="window.pwned=1"><b>Eve</b>', TODAY, "17:00", { customer_email: '"><script>window.pwned=2</script>@x.com' }));
  await page.click("#refresh");
  await page.locator(".card", { hasText: "Eve" }).waitFor();
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator(".card img, .card script, .card b").count(), 0);
});

ui("returning to the app refreshes the list (a booking made meanwhile appears)", async ({ page, backend }) => {
  await ready(page);
  backend.bookings.push(b("Alfie", "Just Booked Jim", TODAY, "18:00"));
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.locator(".card", { hasText: "Just Booked Jim" }).waitFor();
});

ui("the Refresh button reloads and shows when it last updated", async ({ page, backend }) => {
  await ready(page);
  assert.match(await page.textContent("#updated"), /Updated \d\d:\d\d/);
  backend.bookings.push(b("Alfie", "Refresh Rob", TODAY, "18:00"));
  await page.click("#refresh");
  await page.locator(".card", { hasText: "Refresh Rob" }).waitFor();
});

// ================================================================ cancelling
ui("cancel: 'Are you sure?' first, 'Keep booking' backs out without changing anything", async ({ page, backend }) => {
  await ready(page);
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  assert.match(await sam.locator(".confirm").textContent(), /Are you sure\?.*Sam's 14:00 booking with Matty.*Sam will be emailed/);
  await sam.getByRole("button", { name: "Keep booking" }).click();
  assert.equal(await sam.locator(".confirm").count(), 0);
  assert.equal(await sam.locator(".pill").textContent(), "Confirmed");
  assert.equal(backend.requests.filter((r) => r.key === "cancel_booking").length, 0);
});

ui("cancel: the booking is cancelled, the slot is freed, and the cancellation email goes out", async ({ page, backend }) => {
  await ready(page);
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "Cancelled" }).waitFor();
  assert.equal(await toastText(page).textContent(), "Cancelled. 14:00 with Matty is free again. Sam has been emailed.");
  await card(page, "Sam Jones").locator(".pill", { hasText: "Cancelled" }).waitFor();
  assert.equal(await card(page, "Sam Jones").locator(".btn").count(), 0, "no cancel button on a cancelled booking");
  assert.match(await page.textContent("#summary"), /3 bookings · 2 cancelled/);

  const stored = backend.bookings.find((x) => x.customer_name === "Sam Jones");
  assert.equal(stored.status, "cancelled");
  assert.deepEqual(backend.emails.filter((e) => e.kind === "cancelled").map((e) => e.to), ["sam@example.com"]);

  await openAdd(page);
  assert.equal(await chip(page, "14:00").count(), 1, "14:00 is a free time for Matty again");
});

ui("cancel: a booking with no email says so, so the barber knows to phone", async ({ page, backend }) => {
  await ready(page);
  const pete = card(page, "Pete Brown");
  await pete.locator(".btn-danger-ghost").click();
  assert.match(await pete.locator(".confirm").textContent(), /no email on file, so let Pete know yourself/);
  await pete.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "Cancelled" }).waitFor();
  assert.match(await toastText(page).textContent(), /No email on file, so tell them yourself\./);
  assert.equal(backend.emails.length, 0);
});

ui("cancel: only one 'Are you sure?' is open at a time, and it survives a list refresh", async ({ page }) => {
  await ready(page);
  await card(page, "Sam Jones").locator(".btn-danger-ghost").click();
  await page.click("#refresh");
  await page.locator("#refresh", { hasText: "Refresh" }).waitFor();
  assert.equal(await page.locator(".confirm").count(), 1, "the question is still there after refreshing");
  await card(page, "Pete Brown").locator(".btn-danger-ghost").click();
  assert.equal(await page.locator(".confirm").count(), 1, "opening another closes the first");
  assert.equal(await card(page, "Pete Brown").locator(".confirm").count(), 1);
});

ui("cancel on a slow connection: shows 'Cancelling…', and tapping twice sends ONE request", async ({ page, backend }) => {
  await ready(page);
  backend.once("cancel_booking", { delay: 700 });
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  const yes = sam.locator(".btn-danger");
  await yes.click();
  assert.equal(await yes.textContent(), "Cancelling…");
  assert.equal(await yes.isDisabled(), true);
  await yes.click({ force: true, timeout: 500 }).catch(() => {});
  await toastText(page).filter({ hasText: "Cancelled" }).waitFor();
  assert.equal(backend.requests.filter((r) => r.key === "cancel_booking").length, 1);
  assert.equal(backend.emails.length, 1);
});

ui("cancel: the connection drops AFTER the cancel was applied: the list shows the truth and only ONE email went out", async ({ page, backend }) => {
  await ready(page);
  backend.once("cancel_booking", { mode: "lose-response" });
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await card(page, "Sam Jones").locator(".pill", { hasText: "Cancelled" }).waitFor();
  assert.equal(backend.emails.length, 1);
});

ui("cancel: the connection drops BEFORE the cancel arrives: they're told, nothing changed, and Yes again works", async ({ page, backend }) => {
  await ready(page);
  backend.once("cancel_booking", { mode: "fail-before" });
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await sam.locator(".msg-error").waitFor();
  assert.match(await sam.locator(".msg-error").textContent(), /Couldn't confirm the cancellation/);
  assert.equal(await sam.locator(".pill").textContent(), "Confirmed");
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "Cancelled" }).waitFor();
  assert.equal(backend.emails.length, 1);
});

ui("cancel: a hung request times out with a clear message", async ({ page, backend }) => {
  await ready(page);
  backend.once("cancel_booking", { mode: "hang" });
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await sam.locator(".msg-error").waitFor({ timeout: 5000 });
  assert.equal(await sam.getByRole("button", { name: "Yes, cancel booking" }).isEnabled(), true);
});

ui("cancel: already cancelled by someone else meanwhile is handled calmly", async ({ page, backend }) => {
  await ready(page);
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  backend.cancel(backend.bookings.find((x) => x.customer_name === "Sam Jones").cancel_token); // e.g. the customer cancelled it
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "already cancelled" }).waitFor();
  assert.equal(backend.emails.filter((e) => e.kind === "cancelled").length, 1, "no second email");
  await card(page, "Sam Jones").locator(".pill", { hasText: "Cancelled" }).waitFor();
});

ui("cancel: the appointment time passes while the page is open: it can't be cancelled and they're told", async ({ page, backend }) => {
  await ready(page);
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  backend.nowMs = Date.parse("2026-10-25T14:30:00Z");
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "already passed" }).waitFor();
  assert.equal(backend.bookings.find((x) => x.customer_name === "Sam Jones").status, "confirmed");
});

ui("cancel: the booking was deleted elsewhere", async ({ page, backend }) => {
  await ready(page);
  const sam = card(page, "Sam Jones");
  await sam.locator(".btn-danger-ghost").click();
  backend.bookings.splice(backend.bookings.findIndex((x) => x.customer_name === "Sam Jones"), 1);
  await sam.getByRole("button", { name: "Yes, cancel booking" }).click();
  await toastText(page).filter({ hasText: "no longer exists" }).waitFor();
  assert.equal(await card(page, "Sam Jones").count(), 0, "and it's gone from the list");
});

// ================================================================ adding a booking
ui("add booking: pick barber, date, a FREE time, enter name and phone, save: it appears in the list", async ({ page, backend }) => {
  await ready(page);
  await page.click("#add-open");
  await page.locator("#add-times .chip").first().waitFor();
  assert.equal(await page.getAttribute('#add-barbers .chip[data-barber="Matty"]', "aria-checked"), "true", "defaults to the signed-in barber");
  assert.equal(await page.inputValue("#add-date"), TODAY);
  assert.equal(await page.inputValue("#add-service"), "Haircut");

  const times = await page.locator("#add-times .chip").allTextContents();
  assert.equal(times[0], "13:30", "nothing before the next half hour (13:10 now)");
  assert.ok(!times.includes("14:00"), "Sam's 14:00 with Matty is taken, so not offered");
  assert.ok(times.includes("15:30"), "15:30 is Alfie's booking, so it's free for Matty");
  assert.ok(times.includes("16:00"), "16:00 was cancelled, so it's free");
  assert.match(await page.textContent("#time-note"), /free/);

  await chip(page, "17:00").click();
  assert.equal(await chip(page, "17:00").getAttribute("aria-checked"), "true");
  await fillCustomer(page, "Walk In Wendy", "07700 900123");
  await page.click("#add-save");
  await page.locator("#add-dialog").waitFor({ state: "hidden" });
  assert.match(await toastText(page).textContent(), /^Booked: Walk In Wendy with Matty, Today · Sun 25 Oct at 17:00\.$/);
  await card(page, "Walk In Wendy").waitFor();
  assert.deepEqual(await page.locator(".card .time").allTextContents(), ["10:00", "14:00", "15:30", "16:00", "17:00", "23:30"]);

  const saved = backend.bookings.find((x) => x.customer_name === "Walk In Wendy");
  assert.equal(saved.appointment_time, at(TODAY, "17:00"));
  assert.equal(saved.barber, "Matty");
  assert.equal(saved.customer_phone, "07700 900123");
  assert.equal(saved.customer_email, null);
  assert.equal(saved.status, "confirmed");
  assert.equal(backend.emails.length, 0, "no email address, so no email");
});

ui("add booking: with an email, the customer is sent a confirmation", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:30").click();
  await fillCustomer(page, "Emma Email", "07700 900124", "emma@example.com");
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.match(await toastText(page).textContent(), /confirmation has been emailed to emma@example\.com/);
  assert.deepEqual(backend.emails.map((e) => [e.kind, e.to]), [["confirmed", "emma@example.com"]]);
});

ui("add booking: choosing another barber and a future date shows THAT barber's free times for THAT day", async ({ page }) => {
  await ready(page);
  await openAdd(page);
  await page.click('#add-barbers .chip[data-barber="Alfie"]');
  await page.fill("#add-date", TOMORROW);
  await page.waitForFunction(() => document.querySelectorAll("#add-times .chip").length > 0 && document.querySelector("#add-times .chip").dataset.time === "09:00");
  const times = await page.locator("#add-times .chip").allTextContents();
  assert.equal(times.length, 19, "the whole grid: Alfie's only booking tomorrow is at 00:00, outside the grid");
  assert.equal(times[0], "09:00");
});

ui("add booking: booking tomorrow for Alfie jumps the list to tomorrow and shows it, even if the filter was on Matty", async ({ page, backend }) => {
  await ready(page);
  await page.click('#barber-filter .chip[data-barber="Matty"]');
  await openAdd(page);
  await page.click('#add-barbers .chip[data-barber="Alfie"]');
  await page.click("#add-tomorrow");
  await page.waitForFunction(() => document.querySelector("#add-times .chip")?.dataset.time === "09:00");
  await chip(page, "11:00").click();
  await fillCustomer(page, "Alfie's Andy", "07700 900125");
  await page.click("#add-save");
  await card(page, "Alfie's Andy").waitFor();
  assert.match(await page.textContent("#day-label"), /Tomorrow/);
  assert.equal(await page.getAttribute('#barber-filter .chip[data-barber="all"]', "aria-pressed"), "true", "filter reset so the new booking is visible");
  assert.equal(backend.bookings.find((x) => x.customer_name === "Alfie's Andy").appointment_time, at(TOMORROW, "11:00"));
});

ui("add booking: the free times for a day exclude exactly that barber's bookings (tomorrow, Alfie: Early Ed is 00:00 so none)", async ({ page }) => {
  await ready(page);
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Tomorrow"));
  await ready(page);
  await openAdd(page);
  assert.equal(await page.inputValue("#add-date"), TOMORROW, "defaults to the day being viewed");
  const times = await page.locator("#add-times .chip").allTextContents();
  assert.ok(!times.includes("10:00"), "Matty has Tomorrow Tim at 10:00");
  assert.equal(times.length, 18);
});

ui("add booking: viewing a past day, the form still starts on today (can't book the past)", async ({ page }) => {
  await ready(page);
  await page.click("#prev");
  await page.waitForFunction(() => document.querySelector("#day-label").textContent.includes("Yesterday"));
  await openAdd(page);
  assert.equal(await page.inputValue("#add-date"), TODAY);
  assert.equal(await page.getAttribute("#add-date", "min"), TODAY);
});

ui("add booking: typing a past date snaps back to today", async ({ page }) => {
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", "2026-10-20");
  await page.waitForFunction(() => document.querySelector("#add-date").value === "2026-10-25");
  assert.equal(await page.inputValue("#add-date"), TODAY);
});

ui("add booking: late in the day with nothing left, it says so instead of showing an empty box", { now: Date.parse("2026-10-25T18:40:00Z") }, async ({ page }) => {
  await ready(page);
  await page.click("#add-open");
  await page.locator("#times-msg", { hasText: "No free times left today for Matty" }).waitFor();
  assert.equal(await page.locator("#add-times .chip").count(), 0);
  await page.click("#add-tomorrow");
  await page.locator("#add-times .chip").first().waitFor();
});

ui("add booking: a fully booked day says so", async ({ page, backend }) => {
  const day = "2026-11-02";
  for (let h = 9; h <= 18; h++) for (const m of ["00", "30"]) if (!(h === 18 && m === "30")) backend.bookings.push(b("Matty", `Fill ${h}${m}`, day, `${String(h).padStart(2, "0")}:${m}`));
  await ready(page);
  await openAdd(page);
  await page.fill("#add-date", day);
  await page.locator("#times-msg", { hasText: "No free times for Matty" }).waitFor();
  await page.click('#add-barbers .chip[data-barber="Alfie"]');
  await page.locator("#add-times .chip").first().waitFor();
  assert.equal(await page.locator("#add-times .chip").count(), 19, "Alfie is free all day");
});

ui("add booking: nothing is sent until the form is right, and each problem is explained", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  const sent = () => backend.requests.filter((r) => r.key === "admin_create_booking").length;
  await page.click("#add-save");
  assert.equal(await page.textContent("#add-error"), "Pick a time first.");
  await chip(page, "17:00").click();
  await page.click("#add-save");
  assert.equal(await page.textContent("#add-error"), "Enter the customer's name.");
  await page.fill("#add-name", "Wendy W");
  await page.click("#add-save");
  assert.match(await page.textContent("#add-error"), /phone number/);
  await page.fill("#add-phone", "abc");
  await page.click("#add-save");
  assert.match(await page.textContent("#add-error"), /phone number/);
  await page.fill("#add-phone", "07700 900123");
  await page.fill("#add-email", "not-an-email");
  await page.click("#add-save");
  assert.match(await page.textContent("#add-error"), /email doesn't look right/);
  assert.equal(sent(), 0);
  await page.fill("#add-email", "");
  await page.click("#add-save"); // email is optional
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.equal(sent(), 1);
});

ui("add booking: the time was taken by someone else meanwhile: told clearly, times refreshed, details kept, nothing double-booked", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page, "Too Slow Tony", "07700 900126");
  backend.bookings.push(b("Matty", "Online Olga", TODAY, "17:00")); // a customer books 17:00 online first
  await page.click("#add-save");
  await page.locator("#add-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#add-error"), /just been taken/);
  assert.equal(await page.locator("#add-dialog").isVisible(), true, "the form stays open");
  assert.equal(await page.inputValue("#add-name"), "Too Slow Tony", "typed details are kept");
  await page.waitForFunction(() => !document.querySelector('#add-times .chip[data-time="17:00"]') && document.querySelector("#add-times .chip"));
  assert.equal(await chip(page, "17:00").count(), 0, "17:00 no longer offered");
  assert.equal(backend.bookings.filter((x) => x.appointment_time === at(TODAY, "17:00") && x.barber === "Matty").length, 1);
  await chip(page, "17:30").click();
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.ok(backend.bookings.some((x) => x.customer_name === "Too Slow Tony" && x.appointment_time === at(TODAY, "17:30")));
});

ui("add booking: a time that has just passed is refused with a clear message", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "13:30").click();
  await fillCustomer(page);
  backend.nowMs = Date.parse("2026-10-25T13:45:00Z");
  await page.click("#add-save");
  await page.locator("#add-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#add-error"), /already passed/);
  assert.equal(backend.bookings.some((x) => x.customer_name === "Walk In Wendy"), false);
});

ui("add booking on a slow connection: 'Saving…', buttons locked, a double tap sends ONE request and saves ONE booking", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page);
  backend.once("admin_create_booking", { delay: 800 });
  await page.click("#add-save");
  assert.equal(await page.textContent("#add-save"), "Saving…");
  assert.equal(await page.locator("#add-save").isDisabled(), true);
  assert.equal(await page.locator("#add-close").isDisabled(), true, "can't close the form mid-save");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#add-dialog").isVisible(), true, "Esc doesn't lose a save in flight");
  await page.locator("#add-save").dispatchEvent("click");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.equal(backend.requests.filter((r) => r.key === "admin_create_booking").length, 1);
  assert.equal(backend.bookings.filter((x) => x.customer_name === "Walk In Wendy").length, 1);
});

ui("add booking: the connection drops AFTER it was saved: the page checks, confirms it saved, and never double-books", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page, "Walk In Wendy", "07700 900123", "w@example.com");
  backend.once("admin_create_booking", { mode: "lose-response" });
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  await card(page, "Walk In Wendy").waitFor();
  assert.equal(backend.bookings.filter((x) => x.customer_name === "Walk In Wendy").length, 1);
  assert.equal(backend.emails.filter((e) => e.kind === "confirmed").length, 1);
});

ui("add booking: the connection drops BEFORE it arrives: they're told it's unclear, nothing is lost, and Save again works once", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page);
  backend.once("admin_create_booking", { mode: "fail-before" });
  backend.always("GET bookings", { mode: "fail-before" }); // and the "did it save?" check can't get through either
  await page.click("#add-save");
  await page.locator("#add-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#add-error"), /couldn't tell if that saved.*won't double book/);
  assert.equal(await page.locator("#add-dialog").isVisible(), true, "the form (and everything typed) is still there");
  assert.equal(await page.inputValue("#add-name"), "Walk In Wendy");
  assert.equal(await chip(page, "17:00").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#add-save").isEnabled(), true);
  assert.equal(backend.bookings.some((x) => x.customer_name === "Walk In Wendy"), false);
  const firstToken = backend.requests.length && true;
  backend.clearBehaviors();
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.equal(backend.bookings.filter((x) => x.customer_name === "Walk In Wendy").length, 1);
  assert.ok(firstToken);
});

ui("add booking: a hung request times out, and a retry is safe even if the first one DID arrive late", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page);
  backend.once("admin_create_booking", { mode: "hang" });
  backend.once("GET bookings", { mode: "hang" }); // the "did it save?" check hangs too
  await page.click("#add-save");
  await page.locator("#add-error").waitFor({ state: "visible", timeout: 8000 });
  assert.match(await page.textContent("#add-error"), /couldn't tell if that saved/);
  await page.click("#add-save");
  await toastText(page).filter({ hasText: "Booked" }).waitFor();
  assert.equal(backend.bookings.filter((x) => x.customer_name === "Walk In Wendy").length, 1);
});

ui("add booking: a repeated request with the same id is safe (the 'created' answer is repeated, no second booking)", async ({ page, backend }) => {
  await ready(page);
  const out = await page.evaluate(async (tomorrow) => {
    const c = window.supabase.createClient("https://mddhykzuxrywhtmjwajy.supabase.co", "anon", { auth: { storageKey: "blain-auth", persistSession: true } });
    const args = { p_barber: "Matty", p_service: "Haircut", p_time: tomorrow, p_name: "Twice Terry", p_phone: "07700900777", p_email: null, p_token: crypto.randomUUID() };
    const a = await c.rpc("admin_create_booking", args);
    const bb = await c.rpc("admin_create_booking", args);
    const other = await c.rpc("admin_create_booking", { ...args, p_token: crypto.randomUUID() });
    return [a.data, bb.data, other.data];
  }, at(TOMORROW, "15:00"));
  assert.deepEqual(out, ["created", "created", "taken"]);
  assert.equal(backend.bookings.filter((x) => x.customer_name === "Twice Terry").length, 1);
});

ui("add booking: closing the form with Cancel or ✕ discards it and saves nothing", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  await chip(page, "17:00").click();
  await fillCustomer(page);
  await page.click("#add-cancel");
  assert.equal(await page.locator("#add-dialog").isVisible(), false);
  await openAdd(page);
  assert.equal(await page.inputValue("#add-name"), "", "a fresh, empty form next time");
  await page.click("#add-close");
  assert.equal(await page.locator("#add-dialog").isVisible(), false);
  assert.equal(backend.requests.filter((r) => r.key === "admin_create_booking").length, 0);
});

ui("add booking: if free times can't be loaded, they're told and can retry", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET bookings", { mode: "fail-before" });
  await page.click("#add-open");
  await page.locator("#times-msg[data-kind=error]").waitFor();
  assert.match(await page.textContent("#times-msg"), /Couldn't check free times/);
  await page.locator("#add-times .btn").click();
  await page.locator("#add-times .chip").first().waitFor();
});

ui("add booking: two quick date changes never show the wrong day's times", async ({ page, backend }) => {
  await ready(page);
  await openAdd(page);
  backend.once("GET bookings", { delay: 600 }); // the first date's answer arrives late
  await page.click("#add-tomorrow");
  await page.fill("#add-date", "2026-10-28");
  await page.waitForTimeout(1000);
  assert.equal(await page.inputValue("#add-date"), "2026-10-28");
  assert.equal(await chip(page, "09:00").count(), 1, "full day shown for 28th");
  assert.equal(await page.locator("#add-times .chip").count(), 19);
});

// ================================================================ loading, errors, stale answers
test("if the list can't be loaded, they see why and Try again works", async () => {
  const backend = makeBackend();
  backend.once("GET bookings", { mode: "fail-before" });
  const page = await openPage(env, backend, { signedInAs: USERS.matty });
  try {
    await page.locator("#list-error").waitFor({ state: "visible" });
    assert.match(await page.textContent("#list-error-text"), /Couldn't load the bookings/);
    assert.equal(await page.locator(".card").count(), 0);
    await page.click("#list-error-retry");
    await page.locator(".card").first().waitFor();
    assert.equal(await page.locator("#list-error").isVisible(), false);
  } finally { await page.context().close(); }
});

test("a very slow list shows 'Loading…' and times out with a message", async () => {
  const backend = makeBackend();
  backend.once("GET bookings", { mode: "hang" });
  const page = await openPage(env, backend, { signedInAs: USERS.matty });
  try {
    await page.locator("#summary", { hasText: "Loading bookings…" }).waitFor();
    await page.locator("#list-error").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.textContent("#list-error-text"), /Slow connection/);
  } finally { await page.context().close(); }
});

ui("a failed refresh keeps the list on screen and says when it's from", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET bookings", { mode: "fail-before" });
  await page.click("#refresh");
  await page.locator("#list-error").waitFor({ state: "visible" });
  assert.match(await page.textContent("#list-error-text"), /Showing the list from \d\d:\d\d/);
  assert.equal(await page.locator(".card").count(), 5, "the earlier list is still there");
});

ui("quickly changing days never shows a stale answer for the wrong day", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET bookings", { delay: 900 }); // tomorrow's answer arrives LATE...
  await page.click("#next");
  backend.once("GET bookings", { delay: 0 });
  await page.click("#prev"); // ...after they've already gone back to today
  await page.waitForTimeout(1300);
  assert.match(await page.textContent("#day-label"), /Today/);
  assert.deepEqual(await names(page), ["Dave Smith", "Sam Jones", "Pete Brown", "Carl Cancelled", "Late Larry"]);
});

ui("an unexpected error is a calm message, not a broken page", async ({ page, backend }) => {
  await ready(page);
  backend.once("GET bookings", { mode: "http", status: 500, body: { message: "boom" } });
  await page.click("#refresh");
  await page.locator("#list-error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#v-app").isVisible(), true);
});

// ================================================================ phone layout
for (const width of [360, 390]) {
  ui(`phone ${width}px: no sideways scrolling and every tap target is big enough`, { viewport: { width, height: 780 } }, async ({ page, backend }) => {
    backend.bookings.push(b("Matty", "Unbroken" + "x".repeat(60), TODAY, "17:00", { customer_email: "u".repeat(70) + "@example.com", customer_phone: "07700900123" }));
    await ready(page);
    // On a phone, wide content makes the browser zoom OUT (the layout gets wider than the screen), so check both
    const overflow = () => page.evaluate((w) => Math.max(document.documentElement.scrollWidth - w, window.innerWidth - w, window.visualViewport.scale < 0.999 ? 1 : 0), width);
    assert.ok((await overflow()) <= 0, "no horizontal scroll on the list");
    const small = await page.evaluate(() => [...document.querySelectorAll("#v-app button, #v-app a, #add-open, #prev, #next")]
      .filter((e) => e.offsetParent && !e.closest("[hidden]"))
      .map((e) => ({ t: (e.textContent || e.id).trim().slice(0, 20), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }))
      .filter((x) => x.h < 44 || x.w < 44));
    assert.deepEqual(small, [], "all buttons and links are at least 44px each way");
    await card(page, "Sam Jones").locator(".btn-danger-ghost").click();
    assert.ok((await overflow()) <= 0, "no horizontal scroll with Are-you-sure open");
    await page.click("#add-open");
    await page.locator("#add-times .chip").first().waitFor();
    assert.ok((await overflow()) <= 0, "no zoom-out or sideways scroll with the form open");
    assert.ok((await page.evaluate(() => document.querySelector("#add-dialog").scrollWidth - document.querySelector("#add-dialog").clientWidth)) <= 0, "no horizontal scroll in the form");
    const tiny = await page.evaluate(() => [...document.querySelectorAll("#add-dialog button, #add-dialog input, #add-dialog select")]
      .filter((e) => e.offsetParent).map((e) => ({ id: e.id || e.textContent, h: e.getBoundingClientRect().height })).filter((x) => x.h < 44));
    assert.deepEqual(tiny, [], "form controls are tall enough");
    const fonts = await page.evaluate(() => [...document.querySelectorAll("#add-dialog input, #add-dialog select")].map((e) => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(fonts.every((f) => f >= 16), "inputs are 16px+ so iPhones don't zoom in");
  });
}

test("a long customer name and email don't break the card layout", async () => {
  const backend = makeBackend();
  backend.bookings.push(b("Matty", "Bartholomew-Maximilian Featherstonehaugh-Wigglesworth the Third", TODAY, "17:00", { customer_email: "a.very.long.email.address.that.keeps.going@subdomain.example-company.co.uk" }));
  const page = await openPage(env, backend, { signedInAs: USERS.matty, viewport: { width: 360, height: 780 } });
  try {
    await ready(page);
    assert.ok((await page.evaluate(() => Math.max(document.documentElement.scrollWidth - 360, window.innerWidth - 360, window.visualViewport.scale < 0.999 ? 1 : 0))) <= 0);
  } finally { await page.context().close(); }
});
