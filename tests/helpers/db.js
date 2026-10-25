"use strict";
// Starts a throwaway Postgres 16 and loads the REAL supabase/*.sql files into it, so the
// security tests exercise the actual policies and functions, not a copy.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/17/bin", "/usr/bin"]
  .find((d) => fs.existsSync(path.join(d, "initdb")));
const ROOT = path.resolve(__dirname, "..", "..");
const SQL_FILES = ["setup.sql", "cancellation.sql", "emails.sql", "auth.sql", "email_trigger.sql", "admin.sql"];

// postgres refuses to run as root, so drop to the "postgres" user when needed
const asPg = (cmd, args) => (process.getuid && process.getuid() === 0 ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args]);
function run(cmd, args, opts = {}) {
  const [c, a] = asPg(cmd, args);
  return execFileSync(c, a, { stdio: "pipe", ...opts }).toString();
}

async function startCluster() {
  if (!BIN) throw new Error("PostgreSQL binaries not found");
  const isRoot = process.getuid && process.getuid() === 0;
  // as root the "postgres" user must be able to reach the folder, so use /var/tmp rather than $TMPDIR
  const dir = fs.mkdtempSync(path.join(isRoot ? "/var/tmp" : os.tmpdir(), "blain-pg-"));
  if (isRoot) execFileSync("chown", ["postgres", dir]);
  const data = path.join(dir, "data");
  const port = 54000 + Math.floor(Math.random() * 900);
  run(path.join(BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  run(path.join(BIN, "pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, "-l", path.join(dir, "log"), "-w", "start"]);
  return {
    port,
    dir,
    stop() {
      try { run(path.join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const connect = async (port, database = "postgres") => {
  const c = new Client({ host: "127.0.0.1", port, user: "postgres", database });
  await c.connect();
  return c;
};

// Fill in the two EDIT lines of email_trigger.sql, exactly as the owner would
const fillTrigger = (sql) =>
  sql.replaceAll("YOUR-PROJECT-REF", "abcdefghijklmnop").replaceAll("PASTE-YOUR-WEBHOOK-SECRET-HERE", "0123456789abcdef0123456789abcdef");

async function bootstrap(client, { twice = true } = {}) {
  await client.query(fs.readFileSync(path.join(__dirname, "supabase-stub.sql"), "utf8"));
  for (const f of SQL_FILES) {
    const sql = fillTrigger(fs.readFileSync(path.join(ROOT, "supabase", f), "utf8"));
    await client.query(sql);
    if (twice) await client.query(sql); // every script must be safe to run again
  }
}

module.exports = { startCluster, connect, bootstrap, ROOT };
