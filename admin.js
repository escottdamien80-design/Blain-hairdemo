"use strict";

// Blain Hair admin (part 1): see every booking by day, cancel one, add one by hand.
//
// Who may do what is decided by the DATABASE (supabase/admin.sql), never by this page: an admin is an
// email listed in the `admins` table, and every read and write below is checked there. If someone
// opened this page without being an admin they would see "No admin access" and the database would
// refuse their requests anyway.
(function () {
  const L = window.AdminLogic;
  const $ = (id) => document.getElementById(id);

  // Same project as script.js (keep these two in step). The anon key is public by design.
  const SUPABASE_URL = "https://mddhykzuxrywhtmjwajy.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZGh5a3p1eHJ5d2h0bWp3YWp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MjAyMTQsImV4cCI6MjEwNzQ5NjIxNH0.kPm-ifCf1Pdg35czMDUPqEwqnMLKfKdZmAe88VgIqVI";

  const COLUMNS = "barber, service, appointment_time, status, customer_name, customer_phone, customer_email, cancel_token";
  const REFRESH_MS = 60000;
  const timeoutMs = () => window.ADMIN_TIMEOUT_MS || 15000; // tests shorten this

  // The same sign-in storage as the main site (storageKey "blain-auth"), so signing in there signs you in here.
  const supa = window.supabase;
  const sb = supa
    ? supa.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit", storageKey: "blain-auth" },
      })
    : null;

  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const LINK_ERROR = hash.get("error_code") || (hash.has("error") ? "error" : "");

  // ---------------------------------------------------------------- state
  const S = {
    user: null,        // signed-in user id
    me: null,          // { email, barber_name } once confirmed as an admin
    date: L.todayStr(),
    barber: "all",
    rows: null,        // the day's bookings (null = not loaded)
    loadedAt: null,
    seq: 0,            // newest load wins; older answers are ignored
    loading: false,
    listError: "",
    confirm: null,     // cancel token whose "Are you sure?" is open
    busy: null,        // cancel token being cancelled right now
    cardError: {},     // cancel token -> message
  };
  const A = { barber: "", service: L.SERVICES[0], date: "", time: null, token: "", slots: null, slotsLoading: false, slotsError: "", saving: false, seq: 0 };

  // ---------------------------------------------------------------- small helpers
  function newToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // Never throws: always { data, error }. A request that takes too long becomes { error: { timeout: true } }.
  async function call(request, ms = timeoutMs()) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ data: null, error: { timeout: true, message: "timeout" } }), ms);
    });
    try {
      return await Promise.race([Promise.resolve(request).then((r) => r, (e) => ({ data: null, error: { message: String(e) } })), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  const isAuthError = (e) => Boolean(e) && (e.status === 401 || e.code === "PGRST301" || /jwt/i.test(e.message || ""));
  const isDefiniteRefusal = (e) => Boolean(e) && !e.timeout && e.status >= 400 && e.status < 500;

  function show(el, on) { el.hidden = !on; }
  const text = (el, t) => { el.textContent = t; };

  function showView(name) {
    document.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.id !== `v-${name}`));
    show($("dock"), name === "app");
    show($("signout"), name === "app" || name === "denied");
    show($("who"), name === "app");
  }

  let toastTimer;
  function toast(kind, message) {
    clearTimeout(toastTimer);
    $("toast").dataset.kind = kind;
    text($("toast-text"), message);
    show($("toast"), true);
    if (kind === "ok") toastTimer = setTimeout(() => show($("toast"), false), 9000);
  }
  function clearToast() { clearTimeout(toastTimer); show($("toast"), false); }

  // ---------------------------------------------------------------- views: loading / sign-in / denied / error
  function showLoading(msg) {
    text($("loading-text"), msg || "Loading…");
    showView("loading");
  }

  function showSignin(message, kind) {
    showView("signin");
    setSigninMsg(message, kind);
  }
  function setSigninMsg(message, kind) {
    const m = $("signin-msg");
    text(m, message || "");
    m.dataset.kind = kind || "";
    show(m, Boolean(message));
  }

  function showDenied(email) {
    text($("denied-email"), email || "this account");
    showView("denied");
  }

  let retryAction = () => location.reload();
  function showError(message, retry) {
    text($("error-text"), message);
    retryAction = retry || (() => location.reload());
    showView("error");
  }

  function sessionExpired() {
    S.user = null; S.me = null;
    stopRefresh();
    closeAdd();
    showSignin("Your sign-in has expired. Please sign in again.", "error");
  }

  // ---------------------------------------------------------------- sign in / out
  async function sendLink(event) {
    event.preventDefault();
    const email = $("signin-email").value.trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setSigninMsg("Enter a valid email address.", "error");
    const btn = $("signin-submit");
    btn.disabled = true;
    btn.textContent = "Sending…";
    setSigninMsg("");
    let sent = false;
    // back to this page after the click (it must be allowed in Supabase → Redirect URLs; if not, Supabase
    // sends them to the main site instead, where the Admin link appears in the menu once signed in)
    const redirect = location.protocol.startsWith("http") ? location.origin + location.pathname : undefined;
    const { error } = await call(sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } }));
    if (error) {
      console.error("Sign-in email failed:", error);
      const limited = error.status === 429 || /rate limit/i.test(error.message || "");
      setSigninMsg(
        error.timeout
          ? "That's taking too long. Check your connection and try again."
          : limited
            ? "Too many sign-in emails were requested just now. Wait a few minutes and try again."
            : "Sorry, we couldn't send the sign-in link. Please try again.",
        "error"
      );
    } else {
      sent = true;
      setSigninMsg(`Check your inbox: we've sent a link to ${email}. It can take a minute (check spam). Open it on this phone.`, "ok");
    }
    btn.disabled = false;
    btn.textContent = sent ? "Send it again" : "Email me a sign-in link";
  }

  async function signOut() {
    stopRefresh();
    closeAdd();
    S.user = null; S.me = null; S.rows = null;
    await call(sb.auth.signOut(), 5000);
    showSignin();
  }

  // ---------------------------------------------------------------- is this person an admin?
  let checking = 0;
  async function verifyAdmin(session, { silent = false } = {}) {
    const n = ++checking;
    if (!silent) showLoading("Checking your access…");
    const { data, error } = await call(sb.rpc("admin_me"));
    if (n !== checking) return;
    if (error) {
      if (isAuthError(error)) return sessionExpired();
      console.error("Could not check admin access (has supabase/admin.sql been run?):", error);
      if (silent) return; // keep showing what we have
      return showError(
        error.timeout ? "That's taking too long. Check your connection and try again."
                      : "We couldn't check your access just now. Check your connection and try again.",
        () => verifyAdmin(session)
      );
    }
    const me = data && data[0];
    if (!me) {
      S.me = null;
      stopRefresh();
      closeAdd();
      return showDenied(session.user.email);
    }
    const first = !S.me;
    S.me = me;
    if (first) startApp();
  }

  function onSession(session) {
    if (!session) {
      S.user = null; S.me = null;
      stopRefresh();
      if (LINK_ERROR && !onSession.shownLinkError) {
        onSession.shownLinkError = true;
        history.replaceState(null, "", location.pathname + location.search);
        return showSignin("That sign-in link has expired or was already used. Enter your email to get a new one.", "error");
      }
      return showSignin();
    }
    if (S.user === session.user.id && (S.me || checking)) return; // token refresh etc.: nothing to redo
    S.user = session.user.id;
    verifyAdmin(session);
  }

  // ---------------------------------------------------------------- the bookings page
  function startApp() {
    S.date = L.todayStr();
    S.barber = "all";
    S.rows = null;
    S.confirm = null;
    S.cardError = {};
    text($("who"), S.me.barber_name ? `Hi ${S.me.barber_name}` : "Admin");
    showView("app");
    buildFilter();
    loadDay();
    startRefresh();
  }

  async function loadDay({ keep = false } = {}) {
    const seq = ++S.seq;
    const date = S.date;
    if (!keep) S.rows = null;
    S.loading = true;
    S.listError = "";
    render();
    const { start, end } = L.dayRange(date);
    const { data, error } = await call(
      sb.from("bookings").select(COLUMNS).gte("appointment_time", start).lt("appointment_time", end).order("appointment_time", { ascending: true })
    );
    if (seq !== S.seq) return; // they've moved on to another day; ignore this answer
    S.loading = false;
    if (error) {
      if (isAuthError(error)) return sessionExpired();
      console.error("Could not load bookings:", error);
      S.listError = error.timeout ? "Slow connection: the list didn't load." : "Couldn't load the bookings. Check your connection.";
    } else {
      S.rows = data || [];
      S.loadedAt = new Date();
    }
    render();
  }

  function goToDate(date) {
    if (!L.isDateStr(date) || date === S.date) return;
    S.date = date;
    S.confirm = null;
    loadDay();
  }

  // ---- rendering
  function buildFilter() {
    const wrap = $("barber-filter");
    wrap.replaceChildren();
    ["all", ...L.BARBERS].forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.barber = b;
      btn.textContent = b === "all" ? "All barbers" : b;
      btn.addEventListener("click", () => {
        S.barber = b;
        S.confirm = null;
        render();
      });
      wrap.appendChild(btn);
    });
  }

  function render() {
    const today = L.todayStr();
    text($("day-label"), L.formatDay(S.date, today));
    $("day-input").value = S.date;
    show($("today-btn"), S.date !== today);

    document.querySelectorAll("#barber-filter .chip").forEach((c) => {
      const on = c.dataset.barber === S.barber;
      c.setAttribute("aria-pressed", String(on));
    });

    const list = $("list");
    const rows = S.rows ? L.filterByBarber(S.rows, S.barber) : [];

    // banner: couldn't load / couldn't refresh
    show($("list-error"), Boolean(S.listError));
    text($("list-error-text"), S.rows && S.listError && S.loadedAt ? `${S.listError} Showing the list from ${L.formatTime(S.loadedAt.toISOString())}.` : S.listError);

    // summary line
    const summary = $("summary");
    if (S.rows === null) {
      text(summary, S.listError ? "" : "Loading bookings…");
    } else {
      const active = rows.filter((r) => r.status !== "cancelled").length;
      const cancelled = rows.length - active;
      let s = `${active} ${active === 1 ? "booking" : "bookings"}`;
      if (S.barber !== "all") s += ` for ${S.barber}`;
      if (cancelled) s += ` · ${cancelled} cancelled`;
      text(summary, s);
    }

    list.replaceChildren();
    if (S.rows === null) {
      // nothing to draw: the summary says "Loading…" or the banner explains the error
    } else if (!rows.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = S.barber === "all" ? "No bookings on this day." : `No bookings for ${S.barber} on this day.`;
      list.appendChild(li);
    } else {
      const now = new Date();
      rows.forEach((r) => list.appendChild(card(r, now)));
    }

    text($("updated"), S.loadedAt ? `Updated ${L.formatTime(S.loadedAt.toISOString())}` : "");
    $("refresh").disabled = S.loading;
    $("refresh").textContent = S.loading ? "Refreshing…" : "Refresh";
  }

  function el(tag, className, content) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = content;
    return n;
  }

  function card(r, now) {
    const state = L.bookingState(r, now);
    const li = el("li", "card");
    li.dataset.state = state;
    li.dataset.token = r.cancel_token || "";

    const top = el("div", "card-top");
    top.append(el("span", "time", L.formatTime(r.appointment_time)));
    const pill = el("span", "pill", state === "cancelled" ? "Cancelled" : state === "past" ? "Done" : "Confirmed");
    pill.dataset.state = state;
    top.appendChild(pill);
    li.appendChild(top);

    li.appendChild(el("p", "cust", r.customer_name || "(no name)"));
    li.appendChild(el("p", "meta", `${r.barber} · ${r.service || "Haircut"}`));

    const contact = el("div", "contact");
    const href = L.phoneHref(r.customer_phone);
    if (href) {
      const a = el("a", "callbtn", r.customer_phone);
      a.href = href;
      a.setAttribute("aria-label", `Call ${r.customer_name || "customer"} on ${r.customer_phone}`);
      contact.appendChild(a);
    } else {
      contact.appendChild(el("span", "muted", "No phone number"));
    }
    if (r.customer_email) {
      const m = el("a", "mailto", r.customer_email);
      m.href = `mailto:${r.customer_email}`;
      contact.appendChild(m);
    } else {
      contact.appendChild(el("span", "muted", "No email"));
    }
    li.appendChild(contact);

    if (state === "upcoming" && r.cancel_token) li.appendChild(cancelArea(r));
    return li;
  }

  function cancelArea(r) {
    const token = r.cancel_token;
    const wrap = el("div", "cancel-area");
    if (S.confirm !== token) {
      const b = el("button", "btn btn-danger-ghost btn-block", "Cancel booking");
      b.type = "button";
      b.addEventListener("click", () => {
        S.confirm = token;
        delete S.cardError[token];
        render();
        const yes = document.querySelector(`.card[data-token="${token}"] .btn-danger`);
        if (yes) yes.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      wrap.appendChild(b);
      return wrap;
    }

    const busy = S.busy === token;
    const box = el("div", "confirm");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Confirm cancellation");
    const q = el("p", "confirm-q");
    const strong = el("strong", null, "Are you sure?");
    const name = (r.customer_name || "this customer").split(" ")[0];
    q.append(strong, ` Cancel ${name}'s ${L.formatTime(r.appointment_time)} booking with ${r.barber}? The time will be free again. `,
      r.customer_email ? `${name} will be emailed.` : `There's no email on file, so let ${name} know yourself.`);
    box.appendChild(q);
    if (S.cardError[token]) {
      const e = el("p", "msg msg-error", S.cardError[token]);
      e.setAttribute("role", "alert");
      box.appendChild(e);
    }
    const yes = el("button", "btn btn-danger btn-block", busy ? "Cancelling…" : "Yes, cancel booking");
    yes.type = "button";
    yes.disabled = busy;
    yes.addEventListener("click", () => cancelBooking(r));
    const no = el("button", "btn btn-ghost btn-block", "Keep booking");
    no.type = "button";
    no.disabled = busy;
    no.addEventListener("click", () => {
      S.confirm = null;
      delete S.cardError[token];
      render();
    });
    box.append(yes, no);
    wrap.appendChild(box);
    return wrap;
  }

  // ---- cancelling: uses the same cancel_booking(token) the customers' "Manage my booking" link uses, so
  // the slot is freed and the "Booking cancelled" email goes out exactly as before.
  async function cancelBooking(r) {
    const token = r.cancel_token;
    if (S.busy) return;
    S.busy = token;
    delete S.cardError[token];
    render();
    const { data, error } = await call(sb.rpc("cancel_booking", { token }));
    S.busy = null;
    if (error) {
      if (isAuthError(error)) return sessionExpired();
      console.error("Cancel failed:", error);
      // Not sure whether it went through. Repeating is safe (a second cancel just says "already cancelled").
      S.cardError[token] = "Couldn't confirm the cancellation (connection problem). Tap Yes again: it's safe to repeat.";
      render();
      loadDay({ keep: true });
      return;
    }
    const info = L.CANCEL_TEXT[data];
    S.confirm = null;
    delete S.cardError[token];
    if (!info) {
      toast("error", "Something unexpected happened. The list has been refreshed. Check the booking before trying again.");
    } else if (info.ok) {
      const when = `${L.formatTime(r.appointment_time)} with ${r.barber}`;
      let msg = info.text(when);
      if (data === "cancelled") msg += r.customer_email ? ` ${(r.customer_name || "They").split(" ")[0]} has been emailed.` : " No email on file, so tell them yourself.";
      toast("ok", msg);
    } else {
      toast("error", info.text());
    }
    await loadDay({ keep: true });
  }

  // ---------------------------------------------------------------- adding a booking by hand
  const dialog = $("add-dialog");

  function openAdd() {
    const mine = S.me && S.me.barber_name && L.BARBERS.find((b) => b.toLowerCase() === S.me.barber_name.toLowerCase());
    A.barber = S.barber !== "all" ? S.barber : mine || L.BARBERS[0];
    A.service = L.SERVICES[0];
    const today = L.todayStr();
    A.date = S.date >= today ? S.date : today;
    A.time = null;
    A.token = newToken();
    A.slots = null;
    A.saving = false;
    $("add-form").reset();
    $("add-date").min = today;
    $("add-date").value = A.date;
    buildAddForm();
    text($("add-error"), "");
    show($("add-error"), false);
    clearToast();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    refreshSlots();
  }

  function closeAdd() {
    A.seq++;
    A.saving = false;
    if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }

  function buildAddForm() {
    const bw = $("add-barbers");
    bw.replaceChildren();
    L.BARBERS.forEach((b) => {
      const btn = el("button", "chip", b);
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.dataset.barber = b;
      btn.addEventListener("click", () => {
        if (A.saving || A.barber === b) return;
        A.barber = b;
        newAttempt();
        refreshSlots();
      });
      bw.appendChild(btn);
    });
    const sel = $("add-service");
    sel.replaceChildren(...L.SERVICES.map((s) => { const o = el("option", null, s); o.value = s; return o; }));
    renderAdd();
  }

  // A new slot choice = a new attempt (new token). The token is what makes a repeated Save safe.
  function newAttempt() {
    A.time = null;
    A.token = newToken();
    text($("add-error"), "");
    show($("add-error"), false);
  }

  function renderAdd() {
    document.querySelectorAll("#add-barbers .chip").forEach((c) => c.setAttribute("aria-checked", String(c.dataset.barber === A.barber)));
    const tw = $("add-times");
    tw.replaceChildren();
    const msg = $("times-msg");
    let note = "";
    if (A.slotsLoading || A.slots === null) {
      if (A.slotsError) {
        text(msg, A.slotsError);
        msg.dataset.kind = "error";
        const retry = el("button", "btn btn-ghost btn-small", "Try again");
        retry.type = "button";
        retry.addEventListener("click", refreshSlots);
        tw.appendChild(retry);
      } else {
        text(msg, "Checking free times…");
        msg.dataset.kind = "";
      }
      show(msg, true);
    } else if (!A.slots.length) {
      text(msg, A.date === L.todayStr() ? `No free times left today for ${A.barber}. Try another day.` : `No free times for ${A.barber} on this day. Try another day or barber.`);
      msg.dataset.kind = "";
      show(msg, true);
    } else {
      show(msg, false);
      note = `(${A.slots.length} free)`;
      A.slots.forEach((s) => {
        const b = el("button", "chip time-chip", s.time);
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(A.time === s.iso));
        b.dataset.time = s.time;
        b.addEventListener("click", () => {
          if (A.saving) return;
          A.time = s.iso;
          // a different time is a different attempt
          A.token = newToken();
          renderAdd();
        });
        tw.appendChild(b);
      });
    }
    text($("time-note"), note);
    const save = $("add-save");
    save.disabled = A.saving;
    save.textContent = A.saving ? "Saving…" : "Save booking";
    $("add-cancel").disabled = A.saving;
    $("add-close").disabled = A.saving;
  }

  async function refreshSlots() {
    const seq = ++A.seq;
    const { date, barber } = A;
    A.slots = null;
    A.slotsLoading = true;
    A.slotsError = "";
    renderAdd();
    if (!L.isDateStr(date)) { A.slotsLoading = false; A.slots = []; return renderAdd(); }
    const { start, end } = L.dayRange(date);
    const { data, error } = await call(
      sb.from("bookings").select("barber, appointment_time, status").gte("appointment_time", start).lt("appointment_time", end)
    );
    if (seq !== A.seq) return;
    A.slotsLoading = false;
    if (error) {
      if (isAuthError(error)) return sessionExpired();
      console.error("Could not check free times:", error);
      A.slotsError = error.timeout ? "Slow connection: couldn't check free times." : "Couldn't check free times. Check your connection.";
      return renderAdd();
    }
    A.slots = L.freeSlots({ date, barber, taken: data || [] });
    if (A.time && !A.slots.some((s) => s.iso === A.time)) A.time = null;
    renderAdd();
  }

  function setDate(date) {
    if (A.saving) return;
    const today = L.todayStr();
    if (!L.isDateStr(date)) return;
    if (date < today) {
      date = today;
      $("add-date").value = today;
    }
    if (date === A.date) return;
    A.date = date;
    newAttempt();
    refreshSlots();
  }

  function addError(message, focusId) {
    const e = $("add-error");
    text(e, message);
    show(e, true);
    e.scrollIntoView({ block: "center", behavior: "smooth" });
    if (focusId) $(focusId).focus({ preventScroll: true });
  }

  async function submitAdd(event) {
    event.preventDefault();
    if (A.saving) return;
    show($("add-error"), false);
    const name = $("add-name").value.trim();
    const phone = $("add-phone").value.trim();
    const email = $("add-email").value.trim();

    if (!A.time) return addError("Pick a time first.", "add-times");
    const bad = L.validateManual({ name, phone, email });
    if (bad) return addError(bad.message, `add-${bad.field}`);
    if (new Date(A.time).getTime() <= Date.now()) {
      newAttempt();
      refreshSlots();
      return addError(L.CREATE_TEXT.past);
    }

    A.saving = true;
    renderAdd();
    const attempt = { barber: A.barber, service: $("add-service").value, time: A.time, token: A.token, date: A.date, name, email };
    const { data, error } = await call(
      sb.rpc("admin_create_booking", {
        p_barber: attempt.barber, p_service: attempt.service, p_time: attempt.time,
        p_name: name, p_phone: phone, p_email: email || null, p_token: attempt.token,
      })
    );
    A.saving = false;

    if (error) {
      if (isAuthError(error)) return sessionExpired();
      console.error("Add booking failed:", error);
      if (error.code === "42501") { closeAdd(); S.me = null; return verifyAdmin({ user: { email: "" } }); }
      // We don't know if it was saved (slow or dropped connection). Ask the database, using this attempt's token.
      if (!isDefiniteRefusal(error)) {
        const saved = await wasSaved(attempt.token);
        if (saved) return done(attempt);
        renderAdd();
        return addError("We couldn't tell if that saved (connection problem). Check your signal and tap Save booking again. It won't double book.");
      }
      renderAdd();
      return addError("Sorry, that didn't save. Please try again.");
    }

    if (data === "created") return done(attempt);

    // a clear answer from the database
    const msg = L.CREATE_TEXT[data] || "Sorry, that didn't save. Please try again.";
    if (data === "taken" || data === "past" || data === "invalid_time") {
      newAttempt();
      refreshSlots(); // show what's really free now
    } else {
      renderAdd();
    }
    addError(msg, data === "invalid_name" ? "add-name" : data === "invalid_phone" ? "add-phone" : data === "invalid_email" ? "add-email" : null);
  }

  // Did a booking with this token get saved even though we never heard back?
  async function wasSaved(token) {
    const { data, error } = await call(sb.from("bookings").select("cancel_token, status").eq("cancel_token", token), Math.min(6000, timeoutMs()));
    return !error && Boolean(data && data.some((r) => r.status !== "cancelled"));
  }

  function done(a) {
    closeAdd();
    S.date = a.date;
    if (S.barber !== "all" && S.barber !== a.barber) S.barber = "all"; // so the new booking is visible
    S.confirm = null;
    let msg = `Booked: ${a.name} with ${a.barber}, ${L.formatDay(a.date)} at ${L.formatTime(a.time)}.`;
    msg += a.email ? ` A confirmation has been emailed to ${a.email}.` : "";
    toast("ok", msg);
    loadDay();
  }

  // ---------------------------------------------------------------- keeping the list fresh
  let refreshTimer = null;
  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (document.visibilityState !== "visible" || !S.me || S.busy || dialog.open || S.loading) return;
      loadDay({ keep: true });
    }, REFRESH_MS);
  }
  function stopRefresh() { clearInterval(refreshTimer); refreshTimer = null; }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !S.me) return;
    loadDay({ keep: true });                       // coming back to the app: show the latest
    sb.auth.getSession().then(({ data }) => { if (data.session) verifyAdmin(data.session, { silent: true }); });
  });
  window.addEventListener("online", () => { if (S.me && S.listError) loadDay({ keep: true }); });

  // ---------------------------------------------------------------- wiring
  $("signin-form").addEventListener("submit", sendLink);
  $("signout").addEventListener("click", signOut);
  $("denied-signout").addEventListener("click", signOut);
  $("error-retry").addEventListener("click", () => retryAction());
  $("prev").addEventListener("click", () => goToDate(L.addDays(S.date, -1)));
  $("next").addEventListener("click", () => goToDate(L.addDays(S.date, 1)));
  $("today-btn").addEventListener("click", () => goToDate(L.todayStr()));
  $("day-input").addEventListener("change", (e) => goToDate(e.target.value));
  $("refresh").addEventListener("click", () => loadDay({ keep: true }));
  $("list-error-retry").addEventListener("click", () => loadDay({ keep: S.rows !== null }));
  $("toast-close").addEventListener("click", clearToast);

  $("add-open").addEventListener("click", openAdd);
  $("add-form").addEventListener("submit", submitAdd);
  $("add-close").addEventListener("click", closeAdd);
  $("add-cancel").addEventListener("click", closeAdd);
  $("add-date").addEventListener("change", (e) => setDate(e.target.value));
  $("add-today").addEventListener("click", () => { $("add-date").value = L.todayStr(); setDate(L.todayStr()); });
  $("add-tomorrow").addEventListener("click", () => { const d = L.addDays(L.todayStr(), 1); $("add-date").value = d; setDate(d); });
  dialog.addEventListener("cancel", (e) => { if (A.saving) e.preventDefault(); }); // Esc while saving: stay put

  // ---------------------------------------------------------------- start
  function start() {
    if (!sb) {
      return showError("The booking service didn't load. Check your connection and try again.");
    }
    showLoading(location.hash.includes("access_token") ? "Signing you in…" : "Loading…");
    sb.auth.onAuthStateChange((event, session) => {
      setTimeout(() => onSession(session), 0); // never call Supabase from inside this callback
    });
    sb.auth.getSession().then(({ data }) => onSession(data.session), () => showSignin());
  }
  start();
})();
