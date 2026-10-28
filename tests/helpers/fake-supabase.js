"use strict";
// A small stand-in for the Supabase HTTP API (auth + PostgREST), used by the browser tests so they can
// run with the REAL supabase-js library and the REAL page code, without touching the real project.
// The rules here deliberately mirror supabase/*.sql (the SQL itself is tested separately against real
// Postgres in admin-sql.test.js):
//   • guests cannot read bookings; customers read only their own; admins read all
//   • admin_me / admin_create_booking / cancel_booking behave like the SQL functions
//   • one active booking per barber and time
// Test hooks let a test slow a request down, lose its response AFTER it was applied, fail it, or hang it.

const L = require("../../admin-logic.js");
const SUPABASE_HOST = "mddhykzuxrywhtmjwajy.supabase.co";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};

const sameBarber = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

class FakeSupabase {
  constructor({ now, users = [], admins = [], bookings = [], hours = [], exceptions = [] } = {}) {
    this.nowMs = now; // fixed "current time" so tests are deterministic
    this.users = users;   // { id, email, confirmed }
    this.admins = admins; // { email, barber_name }
    this.bookings = bookings.map((b) => ({ status: "confirmed", service: "Haircut", ...b }));
    this.hours = hours;           // barber_hours rows: { barber, weekday, working, start_time, end_time, break_start, break_end }
    this.exceptions = exceptions; // barber_exceptions rows: { id, barber, kind, date_from, date_to, start_time, end_time, note }
    this.emails = [];      // what the email trigger would have sent: { kind, to, booking }
    this.otpRequests = [];
    this.requests = [];    // every API request: { method, path, search, rpc, role }
    this.behaviors = {};   // key -> list of one-shot behaviours
    this.nextId = 1;
  }

  // ---- test hooks ----
  // key: an rpc name (e.g. "admin_create_booking") or "GET bookings"
  // mode: "delay" (ms), "lose-response" (apply it, then drop the connection), "fail-before" (drop it unapplied),
  //       "hang" (never answer), "http" (answer with {status, body} unapplied)
  once(key, behavior) { (this.behaviors[key] ||= []).push(behavior); }
  always(key, behavior) { (this.behaviors[key] ||= []).push({ ...behavior, forever: true }); }
  clearBehaviors() { this.behaviors = {}; }
  take(key) {
    const list = this.behaviors[key];
    if (!list || !list.length) return null;
    const b = list[0];
    if (!b.forever) list.shift();
    return b;
  }

  session(user) {
    const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
    return {
      access_token: `tok-${user.id}`, refresh_token: `ref-${user.id}`, token_type: "bearer",
      expires_in: 3600, expires_at: exp,
      user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, email_confirmed_at: "2020-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2020-01-01T00:00:00Z" },
    };
  }

  // ---- identity ----
  who(request) {
    const m = /^Bearer (.+)$/.exec(request.headers()["authorization"] || "");
    const tok = m && m[1];
    if (tok && tok.startsWith("tok-")) {
      const u = this.users.find((x) => `tok-${x.id}` === tok);
      if (u) return { role: "authenticated", user: u };
    }
    return { role: "anon", user: null };
  }
  isAdmin(user) {
    return Boolean(user && user.confirmed !== false && this.admins.some((a) => a.email.toLowerCase() === user.email.toLowerCase()));
  }

  // ---- the data rules (mirroring the SQL) ----
  visibleBookings(id) {
    if (id.role !== "authenticated") return null; // permission denied
    if (this.isAdmin(id.user)) return this.bookings;
    return this.bookings.filter((b) => b.user_id === id.user.id || (b.customer_email && b.customer_email.toLowerCase() === id.user.email.toLowerCase()));
  }

  cancel(token) {
    const b = this.bookings.find((x) => x.cancel_token === token);
    if (!b) return "not_found";
    if (b.status === "cancelled") return "already_cancelled";
    if (new Date(b.appointment_time).getTime() <= this.nowMs) return "past";
    b.status = "cancelled";
    if (b.customer_email) this.emails.push({ kind: "cancelled", to: b.customer_email, booking: { ...b } });
    return "cancelled";
  }

  create(a) {
    const name = String(a.p_name || "").trim();
    const phone = String(a.p_phone || "").trim();
    const email = String(a.p_email || "").trim() || null;
    const barber = String(a.p_barber || "").trim();
    const time = new Date(a.p_time).getTime();
    if (!barber) return "invalid_barber";
    if (!String(a.p_service || "").trim()) return "invalid_service";
    if (!Number.isFinite(time) || time > this.nowMs + 366 * 864e5) return "invalid_time";
    if (name.length < 1 || name.length > 80) return "invalid_name";
    if (phone.length < 6 || phone.length > 30) return "invalid_phone";
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "invalid_email";
    const iso = new Date(time).toISOString();
    const same = this.bookings.find((b) => b.cancel_token === a.p_token);
    if (same && same.status !== "cancelled" && new Date(same.appointment_time).getTime() === time && sameBarber(same.barber, barber)) return "created";
    if (time <= this.nowMs) return "past";
    if (this.hasHours(barber) && !this.slotOpen(barber, time)) return "closed";
    if (this.bookings.some((b) => sameBarber(b.barber, barber) && new Date(b.appointment_time).getTime() === time && b.status !== "cancelled")) return "taken";
    const row = { barber, customer_name: name, service: a.p_service, appointment_time: iso, customer_phone: phone, customer_email: email, status: "confirmed", cancel_token: a.p_token, user_id: null };
    this.bookings.push(row);
    if (email) this.emails.push({ kind: "confirmed", to: email, booking: { ...row } });
    return "created";
  }

  // ---- hours (the same rules as supabase/hours.sql; that file is tested against real Postgres) ----
  hoursFor(barber) { return this.hours.filter((h) => L.barberMatches(h.barber, barber)); }
  exFor(barber) { return this.exceptions.filter((x) => L.barberMatches(x.barber, barber)); }
  hasHours(barber) { return this.hoursFor(barber).length > 0; }
  slotOpen(barber, timeMs) {
    const iso = new Date(timeMs).toISOString();
    return L.openStarts(L.dateOfInstant(iso), this.hoursFor(barber), this.exFor(barber)).includes(L.toMin(L.formatTime(iso)));
  }
  isBooked(barber, timeMs) {
    return this.bookings.some((b) => L.barberMatches(b.barber, barber) && new Date(b.appointment_time).getTime() === timeMs && b.status !== "cancelled");
  }
  bookable(barber, from, days) {
    const out = [];
    const n = Math.min(Math.max(days || 7, 1), 31);
    for (let i = 0; i < n; i++) {
      const date = L.addDays(from, i);
      for (const m of L.openStarts(date, this.hoursFor(barber), this.exFor(barber))) {
        const at = L.londonToUtc(date, L.fromMin(m));
        if (at.getTime() > this.nowMs) out.push({ slot_time: at.toISOString(), free: !this.isBooked(barber, at.getTime()) });
      }
    }
    return out;
  }

  setHours(barber, days) {
    barber = String(barber || "").trim();
    if (!barber) return "invalid_barber";
    if (!Array.isArray(days) || days.length !== 7) return "invalid_days";
    const seen = new Set();
    const rows = [];
    for (let d of days) {
      if (!(d.weekday >= 1 && d.weekday <= 7) || seen.has(d.weekday)) return "invalid_days";
      seen.add(d.weekday);
      const s = L.toMin(d.start), e = L.toMin(d.end);
      const bs = L.toMin(d.break_start), be = L.toMin(d.break_end);
      if (d.working && (s == null || e == null || s >= e)) return "invalid_hours";
      if (!d.working) { d = { ...d, break_start: null, break_end: null }; }
      else if ((bs == null) !== (be == null)) return "invalid_break";
      else if (bs != null && !(s < bs && bs < be && be < e)) return "invalid_break";
      for (const m of [s, e, d.working ? bs : null, d.working ? be : null]) if (m != null && m % 30) return "invalid_hours";
      rows.push({ barber, weekday: d.weekday, working: Boolean(d.working), start_time: d.start && d.start + ":00", end_time: d.end && d.end + ":00", break_start: d.break_start && d.break_start + ":00", break_end: d.break_end && d.break_end + ":00" });
    }
    this.hours = this.hours.filter((h) => !L.barberMatches(h.barber, barber)).concat(rows);
    return "saved";
  }

  addException(a) {
    const barber = String(a.p_barber || "").trim();
    const today = L.todayStr(new Date(this.nowMs));
    if (!a.p_id) return "invalid_id";
    if (!barber) return "invalid_barber";
    if (!["off", "extra"].includes(a.p_kind)) return "invalid_kind";
    if (!a.p_from || !a.p_to || a.p_to < a.p_from || (Date.parse(a.p_to) - Date.parse(a.p_from)) / 864e5 > 62) return "invalid_date";
    if (a.p_to < today || a.p_from > L.addDays(today, 366)) return "invalid_date";
    if ((a.p_start == null) !== (a.p_end == null)) return "invalid_time";
    if (a.p_start != null && (L.toMin(a.p_start) >= L.toMin(a.p_end) || a.p_from !== a.p_to)) return "invalid_time";
    if (a.p_kind === "extra" && a.p_start == null) return "invalid_time";
    for (const t of [a.p_start, a.p_end]) if (t != null && L.toMin(t) % 30) return "invalid_time";
    if (a.p_note && a.p_note.length > 80) return "invalid_note";
    if (this.exceptions.some((x) => x.id === a.p_id)) return "created";
    this.exceptions.push({ id: a.p_id, barber, kind: a.p_kind, date_from: a.p_from, date_to: a.p_to, start_time: a.p_start && L.hhmmss(a.p_start), end_time: a.p_end && L.hhmmss(a.p_end), note: (a.p_note || "").trim() || null });
    return "created";
  }

  // ---- HTTP ----
  json(route, status, body, headers = {}) {
    return route.fulfill({ status, headers: { "content-type": "application/json", ...CORS, ...headers }, body: body === null ? "" : JSON.stringify(body) });
  }

  async handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const id = this.who(request);
    const path = url.pathname;
    const rec = { method: request.method(), path, search: url.search, role: id.role, user: id.user && id.user.email };
    this.requests.push(rec);

    // ---- auth ----
    if (path === "/auth/v1/otp") {
      this.otpRequests.push({ body: request.postDataJSON(), redirect: url.searchParams.get("redirect_to") });
      const b = this.take("otp");
      if (b && b.mode === "http") return this.json(route, b.status, b.body);
      return this.json(route, 200, {});
    }
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204, headers: CORS });
    if (path === "/auth/v1/user") {
      if (id.role !== "authenticated") return this.json(route, 401, { message: "invalid JWT" });
      return this.json(route, 200, this.session(id.user).user);
    }
    if (path === "/auth/v1/token") {
      const body = request.postDataJSON() || {};
      const u = this.users.find((x) => `ref-${x.id}` === body.refresh_token);
      return u ? this.json(route, 200, this.session(u)) : this.json(route, 400, { error: "invalid_grant" });
    }

    // ---- rest ----
    let key = null;
    if (path.startsWith("/rest/v1/rpc/")) key = path.replace("/rest/v1/rpc/", "");
    else if (path === "/rest/v1/bookings") key = `${request.method()} bookings`;
    else if (path === "/rest/v1/taken_slots") key = `${request.method()} taken_slots`;
    else if (path === "/rest/v1/barber_hours") key = `${request.method()} barber_hours`;
    else if (path === "/rest/v1/barber_exceptions") key = `${request.method()} barber_exceptions`;
    rec.key = key;

    const behavior = key && this.take(key);
    if (behavior) {
      if (behavior.delay) await new Promise((r) => setTimeout(r, behavior.delay));
      if (behavior.mode === "hang") return new Promise(() => {});
      if (behavior.mode === "fail-before") return route.abort("connectionreset");
      if (behavior.mode === "http") return this.json(route, behavior.status, behavior.body);
    }

    const result = await this.restResult(request, url, id, key);
    if (behavior && behavior.mode === "lose-response") return route.abort("connectionreset"); // applied, but the phone never hears
    return this.json(route, result.status, result.body);
  }

  denied(table) { return { status: 401, body: { code: "42501", message: `permission denied for ${table}`, details: null, hint: null } }; }

  async restResult(request, url, id, key) {
    if (key === "GET bookings" || key === "GET barber_hours" || key === "GET barber_exceptions") {
      let rows;
      if (key === "GET bookings") rows = this.visibleBookings(id);
      else rows = id.role === "authenticated" ? (this.isAdmin(id.user) ? (key === "GET barber_hours" ? this.hours : this.exceptions) : []) : null;
      if (rows === null) return this.denied(`table ${key.slice(4)}`);
      let out = rows.slice();
      const p = url.searchParams;
      const cmp = (a, b) => (/^\d{4}-\d\d-\d\dT/.test(String(a)) ? new Date(a).getTime() - new Date(b).getTime() : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
      for (const [col, v] of p.entries()) {
        if (["select", "order", "limit", "offset"].includes(col)) continue;
        const dot = v.indexOf(".");
        const op = v.slice(0, dot), val = v.slice(dot + 1);
        out = out.filter((r) => {
          const c = cmp(r[col], val);
          return op === "gte" ? c >= 0 : op === "lt" ? c < 0 : op === "gt" ? c > 0 : op === "lte" ? c <= 0 : op === "eq" ? c === 0 : true;
        });
      }
      if (p.get("order") === "appointment_time.asc") out.sort((a, b) => new Date(a.appointment_time) - new Date(b.appointment_time));
      const cols = (p.get("select") || "*").split(",").map((c) => c.trim());
      const pick = (r) => (cols.includes("*") ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return { status: 200, body: out.map(pick) };
    }

    if (key === "POST bookings") {
      // a customer or guest booking straight into the table (the website's normal booking), with the same rules as the database
      if (id.role === "anon" || id.role === "authenticated") {
        const row = request.postDataJSON();
        const time = new Date(row.appointment_time).getTime();
        if (row.status !== "confirmed" || !(time > this.nowMs)) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy for table \"bookings\"" } };
        if (this.hasHours(row.barber) && !this.slotOpen(row.barber, time)) return { status: 400, body: { code: "P0001", message: "slot_not_available", details: null, hint: "That time is outside the barber's working hours or is blocked." } };
        if (this.isBooked(row.barber, time)) return { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"bookings_one_active_per_barber_time\"" } };
        this.bookings.push({ service: "Haircut", ...row, user_id: row.user_id || null });
        if (row.customer_email) this.emails.push({ kind: "confirmed", to: row.customer_email, booking: { ...row } });
        return { status: 201, body: null };
      }
    }

    if (key === "bookable_slots") {
      const a = request.postDataJSON() || {};
      return { status: 200, body: this.bookable(a.p_barber, a.p_from, a.p_days) };
    }

    if (key === "admin_set_hours" || key === "admin_add_exception" || key === "admin_remove_exception") {
      if (id.role !== "authenticated") return this.denied(`function ${key}`);
      if (!this.isAdmin(id.user)) return { status: 403, body: { code: "42501", message: "not_admin", details: null, hint: null } };
      const a = request.postDataJSON() || {};
      if (key === "admin_set_hours") return { status: 200, body: this.setHours(a.p_barber, a.p_days) };
      if (key === "admin_add_exception") return { status: 200, body: this.addException(a) };
      const i = this.exceptions.findIndex((x) => x.id === a.p_id);
      if (i >= 0) this.exceptions.splice(i, 1);
      return { status: 200, body: i >= 0 ? "removed" : "not_found" };
    }

    if (key === "GET taken_slots") {
      const p = url.searchParams;
      return { status: 200, body: this.bookings.filter((b) => b.status !== "cancelled").map((b) => ({ barber: b.barber, appointment_time: b.appointment_time })) };
    }

    if (key === "admin_me") {
      if (id.role !== "authenticated") return this.denied("function admin_me");
      const a = this.isAdmin(id.user) && this.admins.find((x) => x.email.toLowerCase() === id.user.email.toLowerCase());
      return { status: 200, body: a ? [{ email: a.email, barber_name: a.barber_name }] : [] };
    }

    if (key === "get_booking") {
      const b = this.bookings.find((x) => x.cancel_token === request.postDataJSON().token);
      return { status: 200, body: b ? [{ barber: b.barber, service: b.service, appointment_time: b.appointment_time, status: b.status }] : [] };
    }

    if (key === "cancel_booking") {
      return { status: 200, body: this.cancel(request.postDataJSON().token) };
    }

    if (key === "admin_create_booking") {
      if (id.role !== "authenticated") return this.denied("function admin_create_booking");
      if (!this.isAdmin(id.user)) return { status: 403, body: { code: "42501", message: "not_admin", details: null, hint: null } };
      return { status: 200, body: this.create(request.postDataJSON()) };
    }

    return { status: 404, body: { code: "PGRST202", message: `fake backend: ${key} not implemented` } };
  }
}

module.exports = { FakeSupabase, SUPABASE_HOST };
