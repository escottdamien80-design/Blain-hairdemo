"use strict";

// Blain Hair admin (part 2): the Week view, weekly working hours, and days off / extra hours.
// Loaded before admin.js, which calls AdminSchedule.init(ctx) once and hands over what it shares
// (the Supabase client, the safe-request helper, toasts, the signed-in admin).
//
// What may be saved is decided by the database (supabase/hours.sql): only admins can write, and nothing
// here ever cancels or changes a booking. Blocking time or changing hours that already have bookings
// shows a clear warning first and leaves those bookings exactly as they are.
(function () {
  const L = window.AdminLogic;
  const $ = (id) => document.getElementById(id);
  let ctx = null;

  // ---------------------------------------------------------------- shared schedule data
  // The two tables, for every barber (they're small). Admins can read them; nobody else can.
  const SC = { hours: [], exceptions: [], loaded: false, loadedAt: null };

  const BOOKING_COLUMNS = "barber, service, appointment_time, status, customer_name, customer_phone, customer_email, cancel_token";
  const hoursOf = (barber) => SC.hours.filter((h) => L.barberMatches(h.barber, barber));
  const exOf = (barber) => SC.exceptions.filter((x) => L.barberMatches(x.barber, barber));

  async function loadSchedule() {
    const today = L.todayStr();
    const [h, x] = await Promise.all([
      ctx.call(ctx.sb.from("barber_hours").select("*")),
      ctx.call(ctx.sb.from("barber_exceptions").select("*").gte("date_to", today)),
    ]);
    const error = h.error || x.error;
    if (error) return { error };
    SC.hours = h.data || [];
    SC.exceptions = x.data || [];
    SC.loaded = true;
    SC.loadedAt = new Date();
    return { ok: true };
  }

  const flagFor = (row) => (SC.loaded ? L.bookingFlag(row, SC.hours, SC.exceptions) : null);

  async function bookingsBetween(startIso, endIso) {
    return ctx.call(ctx.sb.from("bookings").select(BOOKING_COLUMNS).gte("appointment_time", startIso).lt("appointment_time", endIso).order("appointment_time", { ascending: true }));
  }

  // The tables/functions from supabase/hours.sql don't exist yet (it hasn't been run): say so plainly
  const notSetUp = (e) => Boolean(e) && (e.status === 404 || ["PGRST205", "PGRST202", "42P01", "42883"].includes(e.code));
  function failText(error, what) {
    if (notSetUp(error)) return "Working hours aren't set up yet. The owner needs to run supabase/hours.sql in Supabase (steps in supabase/HOURS_SETUP.md), then reload this page.";
    return error && error.timeout ? `Slow connection: ${what} didn't load.` : `Couldn't load ${what}. Check your connection.`;
  }

  // ---------------------------------------------------------------- tabs
  let tab = "day";
  const P = { barber: null }; // the barber shown in Week and Hours (chosen once, shared)

  function defaultBarber() {
    const me = ctx.me();
    const mine = me && me.barber_name && L.BARBERS.find((b) => b.toLowerCase() === me.barber_name.toLowerCase());
    return mine || L.BARBERS[0];
  }

  function showTab(name, { silent = false } = {}) {
    tab = name;
    for (const t of ["day", "week", "hours"]) {
      $(`pane-${t}`).hidden = t !== name;
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    }
    $("add-open").hidden = name === "hours"; // the one big button is for adding bookings; Hours has its own Save
    if (name === "week") openWeek();
    if (name === "hours") openHours();
    if (name === "day" && !silent) ctx.refreshDay();
  }

  function markTabDot() {
    $("tab-hours").dataset.dirty = String(hoursDirty());
  }

  function buildBarberChips(wrapId, onPick) {
    const wrap = $(wrapId);
    wrap.replaceChildren();
    L.BARBERS.forEach((b) => {
      const btn = ctx.el("button", "chip", b);
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.dataset.barber = b;
      btn.addEventListener("click", () => onPick(b));
      wrap.appendChild(btn);
    });
  }
  function markBarberChips(wrapId, barber) {
    document.querySelectorAll(`#${wrapId} .chip`).forEach((c) => c.setAttribute("aria-checked", String(c.dataset.barber === barber)));
  }

  // ================================================================ WEEK VIEW
  const W = { start: L.weekStart(L.todayStr()), rows: null, error: "", loading: false, seq: 0 };

  function openWeek() {
    if (!P.barber) P.barber = defaultBarber();
    buildBarberChips("week-barbers", pickBarber);
    loadWeek();
  }

  function pickBarber(b) {
    if (b === P.barber) return;
    if (tab === "hours" && hoursDirty()) return askDiscard(b);
    P.barber = b;
    if (tab === "week") { markBarberChips("week-barbers", b); renderWeek(); }
    if (tab === "hours") openHours();
  }

  async function loadWeek({ keep = false } = {}) {
    const seq = ++W.seq;
    const start = W.start;
    if (!keep) W.rows = null;
    W.loading = true;
    W.error = "";
    renderWeek();
    const range = { start: L.dayRange(start).start, end: L.dayRange(L.addDays(start, 6)).end };
    const [sched, bookings] = await Promise.all([loadSchedule(), bookingsBetween(range.start, range.end)]);
    if (seq !== W.seq) return;
    W.loading = false;
    const error = sched.error || bookings.error;
    if (error) {
      if (ctx.isAuthError(error)) return ctx.sessionExpired();
      console.error("Could not load the week:", error);
      W.error = failText(error, "the week");
    } else {
      W.rows = bookings.data || [];
      ctx.onScheduleLoaded();
    }
    renderWeek();
  }

  function goWeek(start) {
    W.start = start;
    loadWeek();
  }

  // The part of the day the bars cover: 09:00–18:00 at least, stretched to fit anything outside that
  function weekDomain(models) {
    let lo = 9 * 60, hi = 18 * 60;
    for (const m of models) {
      if (m.work) { lo = Math.min(lo, m.work.s); hi = Math.max(hi, m.work.e); }
      for (const x of m.extras) { lo = Math.min(lo, x.s); hi = Math.max(hi, x.e); }
      for (const b of m.bookings) { lo = Math.min(lo, b.at); hi = Math.max(hi, b.at + L.SLOT_MIN); }
    }
    lo = Math.floor(lo / 60) * 60;
    hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
    return { lo, hi };
  }

  function seg(cls, from, to, dom) {
    const d = el("span", `seg ${cls}`);
    const a = Math.max(from, dom.lo), b = Math.min(to, dom.hi);
    d.style.left = `${((a - dom.lo) / (dom.hi - dom.lo)) * 100}%`;
    d.style.width = `${Math.max(0, ((b - a) / (dom.hi - dom.lo)) * 100)}%`;
    return d;
  }

  const el = (tag, cls, content) => ctx.el(tag, cls, content);

  function renderWeek() {
    const today = L.todayStr();
    $("week-label").textContent = L.formatWeek(W.start);
    $("week-sub").textContent = W.start === L.weekStart(today) ? "This week" : "tap ‹ › to change week";
    $("week-today").hidden = W.start === L.weekStart(today);
    markBarberChips("week-barbers", P.barber);
    $("week-error").hidden = !W.error;
    $("week-error-text").textContent = W.error && W.rows ? `${W.error} Showing the earlier list.` : W.error;

    const list = $("week-list");
    list.replaceChildren();
    const summary = $("week-summary");
    if (W.rows === null) {
      summary.textContent = W.error ? "" : "Loading the week…";
      return;
    }

    const barber = P.barber;
    const mine = W.rows.filter((r) => L.barberMatches(r.barber, barber));
    const models = L.weekDates(W.start).map((d) => L.dayModel(d, hoursOf(barber), exOf(barber), mine));
    const dom = weekDomain(models);
    const total = models.reduce((n, m) => n + m.count, 0);
    const flagged = models.reduce((n, m) => n + m.bookings.filter((b) => b.flag).length, 0);
    summary.textContent = `${barber}: ${total} ${total === 1 ? "booking" : "bookings"} this week${flagged ? ` · ${flagged} need${flagged === 1 ? "s" : ""} a look` : ""}`;
    if (!SC.hours.some((h) => L.barberMatches(h.barber, barber))) {
      const li = el("li", "weekhint", `${barber} has no hours set yet, so customers see 09:00–18:00 every day. Set them in the Hours tab.`);
      list.appendChild(li);
    }
    models.forEach((m) => list.appendChild(weekRow(m, dom)));
  }

  function weekRow(m, dom) {
    const li = el("li", "wrow");
    const btn = el("button", "wday");
    btn.type = "button";
    btn.dataset.date = m.date;
    btn.dataset.state = m.today ? "today" : "";

    const head = el("div", "wday-head");
    head.appendChild(el("span", "wday-name", L.plainDay(m.date) + (m.today ? " · Today" : "")));
    head.appendChild(el("span", "wday-count", m.count ? `${m.count} ${m.count === 1 ? "booking" : "bookings"}` : "No bookings"));
    btn.appendChild(head);

    const hoursLine = el("p", "wday-hours" + (m.work || m.extras.length ? "" : " is-off"), L.hoursText(m));
    btn.appendChild(hoursLine);
    m.offs.forEach((o) => btn.appendChild(el("p", "wday-off", `${L.offText(o)}${o.note ? ` · ${o.note}` : ""}`)));

    const bar = el("div", "wbar");
    bar.setAttribute("aria-hidden", "true");
    if (m.work) bar.appendChild(seg("work", m.work.s, m.work.e, dom));
    if (m.work && m.brk) bar.appendChild(seg("break", m.brk.s, m.brk.e, dom));
    m.extras.forEach((x) => bar.appendChild(seg("extra", x.s, x.e, dom)));
    m.offs.forEach((o) => bar.appendChild(seg("off", o.allDay ? dom.lo : o.s, o.allDay ? dom.hi : o.e, dom)));
    m.bookings.filter((b) => !b.cancelled).forEach((b) => bar.appendChild(seg(`booking${b.flag ? " flagged" : ""}`, b.at, b.at + L.SLOT_MIN, dom)));
    btn.appendChild(bar);
    const axis = el("div", "waxis");
    axis.append(el("span", null, L.fromMin(dom.lo)), el("span", null, L.fromMin(dom.hi)));
    btn.appendChild(axis);

    const blocked = m.bookings.filter((b) => b.flag === "blocked").length;
    const outside = m.bookings.filter((b) => b.flag === "outside").length;
    if (blocked) btn.appendChild(el("p", "wday-flag", `${blocked} ${blocked === 1 ? "booking is" : "bookings are"} in blocked time`));
    if (outside) btn.appendChild(el("p", "wday-flag", `${outside} ${outside === 1 ? "booking is" : "bookings are"} outside working hours`));

    btn.setAttribute("aria-label", `${L.plainDay(m.date)}. ${L.hoursText(m)}. ${m.count} bookings. Open this day.`);
    btn.addEventListener("click", () => ctx.goToDay(m.date, P.barber));
    li.appendChild(btn);
    return li;
  }

  // ================================================================ HOURS TAB
  const H = { draft: null, saved: null, configured: false, loading: false, error: "", saving: false, pendingWarn: null, probs: [], seq: 0 };

  const hoursDirty = () => Boolean(H.draft && H.saved && !L.sameDays(H.draft, H.saved));

  async function openHours() {
    if (!P.barber) P.barber = defaultBarber();
    buildBarberChips("hours-barbers", pickBarber);
    markBarberChips("hours-barbers", P.barber);
    const seq = ++H.seq;
    H.loading = true;
    H.error = "";
    H.pendingWarn = null;
    H.probs = [];
    setHoursWarn(false);
    renderHours();
    const res = await loadSchedule();
    if (seq !== H.seq) return;
    H.loading = false;
    if (res.error) {
      if (ctx.isAuthError(res.error)) return ctx.sessionExpired();
      console.error("Could not load hours:", res.error);
      H.error = failText(res.error, "the hours");
      H.draft = null;
    } else {
      loadDraftFromSaved();
      ctx.onScheduleLoaded();
    }
    renderHours();
  }

  function loadDraftFromSaved() {
    const rows = hoursOf(P.barber);
    H.configured = rows.length > 0;
    H.saved = L.daysFromRows(rows);
    H.draft = L.daysFromRows(rows);
  }

  function renderHours() {
    markBarberChips("hours-barbers", P.barber);
    $("hours-error").hidden = !H.error;
    $("hours-error-text").textContent = H.error;
    $("hours-body").hidden = Boolean(H.error) || !H.draft;
    markTabDot();
    if (!H.draft) return;
    renderHoursStatus();
    renderHoursDays();
    renderExceptions();
    const other = L.BARBERS.find((b) => b !== P.barber);
    $("hours-copy").textContent = other ? `Copy ${other}'s hours` : "";
    $("hours-copy").hidden = !other;
    $("hours-save").disabled = H.saving;
    $("hours-save").textContent = H.saving ? "Saving…" : "Save hours";
  }

  function renderHoursStatus() {
    const s = $("hours-status");
    const dirty = hoursDirty();
    if (dirty) {
      s.textContent = "You have unsaved changes. Tap Save hours at the bottom.";
      s.dataset.kind = "warn";
    } else if (!H.configured) {
      s.textContent = `${P.barber} has no hours saved yet, so customers can book 09:00–18:00 every day. Change anything below, then tap Save hours.`;
      s.dataset.kind = "";
    } else {
      s.textContent = `${P.barber}'s hours are saved. Customers can only book inside them.`;
      s.dataset.kind = "ok";
    }
    markTabDot();
  }

  const timeOptionsFor = (value) => {
    const opts = L.timeOptions();
    return opts.includes(value) ? opts : [...opts, value].sort(); // keep an unusual saved value selectable
  };

  function timeSelect(label, value, onChange) {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", label);
    timeOptionsFor(value).forEach((t) => { const o = el("option", null, t); o.value = t; sel.appendChild(o); });
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  function renderHoursDays() {
    const ul = $("hours-days");
    const open = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".hday") : null;
    const keepFocus = open ? { wd: open.dataset.wd, label: document.activeElement.getAttribute("aria-label") || document.activeElement.className } : null;
    ul.replaceChildren();
    H.draft.forEach((d, i) => ul.appendChild(hourDay(d, i)));
    showProblems();
    if (keepFocus) {
      const row = ul.querySelector(`.hday[data-wd="${keepFocus.wd}"]`);
      const again = row && (row.querySelector(`[aria-label="${keepFocus.label}"]`) || row.querySelector("button"));
      if (again) again.focus({ preventScroll: true });
    }
  }

  function hourDay(d, i) {
    const li = el("li", "hday");
    li.dataset.wd = String(i + 1);
    li.dataset.working = String(d.working);

    const head = el("div", "hday-head");
    head.appendChild(el("span", "hday-name", L.DAY_NAMES[i]));
    const sw = el("button", "switch", d.working ? "Working" : "Day off");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(d.working));
    sw.setAttribute("aria-label", `${L.DAY_NAMES[i]}: ${d.working ? "working" : "day off"}. Tap to change.`);
    sw.addEventListener("click", () => { d.working = !d.working; onDraftChanged(true); });
    head.appendChild(sw);
    li.appendChild(head);

    if (d.working) {
      const body = el("div", "hday-body");
      const pair = el("div", "time-pair");
      pair.append(
        timeSelect(`${L.DAY_NAMES[i]} start`, d.start, (v) => { d.start = v; onDraftChanged(false); }),
        el("span", "to", "to"),
        timeSelect(`${L.DAY_NAMES[i]} end`, d.end, (v) => { d.end = v; onDraftChanged(false); })
      );
      body.appendChild(pair);

      if (d.breakOn) {
        const brk = el("div", "break-row");
        brk.appendChild(el("span", "break-label", "Break"));
        const bp = el("div", "time-pair");
        bp.append(
          timeSelect(`${L.DAY_NAMES[i]} break start`, d.bs, (v) => { d.bs = v; onDraftChanged(false); }),
          el("span", "to", "to"),
          timeSelect(`${L.DAY_NAMES[i]} break end`, d.be, (v) => { d.be = v; onDraftChanged(false); })
        );
        brk.appendChild(bp);
        const rm = el("button", "link-btn", "Remove break");
        rm.type = "button";
        rm.setAttribute("aria-label", `${L.DAY_NAMES[i]}: remove break`);
        rm.addEventListener("click", () => { d.breakOn = false; onDraftChanged(true); });
        brk.appendChild(rm);
        body.appendChild(brk);
      } else {
        const add = el("button", "link-btn", "+ Add a break (e.g. lunch)");
        add.type = "button";
        add.setAttribute("aria-label", `${L.DAY_NAMES[i]}: add a break`);
        add.addEventListener("click", () => { d.breakOn = true; onDraftChanged(true); });
        body.appendChild(add);
      }
      li.appendChild(body);
    }
    const prob = el("p", "msg msg-error hday-problem");
    prob.hidden = true;
    li.appendChild(prob);
    return li;
  }

  function showProblems() {
    document.querySelectorAll("#hours-days .hday").forEach((row) => {
      const p = H.probs.find((x) => x.index === Number(row.dataset.wd) - 1);
      const msg = row.querySelector(".hday-problem");
      msg.hidden = !p;
      msg.textContent = p ? p.message : "";
    });
  }

  function onDraftChanged(structural) {
    H.pendingWarn = null;
    setHoursWarn(false);
    $("hours-problem").hidden = true;
    H.probs = H.probs.length ? L.validateWeek(H.draft) : [];
    renderHoursStatus();
    if (structural) renderHoursDays();
    else showProblems();
  }

  function useMondayForWeekdays() {
    const m = H.draft[0];
    for (let i = 1; i <= 4; i++) H.draft[i] = { ...m };
    onDraftChanged(true);
    ctx.toast("ok", "Monday's hours copied to Tuesday–Friday. Tap Save hours to keep them.");
  }

  function copyFromOther() {
    const other = L.BARBERS.find((b) => b !== P.barber);
    const rows = hoursOf(other);
    if (!rows.length) return ctx.toast("error", `${other} has no hours saved yet, so there's nothing to copy.`);
    H.draft = L.daysFromRows(rows);
    onDraftChanged(true);
    ctx.toast("ok", `${other}'s hours copied. Tap Save hours to keep them for ${P.barber}.`);
  }

  function askDiscard(nextBarber) {
    const box = $("hours-warn");
    box.replaceChildren();
    box.appendChild(el("p", "confirm-q", `You have unsaved changes to ${P.barber}'s hours. Discard them and switch to ${nextBarber}?`));
    const yes = el("button", "btn btn-danger btn-block", "Discard changes");
    yes.type = "button";
    yes.addEventListener("click", () => { P.barber = nextBarber; openHours(); });
    const no = el("button", "btn btn-ghost btn-block", "Keep editing");
    no.type = "button";
    no.addEventListener("click", () => setHoursWarn(false));
    box.append(yes, no);
    setHoursWarn(true);
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---- saving the week
  const dateTime = (iso) => `${L.formatDay(L.dateOfInstant(iso), L.todayStr())} ${L.formatTime(iso)}`;

  function affectedList(rows, max = 6) {
    const wrap = el("ul", "affected");
    rows.slice(0, max).forEach((b) => wrap.appendChild(el("li", null, `${dateTime(b.appointment_time)} · ${b.customer_name || "(no name)"}${b.customer_phone ? ` · ${b.customer_phone}` : ""}`)));
    if (rows.length > max) wrap.appendChild(el("li", null, `…and ${rows.length - max} more`));
    return wrap;
  }

  async function saveHours({ force = false } = {}) {
    if (H.saving) return;
    $("hours-problem").hidden = true;
    const probs = L.validateWeek(H.draft);
    H.probs = probs;
    showProblems();
    if (probs.length) {
      const p = $("hours-problem");
      p.textContent = `Fix ${probs.length === 1 ? "the day" : "the days"} marked above first.`;
      p.hidden = false;
      const row = document.querySelector(`#hours-days .hday[data-wd="${probs[0].index + 1}"]`);
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!hoursDirty() && H.configured) {
      return ctx.toast("ok", `Nothing to change: ${P.barber}'s hours are already saved.`);
    }

    const barber = P.barber;
    H.saving = true;
    renderHoursSaveButton();

    // 1. Would any existing booking end up outside the new hours? Tell them first; never touch the booking.
    if (!force) {
      const check = await affectedByHours(barber);
      if (check.error) {
        H.saving = false;
        renderHoursSaveButton();
        if (ctx.isAuthError(check.error)) return ctx.sessionExpired();
        return showHoursProblem("Couldn't check your existing bookings (connection problem), so nothing was saved. Tap Save hours to try again.");
      }
      if (check.rows.length) {
        H.saving = false;
        renderHoursSaveButton();
        return warnHours(check.rows);
      }
    }
    H.pendingWarn = null;
    setHoursWarn(false);

    // 2. Save (replaces the whole week in one go; saving the same week again is harmless)
    const draftAtSave = JSON.stringify(L.daysToPayload(H.draft));
    const { data, error } = await ctx.call(ctx.sb.rpc("admin_set_hours", { p_barber: barber, p_days: L.daysToPayload(H.draft) }));
    H.saving = false;
    if (error) {
      if (ctx.isAuthError(error)) return ctx.sessionExpired();
      console.error("Saving hours failed:", error);
      if (error.code === "42501") return ctx.recheckAdmin();
      if (!ctx.isDefiniteRefusal(error)) {
        // not sure it arrived: look at what's saved
        const res = await loadSchedule();
        if (!res.error && JSON.stringify(L.daysToPayload(L.daysFromRows(hoursOf(barber)))) === draftAtSave && hoursOf(barber).length) return savedHours(barber);
        renderHoursSaveButton();
        return showHoursProblem("We couldn't tell if that saved (connection problem). Check your signal and tap Save hours again. It's safe to repeat.");
      }
      renderHoursSaveButton();
      return showHoursProblem("Sorry, that didn't save. Please try again.");
    }
    if (data !== "saved") {
      renderHoursSaveButton();
      return showHoursProblem(HOURS_TEXT[data] || "Sorry, that didn't save. Please try again.");
    }
    return savedHours(barber);
  }

  const HOURS_TEXT = {
    invalid_hours: "Those hours don't look right. Check each day's start and end time.",
    invalid_break: "A break must be inside the day's working hours. Check the break times.",
    invalid_days: "Something was missing from the week. Reload the page and try again.",
    invalid_barber: "Pick a barber first.",
  };

  async function savedHours(barber) {
    // Show "saved" straight away (no moment of "unsaved changes" after the confirmation), then re-read the real thing
    if (P.barber === barber && H.draft) {
      H.saved = H.draft.map((d) => ({ ...d }));
      H.configured = true;
      renderHoursStatus();
    }
    ctx.toast("ok", `${barber}'s hours saved. Customers can now only book inside them.`);
    await loadSchedule();
    if (P.barber === barber && !hoursDirty()) { loadDraftFromSaved(); renderHours(); }
    ctx.onScheduleLoaded();
  }

  // While a warning with its own choice is open, the normal Save button is hidden so there's only one clear way forward
  function setHoursWarn(visible) {
    $("hours-warn").hidden = !visible;
    $("hours-save").hidden = visible;
  }

  function renderHoursSaveButton() {
    $("hours-save").disabled = H.saving;
    $("hours-save").textContent = H.saving ? "Saving…" : "Save hours";
  }

  function showHoursProblem(message) {
    const p = $("hours-problem");
    p.textContent = message;
    p.hidden = false;
    p.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function affectedByHours(barber) {
    const now = new Date();
    const [sched, bookings] = await Promise.all([
      loadSchedule(),
      ctx.call(ctx.sb.from("bookings").select(BOOKING_COLUMNS).gte("appointment_time", now.toISOString())),
    ]);
    const error = sched.error || bookings.error;
    if (error) return { error };
    const mine = (bookings.data || []).filter((b) => L.barberMatches(b.barber, barber));
    const rows = L.newlyAffected(mine, {
      hoursNow: hoursOf(barber), exNow: exOf(barber),
      hoursNext: L.daysToRows(barber, H.draft), exNext: exOf(barber),
    }, now);
    return { rows };
  }

  function warnHours(rows) {
    const box = $("hours-warn");
    box.replaceChildren();
    const n = rows.length;
    const strong = el("strong", null, `${n} existing ${n === 1 ? "booking falls" : "bookings fall"} outside these hours.`);
    const q = el("p", "confirm-q");
    q.append(strong, " They will NOT be cancelled or changed. You'll need to contact those customers yourself if they can't be seen.");
    box.append(q, affectedList(rows));
    const yes = el("button", "btn btn-primary btn-block", "Save hours anyway");
    yes.type = "button";
    yes.addEventListener("click", () => saveHours({ force: true }));
    const no = el("button", "btn btn-ghost btn-block", "Keep editing");
    no.type = "button";
    no.addEventListener("click", () => setHoursWarn(false));
    box.append(yes, no);
    setHoursWarn(true);
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---- the list of days off / extra hours
  function renderExceptions() {
    const ul = $("exc-list");
    ul.replaceChildren();
    const today = L.todayStr();
    const rows = exOf(P.barber)
      .filter((x) => x.date_to >= today)
      .sort((a, b) => (a.date_from + (a.start_time || "")).localeCompare(b.date_from + (b.start_time || "")));
    if (!rows.length) {
      ul.appendChild(el("li", "empty", `No days off or extra hours coming up for ${P.barber}.`));
      return;
    }
    rows.forEach((x) => ul.appendChild(excRow(x, today)));
  }

  const excConfirm = { id: null, busy: false, error: "" };

  function excRow(x, today) {
    const li = el("li", "exc");
    li.dataset.id = x.id;
    li.dataset.kind = x.kind;
    li.appendChild(el("p", "exc-text", L.exceptionText(x, today)));
    if (x.note) li.appendChild(el("p", "exc-note", x.note));
    if (excConfirm.id !== x.id) {
      const rm = el("button", "btn btn-danger-ghost btn-block", x.kind === "extra" ? "Remove extra hours" : "Remove this block");
      rm.type = "button";
      rm.addEventListener("click", () => { excConfirm.id = x.id; excConfirm.error = ""; renderExceptions(); });
      li.appendChild(rm);
      return li;
    }
    const box = el("div", "confirm");
    box.setAttribute("role", "group");
    box.appendChild(el("p", "confirm-q", x.kind === "extra"
      ? "Are you sure? These extra hours will be removed."
      : "Are you sure? That time becomes bookable again. Bookings aren't affected."));
    if (excConfirm.error) { const e = el("p", "msg msg-error", excConfirm.error); e.setAttribute("role", "alert"); box.appendChild(e); }
    const yes = el("button", "btn btn-danger btn-block", excConfirm.busy ? "Removing…" : "Yes, remove it");
    yes.type = "button";
    yes.disabled = excConfirm.busy;
    yes.addEventListener("click", () => removeException(x));
    const no = el("button", "btn btn-ghost btn-block", "Keep it");
    no.type = "button";
    no.disabled = excConfirm.busy;
    no.addEventListener("click", () => { excConfirm.id = null; renderExceptions(); });
    box.append(yes, no);
    li.appendChild(box);
    return li;
  }

  async function removeException(x) {
    if (excConfirm.busy) return;
    excConfirm.busy = true;
    excConfirm.error = "";
    renderExceptions();
    const { data, error } = await ctx.call(ctx.sb.rpc("admin_remove_exception", { p_id: x.id }));
    excConfirm.busy = false;
    if (error) {
      if (ctx.isAuthError(error)) return ctx.sessionExpired();
      console.error("Removing failed:", error);
      excConfirm.error = "Couldn't confirm that (connection problem). Tap Yes again: it's safe to repeat.";
      renderExceptions();
      loadSchedule().then(() => { if (tab === "hours") renderExceptions(); });
      return;
    }
    excConfirm.id = null;
    ctx.toast("ok", data === "removed" ? `Removed. That time is bookable again.` : "That was already removed.");
    await loadSchedule();
    renderExceptions();
    ctx.onScheduleLoaded();
  }

  // ================================================================ DAYS OFF / EXTRA HOURS DIALOG
  const dlg = $("ex-dialog");
  const X = { kind: "off", barber: "", type: "days", from: "", to: "", start: "09:00", end: "10:00", token: "", saving: false, warn: null };

  function openEx(kind) {
    const today = L.todayStr();
    const viewing = ctx.dayShown();
    X.kind = kind;
    X.barber = P.barber || defaultBarber();
    X.type = kind === "extra" ? "range" : "days";
    X.from = viewing >= today ? viewing : today;
    X.to = X.from;
    X.start = kind === "extra" ? "10:00" : "09:00";
    X.end = kind === "extra" ? "13:00" : "10:00";
    X.token = ctx.newToken();
    X.saving = false;
    X.warn = null;
    $("ex-form").reset();
    $("ex-note").value = "";
    buildExDialog();
    $("ex-error").hidden = true;
    $("ex-warn").hidden = true;
    $("ex-actions").hidden = false;
    ctx.clearToast();
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  function closeEx() {
    X.saving = false;
    if (dlg.open) { if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open"); }
  }

  function buildExDialog() {
    $("ex-title").textContent = X.kind === "extra" ? "Open extra hours" : "Block time off";
    $("ex-type-field").hidden = X.kind === "extra";
    buildBarberChips("ex-barbers", (b) => { if (X.saving) return; X.barber = b; newExAttempt(); renderEx(); });
    const sel = (id, v) => {
      const s = $(id);
      s.replaceChildren();
      L.timeOptions().forEach((t) => { const o = el("option", null, t); o.value = t; s.appendChild(o); });
      s.value = v;
    };
    sel("ex-start", X.start);
    sel("ex-end", X.end);
    $("ex-from").min = L.todayStr();
    $("ex-to").min = L.todayStr();
    $("ex-from").value = X.from;
    $("ex-to").value = X.to;
    renderEx();
  }

  function renderEx() {
    markBarberChips("ex-barbers", X.barber);
    document.querySelectorAll("#ex-type .chip").forEach((c) => c.setAttribute("aria-checked", String(c.dataset.type === X.type)));
    const days = X.kind === "off" && X.type === "days";
    $("ex-to-field").hidden = !days;
    $("ex-times").hidden = days;
    $("ex-from-label").textContent = days ? "First day" : "Date";
    $("ex-save").textContent = X.saving ? "Saving…" : X.kind === "extra" ? "Save extra hours" : "Save block";
    $("ex-save").disabled = X.saving;
    $("ex-cancel").disabled = X.saving;
    $("ex-close").disabled = X.saving;
  }

  // changing anything makes it a different request (new id) and clears an open warning
  function newExAttempt() {
    X.token = ctx.newToken();
    X.warn = null;
    $("ex-warn").hidden = true;
    $("ex-actions").hidden = false;
    $("ex-error").hidden = true;
  }

  function exError(message) {
    const e = $("ex-error");
    e.textContent = message;
    e.hidden = false;
    e.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function readEx() {
    X.from = $("ex-from").value;
    X.to = $("ex-to").value || X.from;
    X.start = $("ex-start").value;
    X.end = $("ex-end").value;
    const days = X.kind === "off" && X.type === "days";
    return {
      id: X.token, barber: X.barber, kind: X.kind,
      date_from: X.from, date_to: days ? X.to : X.from,
      start_time: days ? null : X.start, end_time: days ? null : X.end,
      note: $("ex-note").value.trim(),
    };
  }

  function validateEx(r) {
    const today = L.todayStr();
    if (!L.isDateStr(r.date_from)) return "Pick a date.";
    if (!L.isDateStr(r.date_to)) return "Pick the last day.";
    if (r.date_from < today) return "That date has already passed. Pick today or later.";
    if (r.date_to < r.date_from) return "The last day can't be before the first day.";
    if ((Date.parse(r.date_to) - Date.parse(r.date_from)) / 864e5 > 62) return "That's more than 2 months. Block up to 63 days at a time.";
    if (r.date_from > L.addDays(today, 366)) return "That date is too far ahead.";
    if (r.start_time != null && L.toMin(r.end_time) <= L.toMin(r.start_time)) return "The end time must be after the start time.";
    return null;
  }

  async function submitEx(event, { force = false } = {}) {
    if (event) event.preventDefault();
    if (X.saving) return;
    $("ex-error").hidden = true;
    const r = readEx();
    const bad = validateEx(r);
    if (bad) return exError(bad);

    X.saving = true;
    renderEx();

    // Blocking time: do bookings already sit in it? Warn first, and never touch them.
    if (!force && r.kind === "off") {
      const check = await affectedByBlock(r);
      if (check.error) {
        X.saving = false;
        renderEx();
        if (ctx.isAuthError(check.error)) return ctx.sessionExpired();
        return exError("Couldn't check your existing bookings (connection problem), so nothing was saved. Tap Save block to try again.");
      }
      if (check.rows.length) {
        X.saving = false;
        renderEx();
        return warnBlock(check.rows, r);
      }
    }

    const { data, error } = await ctx.call(ctx.sb.rpc("admin_add_exception", {
      p_id: r.id, p_barber: r.barber, p_kind: r.kind, p_from: r.date_from, p_to: r.date_to,
      p_start: r.start_time, p_end: r.end_time, p_note: r.note || null,
    }));
    X.saving = false;
    if (error) {
      if (ctx.isAuthError(error)) { closeEx(); return ctx.sessionExpired(); }
      console.error("Saving the change failed:", error);
      if (error.code === "42501") { closeEx(); return ctx.recheckAdmin(); }
      if (!ctx.isDefiniteRefusal(error)) {
        const there = await ctx.call(ctx.sb.from("barber_exceptions").select("id").eq("id", r.id), Math.min(6000, ctx.timeoutMs()));
        if (!there.error && there.data && there.data.length) return doneEx(r, force);
        renderEx();
        return exError("We couldn't tell if that saved (connection problem). Check your signal and tap Save again. It's safe to repeat.");
      }
      renderEx();
      return exError("Sorry, that didn't save. Please try again.");
    }
    if (data === "created") return doneEx(r, force);
    renderEx();
    exError(EX_TEXT[data] || "Sorry, that didn't save. Please try again.");
  }

  const EX_TEXT = {
    invalid_date: "That date isn't allowed. Pick today or later, within the next year (up to 63 days at a time).",
    invalid_time: "Check the times: the end must be after the start.",
    invalid_note: "That note is too long (80 characters at most).",
    invalid_barber: "Pick a barber first.",
    invalid_kind: "Something went wrong. Reload the page and try again.",
    invalid_id: "Something went wrong. Reload the page and try again.",
  };

  async function affectedByBlock(r) {
    const range = { start: L.dayRange(r.date_from).start, end: L.dayRange(r.date_to).end };
    const [sched, bookings] = await Promise.all([loadSchedule(), bookingsBetween(range.start, range.end)]);
    const error = sched.error || bookings.error;
    if (error) return { error };
    const now = new Date();
    const mine = (bookings.data || []).filter((b) => L.barberMatches(b.barber, r.barber));
    const next = [...exOf(r.barber), { ...r, barber: r.barber }];
    const rows = L.newlyAffected(mine, { hoursNow: hoursOf(r.barber), exNow: exOf(r.barber), hoursNext: hoursOf(r.barber), exNext: next }, now);
    return { rows };
  }

  function warnBlock(rows, r) {
    X.warn = rows;
    const box = $("ex-warn");
    box.replaceChildren();
    const n = rows.length;
    const q = el("p", "confirm-q");
    q.append(el("strong", null, `${r.barber} already has ${n} ${n === 1 ? "booking" : "bookings"} in this time.`),
      " They will NOT be cancelled. If you block this time they stay booked, so you'll need to contact those customers yourself.");
    box.append(q, affectedList(rows));
    const yes = el("button", "btn btn-primary btn-block", "Block anyway, keep the bookings");
    yes.type = "button";
    yes.addEventListener("click", () => submitEx(null, { force: true }));
    const no = el("button", "btn btn-ghost btn-block", "Go back");
    no.type = "button";
    no.addEventListener("click", () => { box.hidden = true; $("ex-actions").hidden = false; X.warn = null; });
    box.append(yes, no);
    box.hidden = false;
    $("ex-actions").hidden = true;
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function doneEx(r, hadWarning) {
    closeEx();
    const when = r.date_from === r.date_to ? L.formatDay(r.date_from, L.todayStr()) : `${L.plainDay(r.date_from)} to ${L.plainDay(r.date_to)}`;
    const times = r.start_time ? ` ${r.start_time}–${r.end_time}` : "";
    let msg = r.kind === "extra"
      ? `Extra hours saved for ${r.barber}: ${when}${times}. Customers can book them now.`
      : `Blocked ${r.barber}: ${when}${times}. Customers can't book it now.`;
    if (r.kind === "off") msg += hadWarning && X.warn ? ` The ${X.warn.length} existing ${X.warn.length === 1 ? "booking was" : "bookings were"} not changed.` : " No existing bookings were changed.";
    ctx.toast("ok", msg);
    await loadSchedule();
    if (tab === "hours") renderExceptions();
    if (tab === "week") loadWeek({ keep: true });
    ctx.onScheduleLoaded();
  }

  // ================================================================ wiring
  function wire() {
    $("tab-day").addEventListener("click", () => showTab("day"));
    $("tab-week").addEventListener("click", () => showTab("week"));
    $("tab-hours").addEventListener("click", () => showTab("hours"));
    $("week-prev").addEventListener("click", () => goWeek(L.addDays(W.start, -7)));
    $("week-next").addEventListener("click", () => goWeek(L.addDays(W.start, 7)));
    $("week-today").addEventListener("click", () => goWeek(L.weekStart(L.todayStr())));
    $("week-error-retry").addEventListener("click", () => loadWeek({ keep: W.rows !== null }));
    $("hours-error-retry").addEventListener("click", openHours);
    $("hours-same").addEventListener("click", useMondayForWeekdays);
    $("hours-copy").addEventListener("click", copyFromOther);
    $("hours-save").addEventListener("click", () => saveHours());
    $("ex-open-off").addEventListener("click", () => openEx("off"));
    $("ex-open-extra").addEventListener("click", () => openEx("extra"));
    $("ex-form").addEventListener("submit", (e) => submitEx(e));
    $("ex-close").addEventListener("click", closeEx);
    $("ex-cancel").addEventListener("click", closeEx);
    dlg.addEventListener("cancel", (e) => { if (X.saving) e.preventDefault(); });
    document.querySelectorAll("#ex-type .chip").forEach((c) => c.addEventListener("click", () => { if (X.saving) return; X.type = c.dataset.type; newExAttempt(); renderEx(); }));
    for (const id of ["ex-from", "ex-to", "ex-start", "ex-end"]) $(id).addEventListener("change", () => { if (!X.saving) newExAttempt(); });
    // "Last day" follows "First day" so a one-day block is just one date, and it can never end before it starts
    $("ex-from").addEventListener("change", () => { if (!$("ex-to").value || $("ex-to").value < $("ex-from").value) $("ex-to").value = $("ex-from").value; });
    $("ex-start").addEventListener("change", () => { if ($("ex-end").value <= $("ex-start").value) $("ex-end").value = L.fromMin(Math.min(L.toMin($("ex-start").value) + 60, 22 * 60)); });
    window.addEventListener("beforeunload", (e) => { if (hoursDirty()) { e.preventDefault(); e.returnValue = ""; } });
  }

  // ================================================================ what admin.js uses
  window.AdminSchedule = {
    init(context) {
      ctx = context;
      wire();
    },
    // a fresh sign-in / sign-out: forget everything
    reset() {
      SC.hours = []; SC.exceptions = []; SC.loaded = false;
      W.rows = null; H.draft = null; H.saved = null; P.barber = null; tab = "day";
      closeEx();
    },
    start() { showTab("day", { silent: true }); loadSchedule().then(() => ctx.onScheduleLoaded()); },
    refresh() { return loadSchedule().then((r) => { if (!r.error) ctx.onScheduleLoaded(); return r; }); },
    refreshActive() {
      if (tab === "week") loadWeek({ keep: true });
      else if (tab === "hours" && !hoursDirty()) openHours();
    },
    flagFor,
    currentTab: () => tab,
    showTab,
    loaded: () => SC.loaded,
    closeDialogs: closeEx,
    isDirty: hoursDirty,
  };
})();
