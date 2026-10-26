"use strict";
// Shared test data for the hours / week-view / customer-slot browser tests.
// "Today" in these tests is Sunday 25 Oct 2026, 13:10 UK time (the day the clocks go back).
const crypto = require("node:crypto");
const { FakeSupabase, NOW, at } = require("./site");

const USERS = {
  matty: { id: "u-matty", email: "matty@example.com" },
  alfie: { id: "u-alfie", email: "alfie@example.com" },
  cust: { id: "u-cust", email: "cust@example.com" },
};
// the week after "today": Mon 26 Oct ... Sun 1 Nov
const D = { sun: "2026-10-25", mon: "2026-10-26", tue: "2026-10-27", wed: "2026-10-28", thu: "2026-10-29", fri: "2026-10-30", sat: "2026-10-31", sun2: "2026-11-01" };

const hrow = (barber, weekday, working, s, e, bs, be) => ({
  barber, weekday, working,
  start_time: s ? `${s}:00` : null, end_time: e ? `${e}:00` : null,
  break_start: bs ? `${bs}:00` : null, break_end: be ? `${be}:00` : null,
});

// Matty: Mon 09-18, Tue 09-18 (break 12-13), Wed 10-16, Thu 09-18, Fri 09-17, Sat 09-13, Sun off
const mattyHours = () => [
  hrow("Matty", 1, true, "09:00", "18:00"), hrow("Matty", 2, true, "09:00", "18:00", "12:00", "13:00"),
  hrow("Matty", 3, true, "10:00", "16:00"), hrow("Matty", 4, true, "09:00", "18:00"),
  hrow("Matty", 5, true, "09:00", "17:00"), hrow("Matty", 6, true, "09:00", "13:00"),
  hrow("Matty", 7, false, "09:00", "18:00"),
];

const bk = (barber, name, date, time, extra = {}) => ({
  barber, customer_name: name, appointment_time: at(date, time), customer_phone: "07700 900123",
  customer_email: `${name.split(" ")[0].toLowerCase()}@example.com`, cancel_token: crypto.randomUUID(), user_id: null, ...extra,
});
const exc = (id, barber, kind, from, to, start, end, note) => ({
  id, barber, kind, date_from: from, date_to: to, start_time: start ? `${start}:00` : null, end_time: end ? `${end}:00` : null, note: note || null,
});

function backendWith({ hours = mattyHours(), exceptions = [], bookings = [], now = NOW } = {}) {
  return new FakeSupabase({
    now, users: Object.values(USERS),
    admins: [{ email: "matty@example.com", barber_name: "Matty" }, { email: "alfie@example.com", barber_name: "Alfie" }],
    hours, exceptions, bookings,
  });
}

module.exports = { USERS, D, mattyHours, hrow, bk, exc, backendWith, NOW, at };
