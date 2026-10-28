"use strict";
// Serves the site folder and opens pages in a real browser (Chromium via Playwright) wired to the
// FakeSupabase backend, with the real supabase-js library and a fixed clock.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { FakeSupabase, SUPABASE_HOST } = require("./fake-supabase");

const ROOT = path.resolve(__dirname, "..", "..");
const SUPABASE_JS = path.join(ROOT, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp" };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || file.includes("node_modules") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// A fixed moment for every test: Sun 25 Oct 2026, 13:10 UK time. That is the day the clocks go back
// (BST -> GMT at 02:00), so the day is 25 hours long: a good edge case to run everything on.
const NOW = Date.parse("2026-10-25T13:10:00Z");

// Handy: an ISO time for a UK wall-clock time on a given day (winter/summer aware, via the app's own helper)
const AdminLogic = require("../../admin-logic.js");
const at = (date, time) => AdminLogic.londonToUtc(date, time).toISOString();

async function launch() {
  const [{ server, url }, browser] = await Promise.all([serve(), chromium.launch()]);
  return { server, url, browser, close: async () => { await browser.close(); server.close(); } };
}

// signedInAs: a user object from backend.users, or null for a signed-out visitor
async function openPage(env, backend, { path: pagePath = "/admin.html", signedInAs = null, viewport = { width: 390, height: 844 }, timeoutMs = 1500, isMobile = viewport.width < 700, now = NOW, timezoneId = "Europe/London" } = {}) {
  const context = await env.browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: 2, locale: "en-GB", timezoneId });
  await context.route(`https://${SUPABASE_HOST}/**`, (route) => backend.handle(route));
  await context.route("https://cdn.jsdelivr.net/**/supabase.js", (route) => route.fulfill({ path: SUPABASE_JS, contentType: "text/javascript" }));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.clock.setFixedTime(now);
  await page.addInitScript(({ timeoutMs, session }) => {
    window.ADMIN_TIMEOUT_MS = timeoutMs;
    try {
      if (session && !localStorage.getItem("e2e-seeded")) {
        localStorage.setItem("blain-auth", JSON.stringify(session));
        localStorage.setItem("e2e-seeded", "1");
      }
    } catch {}
  }, { timeoutMs, session: signedInAs ? backend.session(signedInAs) : null });
  await page.goto(env.url + pagePath);
  return page;
}

module.exports = { launch, openPage, FakeSupabase, NOW, at };
