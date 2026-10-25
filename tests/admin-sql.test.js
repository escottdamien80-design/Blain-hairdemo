"use strict";
// Security + behaviour tests for supabase/admin.sql, run against a real throwaway Postgres
// with the real setup / cancellation / emails / auth / email_trigger / admin scripts loaded.
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { startCluster, connect, bootstrap } = require("./helpers/db");

let cluster, db;

const ADMIN = "11111111-1111-1111-1111-111111111111";      // matty@example.com, listed in admins
const ADMIN2 = "22222222-2222-2222-2222-222222222222";     // Alfie@Example.com (mixed case in the table)
const CUSTOMER = "33333333-3333-3333-3333-333333333333";   // ordinary signed-in customer
const IMPOSTOR = "44444444-4444-4444-4444-444444444444";   // same email as the admin but NEVER confirmed it
const OTHER = "55555555-5555-5555-5555-555555555555";      // another customer

const hours = (n) => `now() + interval '${n} hours'`;
const days = (n) => `now() + interval '${n} days'`;

before(async () => {
  cluster = await startCluster();
  db = await connect(cluster.port);
  await bootstrap(db); // runs every script twice: proves they are safe to re-run
  await db.query(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${ADMIN}',   'matty@example.com',    now()),
      ('${ADMIN2}',  'alfie@example.com',    now()),
      ('${CUSTOMER}','cust@example.com',     now()),
      ('${IMPOSTOR}','Matty@Example.com',    null),
      ('${OTHER}',   'other@example.com',    now());
    insert into public.admins (email, barber_name) values
      ('matty@example.com', 'Matty'),
      ('Alfie@Example.com', 'Alfie');`);
});
after(async () => {
  await db?.end();
  cluster?.stop();
});

// Each test runs inside a transaction that is rolled back, so tests never see each other's data.
beforeEach(() => db.query("begin"));
afterEach(() => db.query("rollback"));

// Act as one of the Supabase API roles. uid = null means a guest (not signed in).
async function as(role, uid = null) {
  await db.query("reset role");
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || ""]);
}
const asSuper = () => db.query("reset role");

// Run something that is expected to fail without poisoning the surrounding transaction.
async function fails(sql, params, code) {
  await db.query("savepoint s");
  try {
    await db.query(sql, params);
  } catch (e) {
    await db.query("rollback to savepoint s");
    if (code) assert.equal(e.code, code, `expected error ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  await db.query("rollback to savepoint s");
  assert.fail(`expected this to fail: ${sql}`);
}

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function seed() {
  await asSuper();
  await db.query(`
    insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, customer_email, user_id) values
      ('Matty', 'Cathy Customer', 'Haircut', ${days(2)}, '07700900001', 'confirmed', 'cust@example.com', '${CUSTOMER}'),
      ('Alfie', 'Guest Gary',     'Haircut', ${days(2)} + interval '1 hour', '07700900002', 'confirmed', 'gary@example.com', null),
      ('Matty', 'Cancelled Carl', 'Haircut', ${days(3)}, '07700900003', 'cancelled', 'carl@example.com', null),
      ('Matty', 'Olly Other',     'Haircut', ${days(4)}, '07700900004', 'confirmed', 'other@example.com', '${OTHER}'),
      ('Alfie', 'Old Olive',      'Haircut', now() - interval '3 days', '07700900005', 'confirmed', null, null)`);
}
const slot = (n = 5) => `date_trunc('minute', now()) + interval '${n} days'`;
const create = (o = {}) =>
  one(
    "select public.admin_create_booking($1, $2, $3::timestamptz, $4, $5, $6, $7::uuid) as r",
    [o.barber ?? "Matty", o.service ?? "Haircut", o.time, o.name ?? "Walk In Wendy", o.phone ?? "07700 900123", o.email ?? null, o.token ?? null]
  ).then((x) => x.r);
const timeAt = async (n = 5) => (await one(`select (${slot(n)})::text as t`)).t;

// ---------------------------------------------------------------- who is an admin
test("is_admin: listed + confirmed emails are admins (any letter case); everyone else is not", async () => {
  for (const [uid, expected] of [[ADMIN, true], [ADMIN2, true], [CUSTOMER, false], [OTHER, false], [IMPOSTOR, false]]) {
    await as("authenticated", uid);
    assert.equal((await one("select public.is_admin() as a")).a, expected, uid);
  }
});

test("an unconfirmed account that merely uses an admin's email is NOT an admin", async () => {
  await as("authenticated", IMPOSTOR);
  assert.equal((await one("select public.is_admin() as a")).a, false);
  assert.equal((await q("select * from public.admin_me()")).length, 0);
});

test("a signed-in user with no matching row, or a guest, is not an admin; guests cannot even ask", async () => {
  await as("authenticated", null); // authenticated role but no user id
  assert.equal((await one("select public.is_admin() as a")).a, false);
  await as("anon");
  await fails("select public.is_admin()", [], "42501");
  await fails("select * from public.admin_me()", [], "42501");
});

test("admin_me describes only the caller", async () => {
  await as("authenticated", ADMIN);
  assert.deepEqual(await q("select email, barber_name from public.admin_me()"), [{ email: "matty@example.com", barber_name: "Matty" }]);
  await as("authenticated", ADMIN2);
  assert.deepEqual(await q("select barber_name from public.admin_me()"), [{ barber_name: "Alfie" }]);
  await as("authenticated", CUSTOMER);
  assert.deepEqual(await q("select * from public.admin_me()"), []);
});

test("the admins table is invisible and untouchable from the website, even for admins and customers", async () => {
  for (const [role, uid] of [["anon", null], ["authenticated", CUSTOMER], ["authenticated", ADMIN]]) {
    await as(role, uid);
    await fails("select * from public.admins", [], "42501");
    await fails("insert into public.admins (email) values ('me@evil.example')", [], "42501");
    await fails("update public.admins set email = 'me@evil.example'", [], "42501");
    await fails("delete from public.admins", [], "42501");
  }
});

test("a customer cannot make themselves an admin by any route", async () => {
  await as("authenticated", CUSTOMER);
  await fails("insert into public.admins (email) values ('cust@example.com')", [], "42501");
  assert.equal((await one("select public.is_admin() as a")).a, false);
});

test("admins can be added in one line, with any letter case, and duplicates are refused", async () => {
  await asSuper();
  await db.query("insert into public.admins (email, barber_name) values ('NEW.Person@Example.com', 'Sam')");
  await fails("insert into public.admins (email) values ('new.person@example.com')", [], "23505");
  const row = await one("select created_at from public.admins where lower(email) = 'new.person@example.com'");
  assert.ok(row.created_at, "created_at is filled in");
});

test("removing an admin takes their access away at once", async () => {
  await asSuper();
  await db.query("delete from public.admins where email = 'matty@example.com'");
  await as("authenticated", ADMIN);
  assert.equal((await one("select public.is_admin() as a")).a, false);
  assert.equal((await q("select * from public.bookings")).length, 0);
});

// ---------------------------------------------------------------- who can read bookings
test("an admin reads every booking, including other people's, cancelled and past ones", async () => {
  await seed();
  await as("authenticated", ADMIN);
  const rows = await q("select customer_name, customer_phone, customer_email, status, cancel_token from public.bookings");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.cancel_token), "admins get the cancel token they need to cancel");
});

test("a second admin (Alfie) sees everything too: support for more than one admin", async () => {
  await seed();
  await as("authenticated", ADMIN2);
  assert.equal((await q("select 1 from public.bookings")).length, 5);
});

test("a normal signed-in customer reads ONLY their own booking, never anyone else's", async () => {
  await seed();
  await as("authenticated", CUSTOMER);
  const rows = await q("select customer_name from public.bookings");
  assert.deepEqual(rows, [{ customer_name: "Cathy Customer" }]);
});

test("an unconfirmed look-alike of an admin sees nothing", async () => {
  await seed();
  await as("authenticated", IMPOSTOR);
  assert.deepEqual(await q("select * from public.bookings"), []);
});

test("guests cannot read bookings at all, only the taken-slots view (no names, no phones)", async () => {
  await seed();
  await as("anon");
  await fails("select * from public.bookings", [], "42501");
  const slots = await q("select * from public.taken_slots");
  assert.equal(slots.length, 4); // cancelled one is not "taken"
  assert.deepEqual(Object.keys(slots[0]).sort(), ["appointment_time", "barber"]);
});

test("nobody can change or delete bookings directly: not guests, customers, or even admins", async () => {
  await seed();
  for (const [role, uid] of [["anon", null], ["authenticated", CUSTOMER], ["authenticated", ADMIN]]) {
    await as(role, uid);
    await fails("update public.bookings set status = 'cancelled'", [], "42501");
    await fails("delete from public.bookings", [], "42501");
  }
});

// ---------------------------------------------------------------- adding a booking by hand
test("only admins can add a booking: customers and guests are refused", async () => {
  const t = await timeAt();
  await as("authenticated", CUSTOMER);
  await fails("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,'X Y','07700900123')", [t], "42501");
  await as("authenticated", IMPOSTOR);
  await fails("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,'X Y','07700900123')", [t], "42501");
  await as("anon");
  await fails("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,'X Y','07700900123')", [t], "42501");
  await asSuper();
  assert.equal((await q("select 1 from public.bookings")).length, 0, "nothing was saved");
});

test("an admin adds a phone booking: saved as confirmed, with a manage token", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t, email: "wendy@example.com" }), "created");
  const row = await one("select * from public.bookings where customer_name = 'Walk In Wendy'");
  assert.equal(row.status, "confirmed");
  assert.equal(row.barber, "Matty");
  assert.equal(row.service, "Haircut");
  assert.equal(row.customer_phone, "07700 900123");
  assert.equal(row.customer_email, "wendy@example.com");
  assert.equal(row.user_id, null);
  assert.ok(row.cancel_token);
});

test("email is optional, and blank means none", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t, email: "   " }), "created");
  assert.equal((await one("select customer_email from public.bookings")).customer_email, null);
});

test("a manual booking sends the confirmation email through the existing trigger, when it has an email", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  await create({ time: t, email: "wendy@example.com" });
  await create({ time: await timeAt(6), name: "No Email Nigel" });
  await asSuper();
  const calls = await q("select body from net.calls order by id");
  assert.equal(calls.length, 2, "the trigger fires for each insert; the function itself skips rows with no email");
  assert.equal(calls[0].body.type, "INSERT");
  assert.equal(calls[0].body.record.customer_email, "wendy@example.com");
  assert.equal(calls[1].body.record.customer_email, null);
});

test("double booking: the same barber and time is refused, including different letter case", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t }), "created");
  assert.equal(await create({ time: t, name: "Second Sam" }), "taken");
  assert.equal(await create({ time: t, name: "Third Tom", barber: "matty" }), "taken");
  assert.equal((await q("select 1 from public.bookings")).length, 1);
});

test("a different barber at the same time is fine", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t }), "created");
  assert.equal(await create({ time: t, barber: "Alfie", name: "Alfie's Customer" }), "created");
});

test("a time a customer already booked online is 'taken' for the admin, and the reverse", async () => {
  const t = await timeAt();
  // customer books online first
  await as("anon");
  await db.query(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','Online Olga','Haircut',$1::timestamptz,'07700900999','confirmed')", [t]);
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t }), "taken");
  // admin books another time first; the online booking for it is then refused by the database
  const t2 = await timeAt(6);
  assert.equal(await create({ time: t2 }), "created");
  await as("anon");
  await fails(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status) values ('Matty','Late Larry','Haircut',$1::timestamptz,'07700900998','confirmed')", [t2], "23505");
});

test("a cancelled slot can be booked again by hand", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  await create({ time: t });
  const { cancel_token } = await one("select cancel_token from public.bookings");
  assert.equal((await one("select public.cancel_booking($1) as r", [cancel_token])).r, "cancelled");
  assert.equal(await create({ time: t, name: "Replacement Rita" }), "created");
});

test("past times are refused, and so are silly far-future ones", async () => {
  await as("authenticated", ADMIN);
  const past = (await one("select (now() - interval '1 hour')::text as t")).t;
  const yesterday = (await one("select (now() - interval '1 day')::text as t")).t;
  const far = (await one("select (now() + interval '3 years')::text as t")).t;
  assert.equal(await create({ time: past }), "past");
  assert.equal(await create({ time: yesterday }), "past");
  assert.equal(await create({ time: far }), "invalid_time");
  assert.equal(await create({ time: null }), "invalid_time");
  await asSuper();
  assert.equal((await q("select 1 from public.bookings")).length, 0);
});

test("bad details are refused with a clear code and nothing is saved", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t, name: "   " }), "invalid_name");
  assert.equal(await create({ time: t, name: "x".repeat(81) }), "invalid_name");
  assert.equal(await create({ time: t, phone: "123" }), "invalid_phone");
  assert.equal(await create({ time: t, phone: "1".repeat(31) }), "invalid_phone");
  assert.equal(await create({ time: t, email: "not-an-email" }), "invalid_email");
  assert.equal(await create({ time: t, email: "a b@c.com" }), "invalid_email");
  assert.equal(await create({ time: t, barber: "" }), "invalid_barber");
  assert.equal(await create({ time: t, service: "" }), "invalid_service");
  await asSuper();
  assert.equal((await q("select 1 from public.bookings")).length, 0);
});

test("details are trimmed before saving", async () => {
  const t = await timeAt();
  await as("authenticated", ADMIN);
  await create({ time: t, name: "  Spacey Stan  ", phone: "  07700900555 ", email: " s@example.com " });
  const row = await one("select customer_name, customer_phone, customer_email from public.bookings");
  assert.deepEqual(row, { customer_name: "Spacey Stan", customer_phone: "07700900555", customer_email: "s@example.com" });
});

test("sending the SAME request twice (slow connection, double tap) saves ONE booking and answers 'created' both times", async () => {
  const t = await timeAt();
  const token = "99999999-9999-4999-8999-999999999999";
  await as("authenticated", ADMIN);
  assert.equal(await create({ time: t, token }), "created");
  assert.equal(await create({ time: t, token }), "created");
  assert.equal((await q("select 1 from public.bookings")).length, 1);
  await asSuper();
  assert.equal((await q("select 1 from net.calls")).length, 1, "and only one confirmation email");
});

test("a repeat of a request whose booking was cancelled meanwhile is not reported as saved", async () => {
  const t = await timeAt();
  const token = "88888888-8888-4888-8888-888888888888";
  await as("authenticated", ADMIN);
  await create({ time: t, token });
  await db.query("select public.cancel_booking($1)", [token]);
  assert.notEqual(await create({ time: t, token }), "created");
});

test("two admins clicking the same slot at the same moment: exactly one wins (real concurrent connections)", async () => {
  await db.query("rollback"); // this test commits for real, then cleans up
  const t = (await one(`select (date_trunc('minute', now()) + interval '9 days')::text as t`)).t;
  const clients = await Promise.all([connect(cluster.port), connect(cluster.port), connect(cluster.port), connect(cluster.port)]);
  try {
    const results = await Promise.all(
      clients.map(async (c, i) => {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [i % 2 ? ADMIN : ADMIN2]);
        const r = (await c.query("select public.admin_create_booking('Matty','Haircut',$1::timestamptz,$2,'07700900123') as r", [t, `Racer ${i}`])).rows[0].r;
        await c.query("commit");
        return r;
      })
    );
    assert.equal(results.filter((r) => r === "created").length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r === "taken").length, 3, JSON.stringify(results));
    assert.equal((await q("select 1 from public.bookings where appointment_time = $1::timestamptz", [t])).length, 1);
  } finally {
    await db.query("delete from public.bookings where appointment_time = $1::timestamptz", [t]);
    await db.query("delete from net.calls");
    await Promise.all(clients.map((c) => c.end()));
    await db.query("begin"); // afterEach expects a transaction to roll back
  }
});

// ---------------------------------------------------------------- cancelling (existing flow, used by admin)
test("cancel: the slot is freed and the 'Booking cancelled' email is queued exactly as before", async () => {
  await seed();
  await as("authenticated", ADMIN);
  const target = await one("select cancel_token, appointment_time from public.bookings where customer_name = 'Guest Gary'");
  await asSuper();
  await db.query("delete from net.calls");
  await as("authenticated", ADMIN);
  assert.equal((await one("select public.cancel_booking($1) as r", [target.cancel_token])).r, "cancelled");

  await asSuper();
  assert.equal((await one("select status from public.bookings where cancel_token = $1", [target.cancel_token])).status, "cancelled");
  const calls = await q("select body from net.calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, "UPDATE");
  assert.equal(calls[0].body.record.status, "cancelled");
  assert.equal(calls[0].body.old_record.status, "confirmed");
  assert.equal(calls[0].body.record.customer_email, "gary@example.com");

  await as("anon");
  const taken = await q("select 1 from public.taken_slots where barber = 'Alfie' and appointment_time = $1", [target.appointment_time]);
  assert.equal(taken.length, 0, "slot is free again for customers");
});

test("cancelling twice is harmless, a past booking cannot be cancelled, and an unknown token is 'not_found'", async () => {
  await seed();
  await as("authenticated", ADMIN);
  const tok = (n) => one("select cancel_token from public.bookings where customer_name = $1", [n]).then((r) => r.cancel_token);
  const gary = await tok("Guest Gary");
  assert.equal((await one("select public.cancel_booking($1) as r", [gary])).r, "cancelled");
  assert.equal((await one("select public.cancel_booking($1) as r", [gary])).r, "already_cancelled");
  assert.equal((await one("select public.cancel_booking($1) as r", [await tok("Old Olive")])).r, "past");
  assert.equal((await one("select public.cancel_booking($1) as r", ["00000000-0000-4000-8000-000000000000"])).r, "not_found");
  await asSuper();
  assert.equal((await q("select 1 from net.calls where body->>'type' = 'UPDATE'")).length, 1, "only the first cancel sent an email");
});

// ---------------------------------------------------------------- nothing broke for customers
test("guest booking still works exactly as before, and a guest cannot attach it to a user", async () => {
  const t = await timeAt();
  await as("anon");
  await db.query(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, customer_email, cancel_token) values ('Alfie','Guest Gina','Haircut',$1::timestamptz,'07700900777','confirmed','gina@example.com', gen_random_uuid())", [t]);
  await fails(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, user_id) values ('Alfie','Sneaky','Haircut',$1::timestamptz,'07700900778','confirmed',$2)", [await timeAt(6), ADMIN], "42501");
});

test("a signed-in customer can still book for themselves but cannot book as an admin or someone else", async () => {
  await as("authenticated", CUSTOMER);
  await db.query(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, user_id) values ('Matty','Cathy','Haircut',$1::timestamptz,'07700900779','confirmed',$2)", [await timeAt(), CUSTOMER]);
  await fails(
    "insert into public.bookings (barber, customer_name, service, appointment_time, customer_phone, status, user_id) values ('Matty','Cathy','Haircut',$1::timestamptz,'07700900779','confirmed',$2)", [await timeAt(6), ADMIN], "42501");
});

test("function permissions: the admin functions are closed to guests and to PUBLIC", async () => {
  await asSuper();
  const priv = await q(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'execute') as anon_ok,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_ok
    from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('is_admin', 'admin_me', 'admin_create_booking') order by 1`);
  assert.equal(priv.length, 3);
  for (const p of priv) {
    assert.equal(p.anon_ok, false, `${p.proname} must not be callable by guests`);
    assert.equal(p.auth_ok, true, `${p.proname} is callable by signed-in users (it then checks is_admin itself)`);
  }
});

test("every admin function and policy pins its search_path (no hijacking via a rogue schema)", async () => {
  await asSuper();
  const rows = await q(`
    select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg
    from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('is_admin', 'admin_me', 'admin_create_booking')`);
  for (const r of rows) {
    assert.ok(r.prosecdef, `${r.proname} is SECURITY DEFINER`);
    assert.match(r.cfg, /search_path=/, `${r.proname} pins search_path`);
  }
});

test("admin.sql ends by reloading the API schema", async () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync(require("node:path").join(__dirname, "..", "supabase", "admin.sql"), "utf8").trim();
  assert.match(sql, /notify pgrst, 'reload schema';$/);
});
