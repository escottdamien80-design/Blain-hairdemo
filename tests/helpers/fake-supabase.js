"use strict";
// A small stand-in for the Supabase HTTP API (auth + PostgREST), used by the browser tests so they can
// run with the REAL supabase-js library and the REAL page code, without touching the real project.
// The rules here deliberately mirror supabase/*.sql (the SQL itself is tested separately against real
// Postgres in admin-sql.test.js):
//   • guests cannot read bookings; customers read only their own; admins read all
//   • admin_me / admin_create_booking / cancel_booking behave like the SQL functions
//   • one active booking per barber and time
// Test hooks let a test slow a request down, lose its response AFTER it was applied, fail it, or hang it.

const SUPABASE_HOST = "mddhykzuxrywhtmjwajy.supabase.co";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};

const sameBarber = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

class FakeSupabase {
  constructor({ now, users = [], admins = [], bookings = [] } = {}) {
    this.nowMs = now; // fixed "current time" so tests are deterministic
    this.users = users;   // { id, email, confirmed }
    this.admins = admins; // { email, barber_name }
    this.bookings = bookings.map((b) => ({ status: "confirmed", service: "Haircut", ...b }));
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
    if (this.bookings.some((b) => sameBarber(b.barber, barber) && new Date(b.appointment_time).getTime() === time && b.status !== "cancelled")) return "taken";
    const row = { barber, customer_name: name, service: a.p_service, appointment_time: iso, customer_phone: phone, customer_email: email, status: "confirmed", cancel_token: a.p_token, user_id: null };
    this.bookings.push(row);
    if (email) this.emails.push({ kind: "confirmed", to: email, booking: { ...row } });
    return "created";
  }

  // ---- HTTP ----
  json(route, status, body, headers = {}) {
    return route.fulfill({ status, headers: { "content-type": "application/json", ...CORS, ...headers }, body: JSON.stringify(body) });
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
    if (key === "GET bookings") {
      const rows = this.visibleBookings(id);
      if (rows === null) return this.denied("table bookings");
      let out = rows.slice();
      const p = url.searchParams;
      for (const v of p.getAll("appointment_time")) {
        const [op, val] = [v.slice(0, v.indexOf(".")), v.slice(v.indexOf(".") + 1)];
        const t = new Date(val).getTime();
        out = out.filter((r) => { const x = new Date(r.appointment_time).getTime(); return op === "gte" ? x >= t : op === "lt" ? x < t : op === "gt" ? x > t : op === "lte" ? x <= t : true; });
      }
      if (p.get("cancel_token")) out = out.filter((r) => r.cancel_token === p.get("cancel_token").replace(/^eq\./, ""));
      if (p.get("order") === "appointment_time.asc") out.sort((a, b) => new Date(a.appointment_time) - new Date(b.appointment_time));
      const cols = (p.get("select") || "*").split(",").map((c) => c.trim());
      const pick = (r) => (cols.includes("*") ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return { status: 200, body: out.map(pick) };
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
