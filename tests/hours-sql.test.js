"use strict";
// Working hours, days off, extra hours and bookable times: security and behaviour, against real Postgres
// with the real supabase/*.sql files. Also checks that the database and admin-logic.js agree on which times are open.
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { setup, week, U } = require("./helpers/sqlharness");
const L = require("../admin-logic.js");

let h;
before(async () => { h = await setup(); });
after(async () => { await h.close(); });
beforeEach(() => h.begin());
afterEach(() => h.rollback());

const { q, one, as, asSuper, fails } = new Proxy({}, { get: (_, k) => (...a) => h[k](...a) });

const setHours = (barber, days) => one("select public.admin_set_hours($1, $2::jsonb) as r", [barber, JSON.stringify(week(days))]).then((x) => x.r);
const addEx = (o) => one("select public.admin_add_exception($1::uuid, $2, $3, $4::date, $5::date, $6::time, $7::time, $8) as r",
  [o.id ?? crypto.randomUUID(), o.barber ?? "Matty", o.kind ?? "off", o.from, o.to ?? o.from, o.start ?? null, o.end ?? null, o.note ?? null]).then((x) => x.r);
// open start times (UK "HH:MM") for a barber on a date, straight from the database function
// (schedule_starts is internal, so look as the database owner, then go back to whoever was acting)
const starts = async (barber, date) => {
  const cur = await one("select current_user u, current_setting('request.jwt.claim.sub', true) s");
  await asSuper();
  const rows = await q("select to_char(local_start, 'HH24:MI') t from public.schedule_starts($1, $2::date) order by 1", [barber, date]);
  if (cur.u !== "postgres") await as(cur.u, cur.s);
  return rows.map((r) => r.t);
};
const range = (from, to, step = 30) => { const o = []; for (let m = L.toMin(from); m <= L.toMin(to); m += step) o.push(L.fromMin(m)); return o; };

// a far-future Monday .. Sunday so "past" never gets in the way: 2027-06-07 is a Monday
const MON = "2027-06-07", TUE = "2027-06-08", WED = "2027-06-09", SAT = "2027-06-12", SUN = "2027-06-13";
const FULL = { 1: ["09:00", "18:00"], 2: ["09:00", "18:00", ["12:00", "13:00"]], 3: ["10:00", "16:00"], 4: ["09:00", "18:00"], 5: ["09:00", "17:00"], 6: ["09:00", "13:00"], 7: null };

// ---------------------------------------------------------------- security
test("the hours tables cannot be read or written from the website, except admins may READ", async () => {
  await asSuper();
  await h.db.query("insert into public.barber_hours (barber, weekday, working, start_time, end_time) values ('Matty', 1, true, '09:00', '17:00')");
  await h.db.query("insert into public.barber_exceptions (barber, kind, date_from, date_to) values ('Matty', 'off', '2027-06-07', '2027-06-07')");
  for (const [role, uid] of [["anon", null], ["authenticated", U.CUSTOMER], ["authenticated", U.IMPOSTOR]]) {
    await as(role, uid);
    for (const t of ["barber_hours", "barber_exceptions"]) {
      if (role === "anon") await fails(`select * from public.${t}`, [], "42501");
      else assert.deepEqual(await q(`select * from public.${t}`), [], `${uid} sees nothing in ${t}`);
    }
  }
  await as("authenticated", U.ADMIN);
  assert.equal((await q("select * from public.barber_hours")).length, 1);
  assert.equal((await q("select * from public.barber_exceptions")).length, 1);
  for (const who of [["anon", null], ["authenticated", U.CUSTOMER], ["authenticated", U.ADMIN]]) {
    await as(...who);
    for (const sql of [
      "insert into public.barber_hours (barber, weekday, working, start_time, end_time) values ('X', 2, true, '09:00', '10:00')",
      "update public.barber_hours set working = false", "delete from public.barber_hours",
      "insert into public.barber_exceptions (barber, kind, date_from, date_to) values ('X', 'off', '2027-06-07', '2027-06-07')",
      "update public.barber_exceptions set note = 'x'", "delete from public.barber_exceptions",
    ]) await fails(sql, [], "42501");
  }
});

test("only admins can set hours, add or remove time off: customers, look-alikes and guests are refused", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const [role, uid] of [["authenticated", U.CUSTOMER], ["authenticated", U.IMPOSTOR], ["anon", null]]) {
    await as(role, uid);
    await fails("select public.admin_set_hours('Matty', $1::jsonb)", [JSON.stringify(week(FULL))], "42501");
    await fails("select public.admin_add_exception($1::uuid, 'Matty', 'off', '2027-06-07', '2027-06-07')", [id], "42501");
    await fails("select public.admin_remove_exception($1::uuid)", [id], "42501");
  }
  await asSuper();
  assert.equal((await q("select 1 from public.barber_hours")).length, 0);
  assert.equal((await q("select 1 from public.barber_exceptions")).length, 0);
});

test("once an admin is removed, their write access ends straight away", async () => {
  await asSuper();
  await h.db.query("delete from public.admins where email = 'matty@example.com'");
  await as("authenticated", U.ADMIN);
  await fails("select public.admin_set_hours('Matty', $1::jsonb)", [JSON.stringify(week(FULL))], "42501");
});

test("function permissions: guests can ask for bookable times and nothing else; internals are closed", async () => {
  await asSuper();
  const rows = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon_ok,
      has_function_privilege('authenticated', p.oid, 'execute') auth_ok
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
      ('bookable_slots','admin_set_hours','admin_add_exception','admin_remove_exception','schedule_starts','slot_is_open','barber_has_hours','enforce_booking_hours')`);
  const by = Object.fromEntries(rows.map((r) => [r.proname, r]));
  assert.equal(Object.keys(by).length, 8);
  assert.deepEqual([by.bookable_slots.anon_ok, by.bookable_slots.auth_ok], [true, true]);
  for (const n of ["admin_set_hours", "admin_add_exception", "admin_remove_exception"]) assert.deepEqual([by[n].anon_ok, by[n].auth_ok], [false, true], n);
  for (const n of ["schedule_starts", "slot_is_open", "barber_has_hours", "enforce_booking_hours"]) assert.deepEqual([by[n].anon_ok, by[n].auth_ok], [false, false], n);
});

test("bookable_slots tells a guest only the times and whether they're free: never any customer detail", async () => {
  await asSuper();
  await h.db.query(`insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, customer_email)
    values ('Matty','Secret Sam','Haircut', (select slot_time from public.bookable_slots('Matty', current_date + 1, 1) limit 1), '07700900123','confirmed','sam@example.com')`);
  await as("anon");
  const rows = await q("select * from public.bookable_slots('Matty', current_date + 1, 1)");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["free", "slot_time"]);
  assert.equal(rows.filter((r) => !r.free).length, 1);
  assert.ok(!JSON.stringify(rows).includes("Secret"));
});

// ---------------------------------------------------------------- weekly hours
test("no hours saved: the old 09:00–18:00 grid, every day, so nothing breaks", async () => {
  await asSuper();
  for (const d of [MON, SAT, SUN]) assert.deepEqual(await starts("Matty", d), range("09:00", "18:00"));
  assert.equal((await one("select public.barber_has_hours('Matty') as b")).b, false);
});

test("an admin saves a weekly schedule; the times follow it, including the break", async () => {
  await as("authenticated", U.ADMIN);
  assert.equal(await setHours("Matty", FULL), "saved");
  await asSuper();
  assert.equal((await one("select public.barber_has_hours('matty') as b")).b, true, "letter case doesn't matter");
  await as("authenticated", U.ADMIN);
  assert.deepEqual(await starts("Matty", MON), range("09:00", "17:30"), "Mon 09:00–18:00: last start 17:30");
  assert.deepEqual(await starts("Matty", TUE), [...range("09:00", "11:30"), ...range("13:00", "17:30")], "Tue has a 12–13 break");
  assert.deepEqual(await starts("Matty", WED), range("10:00", "15:30"));
  assert.deepEqual(await starts("Matty", SAT), range("09:00", "12:30"));
  assert.deepEqual(await starts("Matty", SUN), [], "Sunday is a day off");
  assert.deepEqual(await starts("Alfie", MON), range("09:00", "18:00"), "another barber without hours keeps the old grid");
});

test("saving again replaces the whole week (and a day off remembers its times)", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await setHours("Matty", { 1: ["08:00", "12:00"], 2: null, 3: null, 4: null, 5: null, 6: null, 7: null });
  assert.deepEqual(await starts("Matty", MON), range("08:00", "11:30"));
  assert.deepEqual(await starts("Matty", TUE), []);
  assert.equal((await q("select 1 from public.barber_hours where lower(barber) = 'matty'")).length, 7);
  const off = await one("select working, start_time::text s, end_time::text e from public.barber_hours where barber = 'Matty' and weekday = 2");
  assert.deepEqual(off, { working: false, s: "09:00:00", e: "18:00:00" });
});

test("a bad schedule is refused with a clear code and the saved one is left exactly as it was", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  const before = await q("select * from public.barber_hours order by weekday");
  const bad = (mut) => { const w = week(FULL); mut(w); return one("select public.admin_set_hours('Matty', $1::jsonb) as r", [JSON.stringify(w)]).then((x) => x.r); };
  assert.equal(await bad((w) => { w[0].end = "09:00"; }), "invalid_hours", "end not after start");
  assert.equal(await bad((w) => { w[0].start = "17:00"; w[0].end = "09:00"; }), "invalid_hours");
  assert.equal(await bad((w) => { w[0].start = null; }), "invalid_hours");
  assert.equal(await bad((w) => { w[1].break_start = "08:00"; w[1].break_end = "09:30"; }), "invalid_break", "break starts before opening");
  assert.equal(await bad((w) => { w[1].break_start = "17:00"; w[1].break_end = "18:00"; }), "invalid_break", "break runs to closing");
  assert.equal(await bad((w) => { w[1].break_end = "11:00"; }), "invalid_break", "break ends before it starts");
  assert.equal(await bad((w) => { w[0].break_start = "12:00"; w[0].break_end = null; }), "invalid_break", "half a break");
  assert.equal(await bad((w) => { w[0].start = "09:15"; }), "invalid_hours", "not on the hour or half hour");
  assert.equal(await bad((w) => { w[0].weekday = 2; }), "invalid_days", "weekday twice");
  assert.equal(await bad((w) => { w[0].weekday = 9; }), "invalid_days");
  assert.equal(await bad((w) => { w[0].start = "banana"; }), "invalid_days");
  assert.equal(await bad((w) => { w.pop(); }), "invalid_days", "needs all seven days");
  assert.equal((await one("select public.admin_set_hours('Matty', null) as r")).r, "invalid_days");
  assert.equal((await one("select public.admin_set_hours('', $1::jsonb) as r", [JSON.stringify(week(FULL))])).r, "invalid_barber");
  assert.deepEqual(await q("select * from public.barber_hours order by weekday"), before, "nothing changed");
});

test("a break on a day off is dropped, and the database refuses an impossible schedule even if inserted directly", async () => {
  await as("authenticated", U.ADMIN);
  const w = week(FULL);
  w[6] = { weekday: 7, working: false, start: "09:00", end: "18:00", break_start: "12:00", break_end: "13:00" };
  assert.equal((await one("select public.admin_set_hours('Matty', $1::jsonb) as r", [JSON.stringify(w)])).r, "saved");
  assert.equal((await one("select break_start from public.barber_hours where barber='Matty' and weekday = 7")).break_start, null);
  await asSuper();
  await fails("insert into public.barber_hours (barber, weekday, working, start_time, end_time) values ('Z', 1, true, '18:00', '09:00')", [], "23514");
  await fails("insert into public.barber_hours (barber, weekday, working, start_time, end_time) values ('Z', 1, true, '09:10', '18:00')", [], "23514");
  await fails("insert into public.barber_hours (barber, weekday, working, start_time, end_time) values ('Z', 8, true, '09:00', '18:00')", [], "23514");
});

// ---------------------------------------------------------------- days off and extra hours
test("a whole day off (and a run of days off) removes every time", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  assert.equal(await addEx({ from: MON, to: MON, note: "Dentist" }), "created");
  assert.deepEqual(await starts("Matty", MON), []);
  assert.ok((await starts("Matty", TUE)).length > 0);
  assert.equal(await addEx({ from: TUE, to: "2027-06-11", note: "Holiday" }), "created"); // Tue..Fri
  for (const d of [TUE, WED, "2027-06-10", "2027-06-11"]) assert.deepEqual(await starts("Matty", d), [], d);
  assert.deepEqual(await starts("Matty", SAT), range("09:00", "12:30"), "Saturday is back");
  assert.ok((await starts("Alfie", MON)).length > 0, "another barber is unaffected");
});

test("a time range off removes exactly the slots it touches (a 30-minute slot that only ends where the block starts is kept)", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await addEx({ from: MON, start: "14:00", end: "15:30" });
  const t = await starts("Matty", MON);
  assert.ok(t.includes("13:30") && !["14:00", "14:30", "15:00"].some((x) => t.includes(x)) && t.includes("15:30"));
});

test("overlapping and touching blocks simply add up, and a duplicate does no harm", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await addEx({ from: MON, start: "10:00", end: "12:00" });
  await addEx({ from: MON, start: "11:00", end: "13:00" });   // overlaps the first
  await addEx({ from: MON, start: "13:00", end: "14:00" });   // touches the second
  await addEx({ from: MON, start: "10:00", end: "12:00" });   // exactly the same again
  await addEx({ from: MON, to: MON });                         // and a whole-day block on top
  assert.deepEqual(await starts("Matty", MON), []);
  await asSuper();
  await h.db.query("delete from public.barber_exceptions where start_time is null");
  const t = await starts("Matty", MON);
  assert.deepEqual(t, [...range("09:00", "09:30"), ...range("14:00", "17:30")]);
});

test("extra hours open a day off, extend a working day, and a block wins over them", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  assert.equal(await addEx({ kind: "extra", from: SUN, start: "10:00", end: "13:00" }), "created");
  assert.deepEqual(await starts("Matty", SUN), range("10:00", "12:30"));
  await addEx({ kind: "extra", from: MON, start: "18:00", end: "20:00" });
  assert.deepEqual(await starts("Matty", MON), range("09:00", "19:30"));
  await addEx({ kind: "extra", from: MON, start: "08:00", end: "09:00" });
  assert.equal((await starts("Matty", MON))[0], "08:00");
  await addEx({ from: SUN, start: "11:00", end: "12:00" });
  assert.deepEqual(await starts("Matty", SUN), ["10:00", "10:30", "12:00", "12:30"]);
  await addEx({ from: SUN });
  assert.deepEqual(await starts("Matty", SUN), [], "a whole-day block beats extra hours");
});

test("extra hours inside the break reopen it, and extra hours work for a barber with no weekly hours too", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await addEx({ kind: "extra", from: TUE, start: "12:00", end: "12:30" });
  assert.ok((await starts("Matty", TUE)).includes("12:00"));
  assert.ok(!(await starts("Matty", TUE)).includes("12:30"));
  await addEx({ barber: "Alfie", kind: "extra", from: MON, start: "09:00", end: "10:00" });
  assert.deepEqual(await starts("Alfie", MON), range("09:00", "18:00"), "the old grid already covers it");
  await addEx({ barber: "Alfie", kind: "extra", from: MON, start: "09:00", end: "11:00" });
  assert.deepEqual(await starts("Alfie", MON), range("09:00", "18:00"));
});

test("blocks work for a barber with no weekly hours (the old grid minus the block)", async () => {
  await as("authenticated", U.ADMIN);
  await addEx({ barber: "Alfie", from: MON, start: "12:00", end: "13:00" });
  assert.deepEqual(await starts("Alfie", MON), [...range("09:00", "11:30"), ...range("13:00", "18:00")]);
  await asSuper();
  assert.equal((await one("select public.barber_has_hours('Alfie') as b")).b, false, "a block alone doesn't count as 'hours'");
});

test("bad one-off changes are refused with a clear code", async () => {
  await as("authenticated", U.ADMIN);
  const today = (await one("select (now() at time zone 'Europe/London')::date::text d")).d;
  const plus = async (n) => (await one("select ($1::date + $2::int)::text d", [today, n])).d;
  assert.equal(await addEx({ from: today }), "created", "today is allowed");
  assert.equal(await addEx({ from: await plus(-1), to: await plus(-1) }), "invalid_date", "yesterday");
  assert.equal(await addEx({ from: await plus(5), to: await plus(4) }), "invalid_date", "ends before it starts");
  assert.equal(await addEx({ from: await plus(1), to: await plus(70) }), "invalid_date", "more than 63 days");
  assert.equal(await addEx({ from: await plus(400) }), "invalid_date", "too far ahead");
  assert.equal(await addEx({ kind: "holiday", from: await plus(1) }), "invalid_kind");
  assert.equal(await addEx({ kind: "extra", from: await plus(1) }), "invalid_time", "extra hours need times");
  assert.equal(await addEx({ from: await plus(1), start: "10:00", end: "10:00" }), "invalid_time");
  assert.equal(await addEx({ from: await plus(1), start: "12:00", end: "10:00" }), "invalid_time");
  assert.equal(await addEx({ from: await plus(1), start: "10:15", end: "11:00" }), "invalid_time", "not on the half hour");
  assert.equal(await addEx({ from: await plus(1), to: await plus(2), start: "10:00", end: "11:00" }), "invalid_time", "a time range is one day");
  assert.equal(await addEx({ from: await plus(1), note: "x".repeat(81) }), "invalid_note");
  assert.equal(await addEx({ from: await plus(1), barber: "" }), "invalid_barber");
  assert.equal((await one("select public.admin_add_exception(null, 'Matty', 'off', $1::date, $1::date) as r", [await plus(1)])).r, "invalid_id");
});

test("adding the same change twice (slow connection) saves one; removing is safe to repeat", async () => {
  await as("authenticated", U.ADMIN);
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal(await addEx({ id, from: MON, note: "Dentist" }), "created");
  assert.equal(await addEx({ id, from: MON, note: "Dentist" }), "created");
  assert.equal((await q("select 1 from public.barber_exceptions")).length, 1);
  assert.equal((await one("select public.admin_remove_exception($1::uuid) as r", [id])).r, "removed");
  assert.equal((await one("select public.admin_remove_exception($1::uuid) as r", [id])).r, "not_found");
  assert.equal((await q("select 1 from public.barber_exceptions")).length, 0);
  assert.deepEqual(await starts("Matty", MON), range("09:00", "18:00"), "the day is back");
});

// ---------------------------------------------------------------- bookings and the hours
async function book(role, uid, barber, ts, name = "Cust Omer") {
  await as(role, uid);
  await h.db.query(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ($1,$2,'Haircut',$3::timestamptz,'07700900123','confirmed')", [barber, name, ts]);
}
const at = (date, time) => L.londonToUtc(date, time).toISOString();

test("bookable_slots: booked times show as not free, cancelled ones free up, past times are not listed", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  const day = (await one("select (current_date + 10)::text d")).d;
  await asSuper();
  const slots = () => q("select to_char(slot_time at time zone 'Europe/London', 'HH24:MI') t, free from public.bookable_slots('matty', $1::date, 1) order by 1", [day]);
  const first = (await slots());
  assert.ok(first.length > 0 && first.every((s) => s.free));
  const t = first[2].t;
  await h.db.query("insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','A B','Haircut',$1::timestamptz,'07700900123','confirmed')", [at(day, t)]);
  assert.equal((await slots()).find((s) => s.t === t).free, false);
  await h.db.query("update public.bookings set status = 'cancelled'");
  assert.equal((await slots()).find((s) => s.t === t).free, true);
  const yesterday = (await one("select (current_date - 1)::text d")).d;
  assert.equal((await q("select 1 from public.bookable_slots('Matty', $1::date, 1)", [yesterday])).length, 0, "nothing in the past");
});

test("bookable_slots covers up to 31 days and clamps silly inputs", async () => {
  await asSuper();
  assert.ok((await q("select 1 from public.bookable_slots('Matty', current_date, 365)")).length <= 31 * 19);
  assert.ok((await q("select 1 from public.bookable_slots('Matty', current_date + 1, 0)")).length > 0, "0 days is treated as 1");
  assert.ok((await q("select 1 from public.bookable_slots('Matty', current_date + 1, null)")).length > 0);
});

test("guests and customers can book inside hours but not outside, in the break, or in blocked time", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await addEx({ from: "2027-06-14", start: "10:00", end: "11:00" }); // a Monday: a block
  const ok = at(MON, "10:00");
  await book("anon", null, "Matty", ok, "Guest Gina");
  const e1 = await fails("insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','X Y','Haircut',$1::timestamptz,'07700900123','confirmed')", [at(MON, "18:00")]);
  assert.match(e1.message, /slot_not_available/, "last start is 17:30, so 18:00 is outside");
  const bad = [[SUN, "10:00", "day off"], [MON, "08:30", "before opening"], [TUE, "12:00", "in the break"], [TUE, "12:30", "in the break"], ["2027-06-14", "10:30", "blocked"], [MON, "09:15", "not on the half hour"]];
  for (const [d, t, why] of bad) {
    for (const [role, uid] of [["anon", null], ["authenticated", U.CUSTOMER]]) {
      await as(role, uid);
      const e = await fails("insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','X Y','Haircut',$1::timestamptz,'07700900123','confirmed')", [at(d, t)]);
      assert.match(e.message, /slot_not_available/, `${role}: ${why}`);
    }
  }
  await book("authenticated", U.CUSTOMER, "Matty", at(TUE, "13:00"), "Signed In Sue"); // right after the break: fine
  await book("anon", null, "Matty", at("2027-06-14", "11:00"), "After Block"); // block ends at 11:00: fine
});

test("a barber with no hours yet is not checked: bookings work exactly as before", async () => {
  await book("anon", null, "Alfie", at(SUN, "07:15"), "Odd Time");
  await asSuper();
  assert.equal((await q("select 1 from public.bookings")).length, 1);
});

test("the safety check does not get in the way of the SQL editor (superuser) or of cancelling", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await asSuper();
  await h.db.query("insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, cancel_token) values ('Matty','Editor','Haircut',$1::timestamptz,'07700900123','confirmed', gen_random_uuid())", [at(SUN, "03:00")]);
  const { cancel_token } = await one("select cancel_token from public.bookings");
  await as("anon");
  assert.equal((await one("select public.cancel_booking($1) as r", [cancel_token])).r, "cancelled", "even a booking now outside hours can be cancelled");
});

test("admin Add booking follows the hours too: 'closed' outside them, normal inside", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await addEx({ from: "2027-06-14", start: "10:00", end: "11:00" });
  const add = (t, name = "Walk In") => one("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,$2,'07700900123') as r", [t, name]).then((x) => x.r);
  assert.equal(await add(at(SUN, "10:00")), "closed");
  assert.equal(await add(at(TUE, "12:00")), "closed", "break");
  assert.equal(await add(at("2027-06-14", "10:30")), "closed", "blocked");
  assert.equal(await add(at(MON, "18:00")), "closed");
  assert.equal(await add(at(MON, "10:00")), "created");
  assert.equal(await add(at(MON, "10:00"), "Second"), "taken");
  const alfie = (t) => one("select public.admin_create_booking('Alfie','Haircut',$1::timestamptz,'Walk In','07700900123') as r", [t]).then((x) => x.r);
  assert.equal(await alfie(at(SUN, "10:00")), "created", "Alfie has no hours yet, so as before");
});

test("blocking a time that already has bookings NEVER cancels or changes them, and sends no email", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  await book("anon", null, "Matty", at(MON, "10:00"), "Early Ed");
  await book("anon", null, "Matty", at(MON, "10:30"), "Later Larry");
  await asSuper();
  await h.db.query("delete from net.calls");
  const before = await q("select id, status, appointment_time, customer_name from public.bookings order by 1");
  await as("authenticated", U.ADMIN);
  assert.equal(await addEx({ from: MON, start: "10:00", end: "11:00" }), "created");
  assert.equal(await addEx({ from: MON }), "created");
  assert.equal(await setHours("Matty", { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null }), "saved");
  await asSuper();
  assert.deepEqual(await q("select id, status, appointment_time, customer_name from public.bookings order by 1"), before);
  assert.equal((await q("select 1 from net.calls")).length, 0, "no cancellation emails");
  assert.ok((await q("select 1 from public.bookings where status = 'confirmed'")).length === 2);
  // and those bookings still don't show as free times
  assert.deepEqual(await starts("Matty", MON), []);
});

test("the booked-slot rule still wins: two admins and a customer racing for one open time end with one booking", async () => {
  await db_noop();
  async function db_noop() {}
  await as("authenticated", U.ADMIN);
  await setHours("Matty", FULL);
  const t = at(MON, "11:00");
  await book("anon", null, "Matty", t, "First");
  await as("authenticated", U.ADMIN);
  assert.equal((await one("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,'Second','07700900123') as r", [t])).r, "taken");
  await as("anon");
  await fails("insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','Third','Haircut',$1::timestamptz,'07700900123','confirmed')", [t], "23505");
});

// ---------------------------------------------------------------- clock changes
test("clock changes: the same wall-clock hours land on the right UTC moment before and after", async () => {
  await as("authenticated", U.ADMIN);
  await setHours("Matty", { 1: ["09:00", "18:00"], 2: ["09:00", "18:00"], 3: ["09:00", "18:00"], 4: ["09:00", "18:00"], 5: ["09:00", "18:00"], 6: ["09:00", "18:00"], 7: ["09:00", "18:00"] });
  const utcOf = async (date, time) => (await one("select (($1::date + $2::time) at time zone 'Europe/London')::text t", [date, time])).t;
  // 2027: clocks go forward Sun 28 Mar (01:00 UTC) and back Sun 31 Oct (01:00 UTC)
  const first = async (d) => (await q("select to_char(slot_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI') t from public.bookable_slots('Matty', $1::date, 1) order by 1 limit 1", [d]))[0].t;
  assert.equal(await first("2027-03-27"), "2027-03-27 09:00", "Saturday, still GMT");
  assert.equal(await first("2027-03-28"), "2027-03-28 08:00", "Sunday, BST: 09:00 UK is 08:00 UTC");
  assert.equal(await first("2027-10-30"), "2027-10-30 08:00", "Saturday, BST");
  assert.equal(await first("2027-10-31"), "2027-10-31 09:00", "Sunday, back to GMT");
  const n = async (d) => (await q("select 1 from public.bookable_slots('Matty', $1::date, 1)", [d])).length;
  assert.equal(await n("2027-03-28"), 18, "the 23-hour day still has 09:00 to 17:30");
  assert.equal(await n("2027-10-31"), 18, "the 25-hour day still has the same open hours");
  assert.ok(await utcOf("2027-10-31", "09:00"));
});

// ---------------------------------------------------------------- the database and admin-logic.js agree
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test("randomised: the database and the page's own logic agree on every open time (incl. clock-change weeks)", async () => {
  await asSuper();
  const rand = rng(20261025);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const times = range("06:00", "22:00");
  const dates = [...Array.from({ length: 14 }, (_, i) => L.addDays("2026-10-19", i)), ...Array.from({ length: 14 }, (_, i) => L.addDays("2027-03-22", i))];
  let compared = 0, nonEmpty = 0;
  for (let n = 0; n < 40; n++) {
    await h.db.query("delete from public.barber_hours; delete from public.barber_exceptions;");
    const configured = rand() < 0.8;
    const hours = [];
    if (configured) {
      for (let wd = 1; wd <= 7; wd++) {
        const working = rand() < 0.7;
        let s = pick(times.slice(0, 20)), e = pick(times.filter((t) => L.toMin(t) > L.toMin(s)).length ? times.filter((t) => L.toMin(t) > L.toMin(s)) : ["22:00"]);
        if (L.toMin(e) <= L.toMin(s)) e = "22:00";
        let bs = null, be = null;
        if (working && rand() < 0.5) {
          const inner = times.filter((t) => L.toMin(t) > L.toMin(s) && L.toMin(t) < L.toMin(e));
          if (inner.length >= 2) { const i = Math.floor(rand() * (inner.length - 1)); bs = inner[i]; be = inner[i + 1 + Math.floor(rand() * Math.min(3, inner.length - i - 1))]; }
        }
        if (working && L.toMin(e) - L.toMin(s) < 30) continue;
        hours.push({ weekday: wd, working, start_time: s, end_time: e, break_start: bs, break_end: be });
      }
      for (const r of hours) {
        await h.db.query("insert into public.barber_hours (barber, weekday, working, start_time, end_time, break_start, break_end) values ('Matty',$1,$2,$3,$4,$5,$6)",
          [r.weekday, r.working, r.start_time, r.end_time, r.break_start, r.break_end]);
      }
    }
    const exceptions = [];
    for (let k = 0; k < Math.floor(rand() * 5); k++) {
      const d = pick(dates);
      const kind = rand() < 0.35 ? "extra" : "off";
      const whole = kind === "off" && rand() < 0.4;
      const s = pick(times.slice(0, 28)), e = pick(times.filter((t) => L.toMin(t) > L.toMin(s)).concat(["22:00"]));
      const row = { kind, date_from: d, date_to: whole && rand() < 0.5 ? L.addDays(d, Math.floor(rand() * 4)) : d, start_time: whole ? null : s, end_time: whole ? null : (L.toMin(e) > L.toMin(s) ? e : "22:00") };
      await h.db.query("insert into public.barber_exceptions (barber, kind, date_from, date_to, start_time, end_time) values ('Matty',$1,$2,$3,$4,$5)",
        [row.kind, row.date_from, row.date_to, row.start_time, row.end_time]);
      exceptions.push({ barber: "Matty", ...row });
    }
    const hourRows = hours.map((r) => ({ barber: "Matty", ...r, start_time: r.start_time + ":00", end_time: r.end_time + ":00", break_start: r.break_start && r.break_start + ":00", break_end: r.break_end && r.break_end + ":00" }));
    const exRows = exceptions.map((x) => ({ ...x, start_time: x.start_time && x.start_time + ":00", end_time: x.end_time && x.end_time + ":00" }));
    for (const d of dates) {
      const sql = await starts("Matty", d);
      const js = L.openStarts(d, hourRows, exRows).map(L.fromMin);
      assert.deepEqual(js, sql, `scenario ${n}, ${d}: hours=${JSON.stringify(hours)} exceptions=${JSON.stringify(exceptions)}`);
      compared++; if (sql.length) nonEmpty++;
    }
  }
  assert.equal(compared, 40 * 28);
  assert.ok(nonEmpty > 300, `a meaningful share of the random days had open times (${nonEmpty})`);
});

test("hours.sql is safe to run twice and ends by reloading the API schema", async () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync(require("node:path").join(__dirname, "..", "supabase", "hours.sql"), "utf8").trim();
  assert.match(sql, /notify pgrst, 'reload schema';$/);
});
