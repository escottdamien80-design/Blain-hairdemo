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

  // ---------------------------------------------------------------- working hours (mirrors supabase/hours.sql)
  // Rules (same as the database, which is what really decides):
  //  • appointments are 30 minutes; a start time is offered when the whole 30 minutes fits inside working
  //    hours, doesn't touch the break, and doesn't touch blocked time. Blocked time always wins.
  //  • "extra" hours on a date add open time (even on a day off); "off" removes time again.
  //  • a barber with NO hours saved yet: 09:00 to 18:00 (last start 18:00) every day, as before.
  const SLOT_MIN = 30;
  const FALLBACK = { start: 9 * 60, end: 18 * 60 + SLOT_MIN };
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  const toMin = (t) => (t == null || t === "" ? null : Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5)));
  const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const isoWeekday = (dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1 = Monday ... 7 = Sunday
  };
  const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // hoursRows: that barber's barber_hours rows ([] / null = nothing saved yet)
  // exceptions: that barber's barber_exceptions rows
  function scheduleFor(date, hoursRows, exceptions) {
    const rows = hoursRows || [];
    const configured = rows.length > 0;
    let work = null, brk = null;
    if (configured) {
      const r = rows.find((h) => Number(h.weekday) === isoWeekday(date));
      if (r && r.working) {
        work = { s: toMin(r.start_time), e: toMin(r.end_time) };
        if (r.break_start != null && r.break_end != null) brk = { s: toMin(r.break_start), e: toMin(r.break_end) };
      }
    } else {
      work = { s: FALLBACK.start, e: FALLBACK.end };
    }
    const on = (x) => date >= x.date_from && date <= x.date_to;
    const extras = [], offs = [];
    for (const x of exceptions || []) {
      if (!on(x)) continue;
      const item = { id: x.id, note: x.note || "", s: toMin(x.start_time), e: toMin(x.end_time), allDay: x.start_time == null, date_from: x.date_from, date_to: x.date_to };
      (x.kind === "extra" ? extras : offs).push(item);
    }
    return { configured, work, brk, extras, offs };
  }

  // The open start times (minutes since midnight) for one date. skipOffs = ignore blocks (to tell "blocked" from "outside hours")
  function openStarts(date, hoursRows, exceptions, { skipOffs = false } = {}) {
    const sch = scheduleFor(date, hoursRows, exceptions);
    const out = new Set();
    if (sch.work) {
      for (let s = sch.work.s; s <= sch.work.e - SLOT_MIN; s += SLOT_MIN) {
        if (sch.brk && s < sch.brk.e && s + SLOT_MIN > sch.brk.s) continue;
        out.add(s);
      }
    }
    for (const x of sch.extras) for (let s = x.s; s <= x.e - SLOT_MIN; s += SLOT_MIN) out.add(s);
    return [...out]
      .filter((s) => skipOffs || !sch.offs.some((o) => o.allDay || (s < o.e && s + SLOT_MIN > o.s)))
      .sort((a, b) => a - b);
  }

  // Everything the offered times depend on, for one barber: { hours: rows, exceptions: rows }
  // Free slots: open, in the future, and not booked (cancelled bookings don't block).
  // `taken` = booking rows ({barber, appointment_time, status}); with no hours/exceptions given this is the old fixed grid.
  function freeSlots({ date, barber, taken = [], now = new Date(), hours = [], exceptions = [] }) {
    const blocked = new Set(
      taken
        .filter((r) => r.status !== "cancelled" && sameName(r.barber, barber))
        .map((r) => new Date(r.appointment_time).getTime())
    );
    return openStarts(date, hours, exceptions)
      .map((m) => ({ time: fromMin(m), at: londonToUtc(date, fromMin(m)) }))
      .filter((s) => s.at.getTime() > now.getTime() && !blocked.has(s.at.getTime()))
      .map((s) => ({ time: s.time, iso: s.at.toISOString() }));
  }

  // Why a booking might sit outside the diary: null | "blocked" | "outside" (only for barbers that have hours)
  function bookingFlag(row, hoursRows, exceptions) {
    if (row.status === "cancelled") return null;
    const date = dateOfInstant(row.appointment_time);
    const t = toMin(formatTime(row.appointment_time));
    const barberHours = (hoursRows || []).filter((h) => sameName(h.barber, row.barber));
    const barberEx = (exceptions || []).filter((x) => sameName(x.barber, row.barber));
    if (openStarts(date, barberHours, barberEx).includes(t)) return null;
    if (openStarts(date, barberHours, barberEx, { skipOffs: true }).includes(t)) return "blocked";
    return barberHours.length ? "outside" : null;
  }

  // Active, upcoming bookings that a proposed change would newly put outside hours or in blocked time.
  // The change is described as the hours/exceptions as they would be AFTER saving. Nothing is ever cancelled.
  function newlyAffected(bookings, { hoursNow, exNow, hoursNext, exNext }, now = new Date()) {
    return bookings
      .filter((b) => b.status !== "cancelled" && new Date(b.appointment_time).getTime() > now.getTime())
      .filter((b) => !bookingFlag(b, hoursNow, exNow) && bookingFlag(b, hoursNext, exNext))
      .sort(byTime);
  }

  // ---- the weekly editor ------------------------------------------------------------------------
  const DEFAULT_DAY = { working: true, start: "09:00", end: "18:00", breakOn: false, bs: "12:00", be: "13:00" };
  const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));
  const hhmmss = (t) => (t == null ? null : `${String(t).slice(0, 5)}:00`);

  // 7 editable days (index 0 = Monday) from saved rows. Nothing saved yet = what customers get today:
  // 09:00 to 18:00 every day.
  function daysFromRows(rows) {
    return DAY_NAMES.map((_, i) => {
      const r = (rows || []).find((h) => Number(h.weekday) === i + 1);
      if (!r) return { ...DEFAULT_DAY, working: !(rows && rows.length) };
      return {
        working: Boolean(r.working),
        start: hhmm(r.start_time) || DEFAULT_DAY.start,
        end: hhmm(r.end_time) || DEFAULT_DAY.end,
        breakOn: r.break_start != null && r.break_end != null,
        bs: hhmm(r.break_start) || DEFAULT_DAY.bs,
        be: hhmm(r.break_end) || DEFAULT_DAY.be,
      };
    });
  }

  // The JSON the database function wants
  function daysToPayload(days) {
    return days.map((d, i) => ({
      weekday: i + 1, working: Boolean(d.working), start: d.start, end: d.end,
      break_start: d.working && d.breakOn ? d.bs : null, break_end: d.working && d.breakOn ? d.be : null,
    }));
  }

  // and as rows, to preview what a draft would do (same shape as the barber_hours table)
  function daysToRows(barber, days) {
    return daysToPayload(days).map((p) => ({
      barber, weekday: p.weekday, working: p.working, start_time: p.start, end_time: p.end, break_start: p.break_start, break_end: p.break_end,
    }));
  }

  // Problems with a draft week: [{ index, field, message }] (empty = fine)
  function validateWeek(days) {
    const bad = [];
    days.forEach((d, i) => {
      if (!d.working) return;
      const s = toMin(d.start), e = toMin(d.end);
      if (s == null || e == null) return bad.push({ index: i, field: "end", message: "Pick start and end times." });
      if (e <= s) return bad.push({ index: i, field: "end", message: "The end time must be after the start time." });
      if (e - s < SLOT_MIN) return bad.push({ index: i, field: "end", message: "Needs at least 30 minutes." });
      if (d.breakOn) {
        const bs = toMin(d.bs), be = toMin(d.be);
        if (bs == null || be == null || be <= bs) bad.push({ index: i, field: "be", message: "The break must end after it starts." });
        else if (bs <= s || be >= e) bad.push({ index: i, field: "bs", message: "The break must be inside working hours." });
      }
    });
    return bad;
  }

  const sameDays = (a, b) => JSON.stringify(daysToPayload(a)) === JSON.stringify(daysToPayload(b));

  // 30-minute choices for the time pickers
  function timeOptions(from = "06:00", to = "22:00") {
    const out = [];
    for (let m = toMin(from); m <= toMin(to); m += SLOT_MIN) out.push(fromMin(m));
    return out;
  }

  // ---- the week view ------------------------------------------------------------------------------
  function weekStart(dateStr) {
    return addDays(dateStr, 1 - isoWeekday(dateStr));
  }
  const weekDates = (start) => [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(start, n));

  function formatWeek(start) {
    const end = addDays(start, 6);
    const [, sm, sd] = start.split("-").map(Number);
    const [ey, em, ed] = end.split("-").map(Number);
    const mon = (m) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    const range = sm === em ? `${sd}–${ed} ${mon(em)}` : `${sd} ${mon(sm)} – ${ed} ${mon(em)}`;
    return start.slice(0, 4) === String(ey) && start.slice(0, 4) === todayStr().slice(0, 4) ? range : `${range} ${ey}`;
  }

  // Everything the week view draws for one day, in minutes since midnight (UK time)
  function dayModel(date, hoursRows, exceptions, bookings, now = new Date()) {
    const sch = scheduleFor(date, hoursRows, exceptions);
    const items = (bookings || [])
      .filter((b) => dateOfInstant(b.appointment_time) === date)
      .sort(byTime)
      .map((b) => ({ at: toMin(formatTime(b.appointment_time)), cancelled: b.status === "cancelled", flag: bookingFlag(b, hoursRows, exceptions), row: b }));
    const active = items.filter((i) => !i.cancelled);
    return { date, ...sch, bookings: items, count: active.length, today: date === todayStr(now) };
  }

  // One line describing the hours: "09:00–18:00 · break 12:00–13:00", "Day off", "Extra 09:00–13:00"
  function hoursText(model) {
    const parts = [];
    if (model.work) {
      parts.push(`${fromMin(model.work.s)}–${fromMin(model.work.e - (model.configured ? 0 : SLOT_MIN))}`);
      if (model.brk) parts.push(`break ${fromMin(model.brk.s)}–${fromMin(model.brk.e)}`);
    } else {
      parts.push("Day off");
    }
    for (const x of model.extras) parts.push(`extra ${fromMin(x.s)}–${fromMin(x.e)}`);
    return parts.join(" · ");
  }

  function offText(o) {
    return o.allDay ? "Off all day" : `Off ${fromMin(o.s)}–${fromMin(o.e)}`;
  }

  // The list line for a saved block / extra-hours entry
  function exceptionText(x, today = todayStr()) {
    const day = (d) => formatDay(d, today);
    const when = x.date_from === x.date_to ? day(x.date_from) : `${plainDay(x.date_from)} to ${plainDay(x.date_to)}`;
    const times = x.start_time ? ` ${hhmm(x.start_time)}–${hhmm(x.end_time)}` : "";
    return `${x.kind === "extra" ? "Extra hours" : x.start_time ? "Off" : "Day off"} · ${when}${times}`;
  }

  const barberMatches = sameName;

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
    closed: "That time is outside working hours or is blocked. Pick another time.",
    invalid_name: "Enter the customer's name.",
    invalid_phone: "Enter a phone number (7 to 20 digits).",
    invalid_email: "That email doesn't look right. Fix it, or leave it empty.",
    invalid_barber: "Pick a barber.",
    invalid_service: "Pick a service.",
  };

  return {
    TZ, BARBERS, SERVICES, SLOT_MIN, FALLBACK, DAY_NAMES, DEFAULT_DAY,
    toMin, fromMin, isoWeekday, scheduleFor, openStarts, bookingFlag, newlyAffected, daysFromRows, daysToPayload, daysToRows,
    validateWeek, sameDays, timeOptions, weekStart, weekDates, formatWeek, dayModel, hoursText, offText, exceptionText, barberMatches, plainDay, hhmm, hhmmss,
    londonParts, londonToUtc, todayStr, addDays, dayRange, dateOfInstant, isDateStr,
    formatTime, formatDay, freeSlots, bookingState, filterByBarber, byTime,
    validateManual, phoneHref, CANCEL_TEXT, CREATE_TEXT,
  };
});
