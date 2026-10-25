"use strict";
// Blain Hair admin: the small pure helpers behind admin.html (dates, free slots, validation, wording).
// No page or network code in here, so it can be unit-tested in Node (tests/admin-logic.test.js).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdminLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // The shop is in the UK: days, times and "today" are always UK time (GMT/BST), whatever the
  // phone's own clock says. Appointments are stored in UTC, like the confirmation emails assume.
  const TZ = "Europe/London";

  // Times offered when adding a booking by hand. Working days and hours are not set up yet
  // (a later part), so this is one fixed grid; change these three numbers to change it.
  const OPEN = "09:00";
  const CLOSE = "18:00"; // the last start time
  const STEP_MIN = 30;

  const BARBERS = ["Matty", "Alfie"];
  const SERVICES = ["Haircut"];

  const partsFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  function londonParts(date) {
    const o = {};
    for (const p of partsFmt.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
    return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
  }

  const pad = (n) => String(n).padStart(2, "0");

  // How far UK time is ahead of UTC at this instant (0 in winter, 1 hour in summer)
  function offsetMs(utcMs) {
    const p = londonParts(new Date(utcMs));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000;
  }

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function isDateStr(s) {
    const m = DATE_RE.exec(String(s));
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }

  // "2026-10-25" + "10:30" in UK time -> the real moment (a Date)
  function londonToUtc(dateStr, timeStr) {
    const m = DATE_RE.exec(dateStr);
    const t = TIME_RE.exec(timeStr);
    if (!m || !t) throw new Error("bad date or time");
    const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
    const guess = naive - offsetMs(naive);
    return new Date(naive - offsetMs(guess));
  }

  function todayStr(now = new Date()) {
    const p = londonParts(now);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  }

  function addDays(dateStr, n) {
    const m = DATE_RE.exec(dateStr);
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  // The UK day as a [start, end) range of real moments. On the days the clocks change the day is
  // 23 or 25 hours long, so the end is the next UK midnight, never "start + 24 hours".
  function dayRange(dateStr) {
    return {
      start: londonToUtc(dateStr, "00:00").toISOString(),
      end: londonToUtc(addDays(dateStr, 1), "00:00").toISOString(),
    };
  }

  function dateOfInstant(iso) {
    return todayStr(new Date(iso));
  }

  function formatTime(iso) {
    const p = londonParts(new Date(iso));
    return `${pad(p.h)}:${pad(p.mi)}`;
  }

  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  function plainDay(dateStr) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const o = {};
    for (const p of dayFmt.formatToParts(new Date(Date.UTC(y, mo - 1, d, 12)))) o[p.type] = p.value;
    return `${o.weekday} ${o.day} ${o.month}`;
  }

  // "Today · Sun 25 Oct", "Tomorrow · Mon 26 Oct", "Yesterday · …", or "Fri 30 Oct" (+ year if not this year)
  function formatDay(dateStr, today = todayStr()) {
    const base = plainDay(dateStr);
    if (dateStr === today) return `Today · ${base}`;
    if (dateStr === addDays(today, 1)) return `Tomorrow · ${base}`;
    if (dateStr === addDays(today, -1)) return `Yesterday · ${base}`;
    return dateStr.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${dateStr.slice(0, 4)}`;
  }

  // The times on offer, as "HH:MM"
  function slotGrid() {
    const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const out = [];
    for (let t = mins(OPEN); t <= mins(CLOSE); t += STEP_MIN) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    return out;
  }

  // Only FREE slots: not in the past, and not already booked for this barber.
  // `taken` = rows ({barber, appointment_time, status}) for that day; cancelled ones don't block.
  function freeSlots({ date, barber, taken = [], now = new Date() }) {
    const blocked = new Set(
      taken
        .filter((r) => r.status !== "cancelled" && String(r.barber).trim().toLowerCase() === String(barber).trim().toLowerCase())
        .map((r) => new Date(r.appointment_time).getTime())
    );
    return slotGrid()
      .map((time) => ({ time, at: londonToUtc(date, time) }))
      .filter((s) => s.at.getTime() > now.getTime() && !blocked.has(s.at.getTime()))
      .map((s) => ({ time: s.time, iso: s.at.toISOString() }));
  }

  // upcoming = confirmed and still ahead; past = confirmed but over; cancelled
  function bookingState(row, now = new Date()) {
    if (row.status === "cancelled") return "cancelled";
    return new Date(row.appointment_time).getTime() <= now.getTime() ? "past" : "upcoming";
  }

  function byTime(a, b) {
    return new Date(a.appointment_time) - new Date(b.appointment_time) || String(a.barber).localeCompare(String(b.barber));
  }

  function filterByBarber(rows, barber) {
    const list = barber && barber !== "all" ? rows.filter((r) => String(r.barber).toLowerCase() === barber.toLowerCase()) : rows.slice();
    return list.sort(byTime);
  }

  // Same rules the customer booking form uses (phone) and the database enforces (lengths)
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;
  function validateManual({ name = "", phone = "", email = "" }) {
    name = name.trim(); phone = phone.trim(); email = email.trim();
    if (name.length < 2) return { field: "name", message: "Enter the customer's name." };
    if (name.length > 80) return { field: "name", message: "That name is too long." };
    if (!PHONE_RE.test(phone)) return { field: "phone", message: "Enter a phone number (7 to 20 digits)." };
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
      return { field: "email", message: "That email doesn't look right. Fix it, or leave it empty." };
    }
    return null;
  }

  function phoneHref(phone) {
    const clean = String(phone || "").replace(/[^\d+]/g, "");
    return clean ? `tel:${clean}` : "";
  }

  // What to tell the barber for each answer the database can give
  const CANCEL_TEXT = {
    cancelled: { ok: true, text: (b) => `Cancelled. ${b} is free again.` },
    already_cancelled: { ok: true, text: () => "That booking was already cancelled." },
    past: { ok: false, text: () => "That appointment has already passed, so it can't be cancelled." },
    not_found: { ok: false, text: () => "That booking no longer exists. The list has been refreshed." },
  };

  const CREATE_TEXT = {
    created: null,
    taken: "Sorry, that time has just been taken. Pick another time.",
    past: "That time has already passed. Pick a later time.",
    invalid_time: "That date isn't allowed. Pick a date within the next year.",
    invalid_name: "Enter the customer's name.",
    invalid_phone: "Enter a phone number (7 to 20 digits).",
    invalid_email: "That email doesn't look right. Fix it, or leave it empty.",
    invalid_barber: "Pick a barber.",
    invalid_service: "Pick a service.",
  };

  return {
    TZ, BARBERS, SERVICES, OPEN, CLOSE, STEP_MIN,
    londonParts, londonToUtc, todayStr, addDays, dayRange, dateOfInstant, isDateStr,
    formatTime, formatDay, slotGrid, freeSlots, bookingState, filterByBarber, byTime,
    validateManual, phoneHref, CANCEL_TEXT, CREATE_TEXT,
  };
});
