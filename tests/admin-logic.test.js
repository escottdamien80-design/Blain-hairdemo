"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../admin-logic.js");

test("UK wall-clock times convert to the right moment in winter and summer", () => {
  assert.equal(L.londonToUtc("2026-01-15", "10:30").toISOString(), "2026-01-15T10:30:00.000Z"); // GMT
  assert.equal(L.londonToUtc("2026-07-15", "10:30").toISOString(), "2026-07-15T09:30:00.000Z"); // BST
  assert.equal(L.londonToUtc("2026-10-24", "09:00").toISOString(), "2026-10-24T08:00:00.000Z"); // last BST day
  assert.equal(L.londonToUtc("2026-10-25", "09:00").toISOString(), "2026-10-25T09:00:00.000Z"); // clocks went back
  assert.equal(L.londonToUtc("2027-03-28", "09:00").toISOString(), "2027-03-28T08:00:00.000Z"); // clocks went forward
});

test("a day is 00:00 to the next 00:00 UK time, even on 23 and 25 hour days", () => {
  const hours = (d) => { const r = L.dayRange(d); return (Date.parse(r.end) - Date.parse(r.start)) / 36e5; };
  assert.equal(hours("2026-10-24"), 24);
  assert.equal(hours("2026-10-25"), 25); // autumn: clocks go back
  assert.equal(hours("2027-03-28"), 23); // spring: clocks go forward
  assert.deepEqual(L.dayRange("2026-10-25"), { start: "2026-10-24T23:00:00.000Z", end: "2026-10-26T00:00:00.000Z" });
});

test("today is UK today, whatever the clock's own zone (just after UK midnight in summer)", () => {
  assert.equal(L.todayStr(new Date("2026-07-14T23:30:00Z")), "2026-07-15"); // 00:30 BST on the 15th
  assert.equal(L.todayStr(new Date("2026-01-14T23:30:00Z")), "2026-01-14");
  assert.equal(L.todayStr(new Date("2026-10-25T13:10:00Z")), "2026-10-25");
});

test("addDays crosses month and year ends, and daylight-saving days, without drifting", () => {
  assert.equal(L.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(L.addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(L.addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(L.addDays("2026-10-25", -1), "2026-10-24");
});

test("date validation", () => {
  assert.ok(L.isDateStr("2026-10-25"));
  for (const bad of ["", "2026-13-01", "2026-02-30", "26-10-25", "2026-10-5", null, undefined, "2999-01-01", "abc"]) assert.equal(L.isDateStr(bad), false, String(bad));
});

test("formatting: times in UK time, friendly day names", () => {
  assert.equal(L.formatTime("2026-07-15T09:30:00Z"), "10:30");
  assert.equal(L.formatTime("2026-10-25T00:30:00Z"), "01:30");
  assert.equal(L.formatDay("2026-10-25", "2026-10-25"), "Today · Sun 25 Oct");
  assert.equal(L.formatDay("2026-10-26", "2026-10-25"), "Tomorrow · Mon 26 Oct");
  assert.equal(L.formatDay("2026-10-24", "2026-10-25"), "Yesterday · Sat 24 Oct");
  assert.equal(L.formatDay("2026-11-03", "2026-10-25"), "Tue 3 Nov");
  assert.equal(L.formatDay("2027-01-04", "2026-10-25"), "Mon 4 Jan 2027");
});

test("the slot grid runs 09:00 to 18:00 every 30 minutes", () => {
  const g = L.slotGrid();
  assert.equal(g[0], "09:00");
  assert.equal(g.at(-1), "18:00");
  assert.equal(g.length, 19);
  assert.ok(g.includes("12:30"));
});

test("free slots: past times, booked times (this barber only) and nothing else are removed; cancelled bookings free the time", () => {
  const now = new Date("2026-10-25T13:10:00Z");
  const taken = [
    { barber: "Matty", appointment_time: "2026-10-25T14:00:00Z", status: "confirmed" },
    { barber: "matty ", appointment_time: "2026-10-25T15:00:00Z", status: "confirmed" }, // case/space tolerant
    { barber: "Matty", appointment_time: "2026-10-25T16:00:00Z", status: "cancelled" },  // cancelled = free
    { barber: "Alfie", appointment_time: "2026-10-25T17:00:00Z", status: "confirmed" },  // other barber
  ];
  const times = L.freeSlots({ date: "2026-10-25", barber: "Matty", taken, now }).map((s) => s.time);
  assert.ok(!times.includes("13:00"), "13:00 has passed");
  assert.ok(!times.includes("13:10"));
  assert.equal(times[0], "13:30", "first free time is the next half hour");
  assert.ok(!times.includes("14:00") && !times.includes("15:00"));
  assert.ok(times.includes("16:00"), "cancelled slot is free");
  assert.ok(times.includes("17:00"), "other barber's booking doesn't block Matty");
  // and the same list for Alfie differs only in 17:00
  const alfie = L.freeSlots({ date: "2026-10-25", barber: "Alfie", taken, now }).map((s) => s.time);
  assert.ok(!alfie.includes("17:00") && alfie.includes("14:00"));
});

test("free slots: a past day has none, a future day has the full grid, and the exact current minute is not free", () => {
  const now = new Date("2026-10-25T13:10:00Z");
  assert.equal(L.freeSlots({ date: "2026-10-24", barber: "Matty", now }).length, 0);
  assert.equal(L.freeSlots({ date: "2026-10-26", barber: "Matty", now }).length, 19);
  assert.equal(L.freeSlots({ date: "2026-10-25", barber: "Matty", now: new Date("2026-10-25T13:30:00Z") })[0].time, "14:00");
  assert.equal(L.freeSlots({ date: "2026-10-25", barber: "Matty", now: new Date("2026-10-25T18:30:00Z") }).length, 0, "after closing time nothing is left today");
});

test("free slots: the iso time sent to the database is the right UTC moment (summer day)", () => {
  const s = L.freeSlots({ date: "2027-07-01", barber: "Matty", now: new Date("2027-06-01T00:00:00Z") });
  assert.equal(s[0].time, "09:00");
  assert.equal(s[0].iso, "2027-07-01T08:00:00.000Z");
});

test("booking state", () => {
  const now = new Date("2026-10-25T13:10:00Z");
  assert.equal(L.bookingState({ status: "cancelled", appointment_time: "2026-10-26T10:00:00Z" }, now), "cancelled");
  assert.equal(L.bookingState({ status: "cancelled", appointment_time: "2026-10-20T10:00:00Z" }, now), "cancelled");
  assert.equal(L.bookingState({ status: "confirmed", appointment_time: "2026-10-25T13:10:00Z" }, now), "past");
  assert.equal(L.bookingState({ status: "confirmed", appointment_time: "2026-10-25T13:11:00Z" }, now), "upcoming");
  assert.equal(L.bookingState({ status: null, appointment_time: "2026-10-26T10:00:00Z" }, now), "upcoming");
});

test("filter by barber and sort by time", () => {
  const rows = [
    { barber: "Alfie", appointment_time: "2026-10-26T11:00:00Z" },
    { barber: "Matty", appointment_time: "2026-10-26T10:00:00Z" },
    { barber: "Alfie", appointment_time: "2026-10-26T09:00:00Z" },
  ];
  assert.deepEqual(L.filterByBarber(rows, "all").map((r) => r.appointment_time.slice(11, 13)), ["09", "10", "11"]);
  assert.deepEqual(L.filterByBarber(rows, "Alfie").map((r) => r.appointment_time.slice(11, 13)), ["09", "11"]);
  assert.deepEqual(L.filterByBarber(rows, "alfie").length, 2);
  assert.equal(L.filterByBarber(rows, "Nobody").length, 0);
  assert.equal(rows[0].barber, "Alfie", "input is not reordered");
});

test("manual booking validation", () => {
  const ok = { name: "Dave Smith", phone: "07700 900123", email: "" };
  assert.equal(L.validateManual(ok), null);
  assert.equal(L.validateManual({ ...ok, email: "dave@example.com" }), null);
  assert.equal(L.validateManual({ ...ok, phone: "+44 7700 900123" }), null);
  assert.equal(L.validateManual({ ...ok, name: " " }).field, "name");
  assert.equal(L.validateManual({ ...ok, name: "D" }).field, "name");
  assert.equal(L.validateManual({ ...ok, name: "x".repeat(81) }).field, "name");
  assert.equal(L.validateManual({ ...ok, phone: "" }).field, "phone");
  assert.equal(L.validateManual({ ...ok, phone: "12345" }).field, "phone");
  assert.equal(L.validateManual({ ...ok, phone: "call me" }).field, "phone");
  assert.equal(L.validateManual({ ...ok, email: "nope" }).field, "email");
  assert.equal(L.validateManual({ ...ok, email: "a@b" }).field, "email");
  assert.equal(L.validateManual({ ...ok, email: "  " }), null, "blank email is fine");
});

test("phone links keep only digits and +", () => {
  assert.equal(L.phoneHref("07700 900-123"), "tel:07700900123");
  assert.equal(L.phoneHref("+44 (0)7700 900123"), "tel:+4407700900123");
  assert.equal(L.phoneHref(""), "");
  assert.equal(L.phoneHref(null), "");
});

test("every answer the database can give has wording", () => {
  for (const k of ["cancelled", "already_cancelled", "past", "not_found"]) assert.ok(L.CANCEL_TEXT[k], k);
  for (const k of ["taken", "past", "invalid_time", "invalid_name", "invalid_phone", "invalid_email", "invalid_barber", "invalid_service"]) assert.ok(L.CREATE_TEXT[k], k);
});
