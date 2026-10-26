"use strict";
// Shared setup for SQL tests: a throwaway Postgres with the real supabase/*.sql loaded, five test users,
// and helpers to act as a guest / signed-in customer / admin the way the Supabase API roles do.
const assert = require("node:assert/strict");
const { startCluster, connect, bootstrap } = require("./db");

const U = {
  ADMIN: "11111111-1111-1111-1111-111111111111",     // matty@example.com, in admins
  ADMIN2: "22222222-2222-2222-2222-222222222222",    // Alfie@Example.com, in admins
  CUSTOMER: "33333333-3333-3333-3333-333333333333",
  IMPOSTOR: "44444444-4444-4444-4444-444444444444",  // admin's email, never confirmed
  OTHER: "55555555-5555-5555-5555-555555555555",
};

async function setup() {
  const cluster = await startCluster();
  const db = await connect(cluster.port);
  await bootstrap(db);
  await db.query(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${U.ADMIN}', 'matty@example.com', now()), ('${U.ADMIN2}', 'alfie@example.com', now()),
      ('${U.CUSTOMER}', 'cust@example.com', now()), ('${U.IMPOSTOR}', 'Matty@Example.com', null),
      ('${U.OTHER}', 'other@example.com', now());
    insert into public.admins (email, barber_name) values ('matty@example.com', 'Matty'), ('Alfie@Example.com', 'Alfie');`);

  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const asSuper = () => db.query("reset role");
  async function as(role, uid = null) {
    await db.query("reset role");
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || ""]);
  }
  // something that must fail, without poisoning the surrounding transaction
  async function fails(sql, params, code) {
    await db.query("savepoint s");
    try {
      await db.query(sql, params);
    } catch (e) {
      await db.query("rollback to savepoint s");
      if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
      return e;
    }
    await db.query("rollback to savepoint s");
    assert.fail(`expected this to fail: ${sql}`);
  }
  return {
    db, cluster, q, one, as, asSuper, fails,
    begin: () => db.query("begin"),
    rollback: () => db.query("rollback"),
    close: async () => { await db.end(); cluster.stop(); },
  };
}

// A full week of hours as the admin_set_hours payload. days: { 1: ["09:00","18:00", ["12:00","13:00"]], 7: null (off) ... }
function week(days) {
  const out = [];
  for (let wd = 1; wd <= 7; wd++) {
    const d = days[wd];
    out.push(d
      ? { weekday: wd, working: true, start: d[0], end: d[1], break_start: d[2] ? d[2][0] : null, break_end: d[2] ? d[2][1] : null }
      : { weekday: wd, working: false, start: "09:00", end: "18:00", break_start: null, break_end: null });
  }
  return out;
}

module.exports = { setup, week, U };
