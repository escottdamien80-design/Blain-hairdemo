"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../admin-logic.js");

const row = (weekday, working, s, e, bs, be, barber = "Matty") => ({
  barber, weekday, working,
  start_time: s && `${s}:00`, end_time: e && `${e}:00`, break_start: bs && `${bs}:00`, break_end: be && `${be}:00`,
});
const ex = (kind, from, to, s, e, barber = "Matty", id = "x") => ({ id, barber, kind, date_from: from, date_to: to, start_time: s && `${s}:00`, end_time: e && `${e}:00`, note: null });
const fm = (a) => a.map(L.fromMin);
const range = (from, to) => { const o = []; for (let m = L.toMin(from); m <= L.toMin(to); m += 30) o.push(L.fromMin(m)); return o; };
const MON = "2027-06-07", TUE = "2027-06-08", SUN = "2027-06-13";
const hours = [row(1, true, "09:00", "18:00"), row(2, true, "09:00", "18:00", "12:00", "13:00"), row(3, false, "09:00", "18:00"), row(4, true, "10:00", "10:30"), row(5, true, "09:00", "17:00"), row(6, true, "09:00", "13:00"), row(7, false)];

test("weekday numbers: Monday is 1 and Sunday is 7", () => {
  assert.equal(L.isoWeekday("2027-06-07"), 1);
  assert.equal(L.isoWeekday("2027-06-13"), 7);
  assert.equal(L.isoWeekday("2026-10-25"), 7);
});

test("open times follow the hours; the last start leaves room for a 30-minute appointment", () => {
  assert.deepEqual(fm(L.openStarts(MON, hours, [])), range("09:00", "17:30"));
  assert.deepEqual(fm(L.openStarts("2027-06-11", hours, [])), range("09:00", "16:30"), "Friday 09:00–17:00");
  assert.deepEqual(fm(L.openStarts("2027-06-10", hours, [])), ["10:00"], "a 30-minute day has exactly one time");
  assert.deepEqual(L.openStarts("2027-06-09", hours, []), [], "a day off");
  assert.deepEqual(L.openStarts(SUN, hours, []), []);
});

test("a break removes the times inside it, and nothing else", () => {
  assert.deepEqual(fm(L.openStarts(TUE, hours, [])), [...range("09:00", "11:30"), ...range("13:00", "17:30")]);
  const half = [row(2, true, "09:00", "18:00", "12:30", "13:00")];
  assert.deepEqual(fm(L.openStarts(TUE, half, [])), [...range("09:00", "12:00"), ...range("13:00", "17:30")], "a 30-minute break removes one time");
});

test("whole days off, runs of days, and time ranges", () => {
  assert.deepEqual(L.openStarts(MON, hours, [ex("off", MON, MON)]), []);
  const holiday = [ex("off", MON, "2027-06-11")];
  for (const d of [MON, TUE, "2027-06-11"]) assert.deepEqual(L.openStarts(d, hours, holiday), [], d);
  assert.ok(L.openStarts("2027-06-12", hours, holiday).length > 0, "the day after the run is open again");
  const t = fm(L.openStarts(MON, hours, [ex("off", MON, MON, "14:00", "15:30")]));
  assert.ok(t.includes("13:30") && t.includes("15:30") && !["14:00", "14:30", "15:00"].some((x) => t.includes(x)));
});

test("overlapping, touching, identical and nested blocks all just add up", () => {
  const blocks = [ex("off", MON, MON, "10:00", "12:00", "Matty", "1"), ex("off", MON, MON, "11:00", "13:00", "Matty", "2"), ex("off", MON, MON, "13:00", "14:00", "Matty", "3"), ex("off", MON, MON, "10:00", "12:00", "Matty", "4"), ex("off", MON, MON, "10:30", "11:00", "Matty", "5")];
  assert.deepEqual(fm(L.openStarts(MON, hours, blocks)), [...range("09:00", "09:30"), ...range("14:00", "17:30")]);
  assert.deepEqual(L.openStarts(MON, hours, [...blocks, ex("off", MON, MON, null, null, "Matty", "6")]), []);
});

test("extra hours add time (even on a day off) and a block always wins", () => {
  assert.deepEqual(fm(L.openStarts(SUN, hours, [ex("extra", SUN, SUN, "10:00", "13:00")])), range("10:00", "12:30"));
  assert.deepEqual(fm(L.openStarts(MON, hours, [ex("extra", MON, MON, "18:00", "19:30")])), range("09:00", "19:00"));
  assert.deepEqual(fm(L.openStarts(SUN, hours, [ex("extra", SUN, SUN, "10:00", "13:00"), ex("off", SUN, SUN, "11:00", "12:00")])), ["10:00", "10:30", "12:00", "12:30"]);
  assert.deepEqual(L.openStarts(SUN, hours, [ex("extra", SUN, SUN, "10:00", "13:00"), ex("off", SUN, SUN)]), [], "a whole-day block beats extra hours");
  assert.ok(L.openStarts(TUE, hours, [ex("extra", TUE, TUE, "12:00", "12:30")]).includes(12 * 60), "extra hours inside a break reopen it");
});

test("a barber with no hours saved gets the original grid, minus blocks", () => {
  assert.deepEqual(fm(L.openStarts(SUN, [], [])), range("09:00", "18:00"));
  assert.deepEqual(fm(L.openStarts(SUN, null, undefined)), range("09:00", "18:00"));
  assert.deepEqual(fm(L.openStarts(SUN, [], [ex("off", SUN, SUN, "12:00", "13:00")])), [...range("09:00", "11:30"), ...range("13:00", "18:00")]);
});

test("free slots combine hours, blocks, bookings, the clock, and the barber's name", () => {
  const taken = [{ barber: "matty", appointment_time: L.londonToUtc("2026-10-26", "10:00").toISOString(), status: "confirmed" },
    { barber: "Matty", appointment_time: L.londonToUtc("2026-10-26", "10:30").toISOString(), status: "cancelled" },
    { barber: "Alfie", appointment_time: L.londonToUtc("2026-10-26", "11:00").toISOString(), status: "confirmed" }];
  const now = new Date("2026-10-25T13:10:00Z");
  const t = L.freeSlots({ date: "2026-10-26", barber: "Matty", taken, now, hours, exceptions: [ex("off", "2026-10-26", "2026-10-26", "14:00", "15:00")] }).map((s) => s.time);
  assert.ok(!t.includes("10:00") && t.includes("10:30") && t.includes("11:00"));
  assert.ok(!t.includes("14:00") && !t.includes("14:30") && t.includes("15:00"));
  assert.equal(t[0], "09:00");
  assert.equal(t.at(-1), "17:30");
  // hours don't carry across barbers: rows for Alfie are ignored by the caller's filtering, so the caller passes only Matty's
  assert.deepEqual(L.freeSlots({ date: "2026-10-26", barber: "Matty", now: new Date("2026-10-26T09:00:00Z"), hours }).slice(0, 1).map((s) => s.time), ["09:30"], "times that have started are gone");
});

test("clock-change days: the same wall-clock hours, at the right UTC moment", () => {
  const h = [row(7, true, "09:00", "18:00"), row(6, true, "09:00", "18:00")];
  const first = (d) => L.freeSlots({ date: d, barber: "Matty", now: new Date("2026-01-01T00:00:00Z"), hours: h })[0].iso;
  assert.equal(first("2027-03-27"), "2027-03-27T09:00:00.000Z");
  assert.equal(first("2027-03-28"), "2027-03-28T08:00:00.000Z", "BST starts");
  assert.equal(first("2027-10-30"), "2027-10-30T08:00:00.000Z");
  assert.equal(first("2027-10-31"), "2027-10-31T09:00:00.000Z", "GMT again");
  assert.equal(L.freeSlots({ date: "2027-10-31", barber: "Matty", now: new Date("2026-01-01T00:00:00Z"), hours: h }).length, 18);
  assert.equal(L.freeSlots({ date: "2027-03-28", barber: "Matty", now: new Date("2026-01-01T00:00:00Z"), hours: h }).length, 18);
});

test("booking flags: null when fine, 'blocked' in blocked time, 'outside' outside hours; cancelled ones are never flagged", () => {
  const b = (date, time, extra = {}) => ({ barber: "Matty", status: "confirmed", appointment_time: L.londonToUtc(date, time).toISOString(), ...extra });
  const blocks = [ex("off", MON, MON, "10:00", "11:00")];
  assert.equal(L.bookingFlag(b(MON, "09:30"), hours, blocks), null);
  assert.equal(L.bookingFlag(b(MON, "10:30"), hours, blocks), "blocked");
  assert.equal(L.bookingFlag(b(MON, "18:00"), hours, blocks), "outside");
  assert.equal(L.bookingFlag(b(SUN, "10:00"), hours, blocks), "outside", "a day off");
  assert.equal(L.bookingFlag(b(TUE, "12:00"), hours, blocks), "outside", "in the break");
  assert.equal(L.bookingFlag(b(MON, "10:30", { status: "cancelled" }), hours, blocks), null);
  assert.equal(L.bookingFlag(b(MON, "10:30"), [], []), null, "no hours and no blocks: nothing to be outside of");
  assert.equal(L.bookingFlag(b(MON, "10:30"), [], blocks), "blocked", "a block applies even without weekly hours");
  assert.equal(L.bookingFlag(b(SUN, "04:00"), [], []), null, "no weekly hours: never 'outside'");
  assert.equal(L.bookingFlag(b(MON, "10:30", { barber: "Alfie" }), hours, blocks), null, "another barber's hours and blocks are not used");
});

test("newlyAffected: only bookings a change would newly put outside, never past or cancelled ones", () => {
  const now = new Date("2027-06-01T00:00:00Z");
  const b = (id, date, time, extra = {}) => ({ id, barber: "Matty", status: "confirmed", appointment_time: L.londonToUtc(date, time).toISOString(), ...extra });
  const bookings = [b(1, MON, "10:00"), b(2, MON, "17:00"), b(3, MON, "17:30", { status: "cancelled" }), b(4, SUN, "10:00"), b(5, "2027-05-20", "10:00")];
  const shorter = hours.map((h) => (h.weekday === 1 ? { ...h, end_time: "16:00:00" } : h));
  const out = L.newlyAffected(bookings, { hoursNow: hours, exNow: [], hoursNext: shorter, exNext: [] }, now);
  assert.deepEqual(out.map((x) => x.id), [2], "only the 17:00 booking: 10:00 is fine, 17:30 is cancelled, Sunday was already outside, 20 May is past");
  const blocked = L.newlyAffected(bookings, { hoursNow: hours, exNow: [], hoursNext: hours, exNext: [ex("off", MON, MON, "09:00", "10:30")] }, now);
  assert.deepEqual(blocked.map((x) => x.id), [1]);
  assert.deepEqual(L.newlyAffected(bookings, { hoursNow: hours, exNow: [], hoursNext: hours, exNext: [] }, now), [], "no change, nobody affected");
});

test("the editor: saved rows become 7 editable days and back; no rows means the old default week", () => {
  const days = L.daysFromRows(hours);
  assert.equal(days.length, 7);
  assert.deepEqual(days[1], { working: true, start: "09:00", end: "18:00", breakOn: true, bs: "12:00", be: "13:00" });
  assert.equal(days[2].working, false);
  assert.equal(days[0].breakOn, false);
  const none = L.daysFromRows([]);
  assert.ok(none.every((d) => d.working && d.start === "09:00" && d.end === "18:00" && !d.breakOn), "everyone starts from what customers get today");
  const payload = L.daysToPayload(days);
  assert.equal(payload.length, 7);
  assert.deepEqual(payload[1], { weekday: 2, working: true, start: "09:00", end: "18:00", break_start: "12:00", break_end: "13:00" });
  assert.deepEqual(payload[2].break_start, null);
  const rows = L.daysToRows("Matty", days);
  assert.deepEqual(fm(L.openStarts(TUE, rows, [])), [...range("09:00", "11:30"), ...range("13:00", "17:30")], "a draft can be previewed through the same logic");
  assert.ok(L.sameDays(days, L.daysFromRows(hours)));
  const changed = L.daysFromRows(hours); changed[0].end = "17:00";
  assert.equal(L.sameDays(days, changed), false);
});

test("a break is dropped from the payload on a day that's off, or with the break switched off", () => {
  const days = L.daysFromRows(hours);
  days[1].working = false;
  assert.equal(L.daysToPayload(days)[1].break_start, null);
  days[1].working = true; days[1].breakOn = false;
  assert.equal(L.daysToPayload(days)[1].break_end, null);
});

test("week validation catches every kind of bad day, and passes a good week", () => {
  const good = L.daysFromRows(hours);
  assert.deepEqual(L.validateWeek(good), []);
  const bad = (mut) => { const d = L.daysFromRows(hours); mut(d); return L.validateWeek(d); };
  assert.equal(bad((d) => { d[0].end = "09:00"; })[0].index, 0);
  assert.match(bad((d) => { d[0].end = "08:00"; })[0].message, /end time must be after/);
  assert.match(bad((d) => { d[1].bs = "08:00"; })[0].message, /inside working hours/);
  assert.match(bad((d) => { d[1].be = "18:00"; })[0].message, /inside working hours/);
  assert.match(bad((d) => { d[1].bs = "13:00"; d[1].be = "12:00"; })[0].message, /break must end after/);
  assert.deepEqual(bad((d) => { d[2].start = "17:00"; d[2].end = "09:00"; }), [], "a day that's off is not checked");
  assert.equal(bad((d) => { d[0].end = "09:00"; d[3].end = "09:00"; }).length, 2, "every bad day is reported");
});

test("time pickers offer every half hour from 06:00 to 22:00", () => {
  const t = L.timeOptions();
  assert.equal(t[0], "06:00");
  assert.equal(t.at(-1), "22:00");
  assert.equal(t.length, 33);
});

test("weeks start on Monday, including when today is a Sunday", () => {
  assert.equal(L.weekStart("2026-10-25"), "2026-10-19", "Sunday belongs to the week that began Monday 19th");
  assert.equal(L.weekStart("2026-10-26"), "2026-10-26");
  assert.equal(L.weekStart("2026-10-28"), "2026-10-26");
  assert.deepEqual(L.weekDates("2026-10-26"), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  assert.equal(L.weekStart("2027-01-01"), "2026-12-28", "across the new year");
  assert.equal(L.weekDates("2027-03-22").length, 7);
});

test("week labels", () => {
  const y = new Date().getFullYear();
  assert.match(L.formatWeek("2026-10-19"), /^19–25 Oct( 2026)?$/);
  assert.match(L.formatWeek("2026-10-26"), /^26 Oct – 1 Nov( 2026)?$/);
  assert.equal(L.formatWeek("2030-01-07"), "7–13 Jan 2030");
  assert.ok(y);
});

test("week day model: hours, break, blocks, extra hours, and bookings by UK day across the clock change", () => {
  const b = (date, time, extra = {}) => ({ barber: "Matty", status: "confirmed", customer_name: "X", appointment_time: L.londonToUtc(date, time).toISOString(), ...extra });
  const bookings = [b("2026-10-24", "09:00"), b("2026-10-25", "23:30"), b("2026-10-26", "00:00"), b("2026-10-25", "10:00", { status: "cancelled" })];
  const sat = L.dayModel("2026-10-24", hours, [], bookings, new Date("2026-10-25T13:10:00Z"));
  const sun = L.dayModel("2026-10-25", hours, [ex("extra", "2026-10-25", "2026-10-25", "10:00", "13:00")], bookings, new Date("2026-10-25T13:10:00Z"));
  const mon = L.dayModel("2026-10-26", hours, [], bookings, new Date("2026-10-25T13:10:00Z"));
  assert.equal(sat.count, 1);
  assert.equal(sun.count, 1, "23:30 is Sunday; the cancelled one isn't counted");
  assert.equal(sun.bookings.length, 2, "but it's still in the list for display");
  assert.equal(mon.count, 1, "00:00 Monday is Monday");
  assert.equal(sun.today, true);
  assert.equal(L.hoursText(sat), "09:00–13:00");
  assert.equal(L.hoursText(sun), "Day off · extra 10:00–13:00");
  assert.equal(L.hoursText(L.dayModel(TUE, hours, [], [])), "09:00–18:00 · break 12:00–13:00");
  assert.equal(L.hoursText(L.dayModel(MON, [], [], [])), "09:00–18:00", "the old grid is described by its last start");
  assert.equal(L.offText({ allDay: true }), "Off all day");
  assert.equal(L.offText({ allDay: false, s: 14 * 60, e: 15 * 60 + 30 }), "Off 14:00–15:30");
});

test("list text for days off and extra hours", () => {
  const t = "2026-10-25";
  assert.equal(L.exceptionText(ex("off", "2026-10-28", "2026-10-28"), t), "Day off · Wed 28 Oct");
  assert.equal(L.exceptionText(ex("off", "2026-10-26", "2026-10-30"), t), "Day off · Mon 26 Oct to Fri 30 Oct");
  assert.equal(L.exceptionText(ex("off", "2026-10-26", "2026-10-26", "14:00", "15:30"), t), "Off · Tomorrow · Mon 26 Oct 14:00–15:30");
  assert.equal(L.exceptionText(ex("extra", "2026-11-01", "2026-11-01", "10:00", "13:00"), t), "Extra hours · Sun 1 Nov 10:00–13:00");
});
