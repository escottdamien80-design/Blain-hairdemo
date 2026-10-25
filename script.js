"use strict";

// ================================================================================
// GOOGLE REVIEWS BAR: the cards that scroll across the site
//
// ⚠️  PLACEHOLDER REVIEWS: every name and quote below is MADE UP for design purposes.
//     They are NOT real Google reviews. Replace them with real ones before launch.
//
// To swap in real reviews, edit this one array (keep it to roughly 6 to 8 entries):
//   name: first name + last initial, e.g. "Harry F."
//   text: the quote. Keep it short (about 2 lines); longer text is cut off with "…".
// ================================================================================
const REVIEWS = [
  { name: "Jake M.",   text: "Best fade I've had in years. Sharp, clean and out the door on time." },
  { name: "Tom R.",    text: "Really friendly shop and a proper attention to detail. Booked again before I left." },
  { name: "Ollie P.",  text: "Easy to book online and the cut was spot on. Highly recommend." },
  { name: "Sam W.",    text: "Great beard trim, great chat. Wouldn't go anywhere else now." },
  { name: "Daniel K.", text: "Spotless shop, relaxed atmosphere and a brilliant skin fade." },
  { name: "Ryan B.",   text: "Took my son for his first proper cut and he loved it. Patient and professional." },
  { name: "Liam H.",   text: "Consistent every time. Always leave looking sharp." },
  { name: "Josh T.",   text: "Quick, clean and worth every penny. Five stars from me." },
];
// ================================================================================

// ---- Supabase config --------------------------------------------------------
// Paste your Project URL and anon public key (Supabase → Project Settings → API).
// Leave both empty to run in demo mode (bookings are kept in memory only).
// The anon key is meant to be public; access is controlled by the row-level
// security policies in supabase/setup.sql.
const SUPABASE_URL = "https://mddhykzuxrywhtmjwajy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZGh5a3p1eHJ5d2h0bWp3YWp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MjAyMTQsImV4cCI6MjEwNzQ5NjIxNH0.kPm-ifCf1Pdg35czMDUPqEwqnMLKfKdZmAe88VgIqVI";
const SERVICE = "Haircut"; // saved in the `service` column

const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Did the visitor just arrive from a sign-in email link? Read this BEFORE the clients start up,
// because the sign-in client removes the token from the address bar.
const authHash = new URLSearchParams(location.hash.replace(/^#/, ""));
const AUTH_RETURNING = authHash.has("access_token");
const AUTH_LINK_ERROR = authHash.get("error_code") || (authHash.has("error") ? "error" : "");

// Two clients, on purpose:
//  • sb      = the GUEST client (role "anon", never signed in). Availability, booking as a guest and
//              the token-based look-up / cancel all use it, so they behave exactly the same whether
//              or not the customer has signed in.
//  • sbAuth  = the sign-in client (remembers the session). Used only to sign in and out, to read
//              "My bookings", and to link a booking to the signed-in customer.
const supa = configured && window.supabase ? window.supabase : null;
const sb = supa
  ? supa.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "blain-guest" },
    })
  : null;
const sbAuth = supa
  ? supa.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit", storageKey: "blain-auth" },
    })
  : null;
const live = Boolean(sb);

// ---- Shop schedule ------------------------------------------------------------
// Each slot: day offset from today, 24h time, price in £.
// `booked` only matters in demo mode; with Supabase it comes from the database.
const BARBERS = [
  {
    id: "matty",
    name: "Matty",
    role: "Barber",
    slots: [
      { day: 0, time: "10:00", price: 28, booked: true },
      { day: 0, time: "11:00", price: 28, booked: true },
      { day: 0, time: "15:30", price: 28, booked: false },
      { day: 0, time: "17:00", price: 32, booked: false },
      { day: 1, time: "09:30", price: 28, booked: true },
      { day: 1, time: "11:00", price: 28, booked: false },
      { day: 1, time: "13:30", price: 28, booked: false },
      { day: 1, time: "16:00", price: 32, booked: false },
      { day: 2, time: "10:00", price: 28, booked: false },
      { day: 2, time: "12:00", price: 28, booked: false },
      { day: 2, time: "14:30", price: 28, booked: true },
      { day: 2, time: "17:30", price: 32, booked: false },
    ],
  },
  {
    id: "alfie",
    name: "Alfie",
    role: "Barber",
    slots: [
      { day: 0, time: "09:00", price: 25, booked: true },
      { day: 0, time: "12:30", price: 25, booked: false },
      { day: 0, time: "16:00", price: 30, booked: false },
      { day: 1, time: "10:00", price: 25, booked: true },
      { day: 1, time: "12:00", price: 25, booked: true },
      { day: 1, time: "15:00", price: 25, booked: false },
      { day: 1, time: "18:00", price: 30, booked: false },
      { day: 2, time: "09:30", price: 25, booked: false },
      { day: 2, time: "11:30", price: 25, booked: false },
      { day: 2, time: "13:00", price: 25, booked: true },
      { day: 2, time: "16:30", price: 30, booked: false },
    ],
  },
];

// ---- Helpers ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function slotDate(slot) {
  const d = new Date();
  d.setDate(d.getDate() + slot.day);
  const [h, m] = slot.time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

function isAvailable(slot) {
  return !slot.booked && slotDate(slot) > new Date();
}

function dayLabel(offset) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return slotDate({ day: offset, time: "00:00" }).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "short",
  });
}

function fullDayLabel(slot) {
  const d = slotDate(slot);
  const date = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return `${date} at ${slot.time}`;
}

// ---- State & rendering -------------------------------------------------------
let selected = null; // chosen barber
let pending = null;  // { slot, el } while the customer is filling in their details

// Live mode: forget the dummy "booked" flags; the database is the source of truth
if (live) BARBERS.forEach((b) => b.slots.forEach((s) => (s.booked = false)));

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showNotice(msg) {
  const n = $("notice");
  n.textContent = msg;
  n.hidden = false;
}
function hideNotice() { $("notice").hidden = true; }

// ---- Availability from Supabase ---------------------------------------------
// Reads the `taken_slots` view (barber + appointment_time only) so customer
// names and phone numbers are never exposed to the browser.
async function refreshTaken() {
  if (!live) return true;
  const { data, error } = await sb
    .from("taken_slots")
    .select("barber, appointment_time")
    .gte("appointment_time", new Date().toISOString());
  if (error) {
    console.error("Could not load bookings:", error);
    showNotice("Couldn't check live availability. A slot that's already taken will be rejected when you confirm.");
    return false;
  }
  hideNotice();
  const taken = new Set(
    data.map((r) => `${String(r.barber).toLowerCase()}|${new Date(r.appointment_time).getTime()}`)
  );
  BARBERS.forEach((b) =>
    b.slots.forEach((s) => {
      s.booked = taken.has(`${b.name.toLowerCase()}|${slotDate(s).getTime()}`);
    })
  );
  return true;
}

function renderBarbers() {
  const wrap = $("barbers");
  BARBERS.forEach((b, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "barber reveal";
    btn.style.setProperty("--d", `${0.25 + i * 0.12}s`);
    btn.id = `barber-${b.id}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.innerHTML =
      `<span class="avatar">${b.name[0]}</span>` +
      `<span class="barber-name">${b.name}</span>` +
      `<span class="barber-role">${b.role}</span>`;
    btn.addEventListener("click", () => selectBarber(b));
    wrap.appendChild(btn);
    observe(btn);
  });
}

async function selectBarber(barber) {
  selected = barber;
  clearPending();
  document.querySelectorAll(".barber").forEach((el) =>
    el.setAttribute("aria-checked", String(el.id === `barber-${barber.id}`))
  );
  $("confirmation").hidden = true;

  const step = $("slots-step");
  const wasHidden = step.hidden;
  step.hidden = false;
  if (live) $("slots").innerHTML = '<p class="loading">Checking availability…</p>';
  if (wasHidden) step.scrollIntoView({ behavior: "smooth", block: "start" });

  await refreshTaken();
  if (selected === barber) renderSlots(); // ignore if they switched barber meanwhile
}

function renderSlots() {
  const container = $("slots");
  container.innerHTML = "";

  const days = [...new Set(selected.slots.map((s) => s.day))].sort((a, b) => a - b);
  days.forEach((day) => {
    const section = document.createElement("div");
    section.className = "day";
    const title = document.createElement("h4");
    title.className = "day-title";
    title.textContent = dayLabel(day);
    const list = document.createElement("div");
    list.className = "slot-list";

    selected.slots
      .filter((s) => s.day === day)
      .sort((a, b) => a.time.localeCompare(b.time))
      .forEach((slot, i) => list.appendChild(slotEl(slot, i)));

    section.append(title, list);
    container.appendChild(section);
  });

  $("next-available").disabled = !nextAvailable(selected);
}

function slotEl(slot, i = 0) {
  const free = isAvailable(slot);
  const el = document.createElement("div");
  el.className = "slot" + (free ? "" : " taken");
  el.style.setProperty("--i", Math.min(i, 10));
  el.dataset.day = slot.day;
  el.dataset.time = slot.time;
  el.innerHTML =
    `<span class="slot-time">${slot.time}</span>` +
    `<span class="slot-price">£${slot.price}</span>`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slot-btn";
  btn.textContent = free ? "Book" : "Unavailable";
  btn.disabled = !free;
  btn.addEventListener("click", () => selectSlot(slot, el));
  el.appendChild(btn);

  if (pending && pending.slot === slot && free) markSelected(el);
  return el;
}

function nextAvailable(barber) {
  return barber.slots
    .filter(isAvailable)
    .sort((a, b) => slotDate(a) - slotDate(b))[0];
}

function jumpToNext() {
  if (!selected) return;
  const slot = nextAvailable(selected);
  if (!slot) return;
  const el = document.querySelector(
    `.slot[data-day="${slot.day}"][data-time="${slot.time}"]`
  );
  if (!el) return;
  document.querySelectorAll(".slot.highlight").forEach((n) => n.classList.remove("highlight"));
  el.classList.add("highlight");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.querySelector(".slot-btn").focus({ preventScroll: true });
}

// ---- Choosing a slot and booking it -------------------------------------------
function markSelected(el) {
  el.classList.add("selected");
  el.querySelector(".slot-btn").textContent = "Selected ✓";
}

function selectSlot(slot, el) {
  document.querySelectorAll(".slot.highlight").forEach((n) => n.classList.remove("highlight"));
  document.querySelectorAll(".slot.selected").forEach((n) => {
    n.classList.remove("selected");
    n.querySelector(".slot-btn").textContent = "Book";
  });
  pending = { slot, el };
  markSelected(el);
  $("confirmation").hidden = true;
  showDetails(slot);
}

function showDetails(slot) {
  $("details-summary").textContent =
    `${selected.name} · ${fullDayLabel(slot)} · £${slot.price}`;
  $("form-error").hidden = true;
  prefillFromAccount();
  const step = $("details-step");
  step.hidden = false;
  step.style.animation = "none"; void step.offsetWidth; step.style.animation = "";
  step.scrollIntoView({ behavior: "smooth", block: "center" });
  $("customer-name").focus({ preventScroll: true });
}

function clearPending() {
  pending = null;
  $("details-step").hidden = true;
  $("details-form").reset();
  document.querySelectorAll(".slot.selected").forEach((n) => {
    n.classList.remove("selected");
    n.querySelector(".slot-btn").textContent = "Book";
  });
}

function formError(msg) {
  const e = $("form-error");
  e.textContent = msg;
  e.hidden = false;
}

async function submitBooking(event) {
  event.preventDefault();
  if (!pending) return;
  const name = $("customer-name").value.trim();
  const phone = $("customer-phone").value.trim();
  const email = $("customer-email").value.trim();

  if (name.length < 2) return formError("Please enter your name.");
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) return formError("Please enter a valid phone number.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return formError("Please enter a valid email address.");
  }
  if (configured && !live) return formError("Booking is unavailable right now. Please try again later.");

  const { slot } = pending;
  const submit = $("confirm-booking");
  submit.disabled = true;
  submit.textContent = "Saving…";
  $("form-error").hidden = true;

  try {
    // The token is generated here (the site can't read rows back, by design) and
    // sent with the insert. It is a random UUID and becomes the cancel link.
    let token = newToken();
    let emailSaved = true;
    if (live) {
      const row = {
        barber: selected.name,
        customer_name: name,
        service: SERVICE,
        appointment_time: slotDate(slot).toISOString(),
        customer_phone: phone,
        customer_email: email,
        status: "confirmed",
        cancel_token: token,
      };
      // Signed in: book through the signed-in client so the booking is linked to the customer.
      // Anything else (guests, or a signed-in booking the database refuses) uses the guest client.
      let client = sb;
      if (authSession && sbAuth) {
        row.user_id = authSession.user.id;
        client = sbAuth;
      }
      let error, status;
      // Up to a few tries: each one can drop ONE thing that isn't available yet, so the booking
      // is always saved (and the console says what to run in Supabase).
      for (let attempt = 0; attempt < 5; attempt++) {
        ({ error, status } = await client.from("bookings").insert(row));
        if (!error) break;

        // Signed-in booking refused (auth.sql not run yet, or the session expired): book as a guest.
        if (client === sbAuth && (error.code === "42501" || error.code === "PGRST301" || status === 401 || status === 403)) {
          console.warn("Signed-in booking was refused, so it was saved as a guest booking. Run supabase/auth.sql in Supabase.", error);
          client = sb;
          delete row.user_id;
          continue;
        }

        // The API doesn't know one of the optional columns (the SQL for it hasn't been run yet,
        // or the schema cache is stale). Drop just that column and retry.
        if (error.code === "PGRST204" || error.code === "42703") {
          const missing = (/'(\w+)' column/.exec(error.message || "") || /column "(\w+)"/.exec(error.message || "") || [])[1];
          if ((missing !== "cancel_token" && missing !== "customer_email" && missing !== "user_id") || !(missing in row)) break;
          console.warn(
            `Booking saved WITHOUT ${missing}: the insert failed because the API doesn't know that column. ` +
            "Run the matching file in supabase/ (cancellation.sql, emails.sql or auth.sql) and then: notify pgrst, 'reload schema';",
            error
          );
          delete row[missing];
          if (missing === "cancel_token") token = null;
          if (missing === "customer_email") emailSaved = false;
          continue;
        }
        break;
      }
      if (error) {
        // 23505 = unique violation: someone else booked this barber and time first
        if (error.code === "23505") {
          clearPending();
          await refreshTaken();
          renderSlots();
          showNotice("Sorry, that time was just taken. Please choose another slot.");
          return;
        }
        console.error("Booking failed:", error);
        return formError("Sorry, we couldn't save your booking. Please try again.");
      }
    } else {
      demoBookings.set(token, {
        barber: selected.name,
        service: SERVICE,
        appointment_time: slotDate(slot).toISOString(),
        status: "confirmed",
      });
    }
    book(slot, name, token, emailSaved ? email : null);
  } finally {
    submit.disabled = false;
    submit.textContent = "Confirm booking";
  }
}

function book(slot, name, token, email) {
  slot.booked = true;
  hideNotice();
  clearPending();
  renderSlots();

  const box = $("confirmation");
  box.innerHTML =
    `<svg class="tick" viewBox="0 0 56 56" aria-hidden="true">` +
    `<circle cx="28" cy="28" r="24"/><path d="M17 29l8 8 14-16"/></svg>` +
    `<div><h3>Booking confirmed</h3>` +
    `<p>Thanks ${esc(name)}, you're booked with <strong>${selected.name}</strong> on ` +
    `<strong>${fullDayLabel(slot)}</strong>. Price: <strong>£${slot.price}</strong> (pay in shop).</p></div>`;
  const emailed = live && Boolean(email); // the confirmation email is sent by the database trigger
  const extra = box.lastElementChild;
  if (token && emailed) {
    // Main message: the email has the link. The on-screen link is only a backup.
    const lead = document.createElement("p");
    lead.className = "lead";
    lead.textContent = "We've emailed you a confirmation with a link to manage or cancel your booking.";
    extra.appendChild(lead);
    extra.appendChild(manageBlock(token, { backup: true }));
  } else if (token) {
    // No email will arrive (demo mode, or the email column isn't live yet): the link is the only copy
    extra.appendChild(manageBlock(token, { backup: false }));
  } else if (live) {
    // saved, but without a cancel token (see the console warning in submitBooking)
    if (emailed) {
      const mail = document.createElement("p");
      mail.className = "note";
      mail.textContent = "A confirmation email is on its way to you.";
      extra.appendChild(mail);
    }
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      "Your booking is saved, but we couldn't create a link to manage it just now. " +
      "To change or cancel it, please contact the shop.";
    extra.appendChild(note);
  }
  box.hidden = false;
  // restart the entrance + tick animations on repeat bookings
  box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  if (authSession) loadMyBookings(); // the new booking appears under "My bookings"
}

// ---- Manage / cancel a booking ----------------------------------------------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const demoBookings = new Map(); // demo mode only: token -> booking
let managed = null;             // { token, booking } currently shown in "My booking"

function newToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function manageUrl(token) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("booking", token);
  return u.toString();
}

function whenLabel(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ` +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Link + code shown on the confirmation screen (built with the DOM, never innerHTML)
function manageBlock(token, { backup }) {
  const url = manageUrl(token);
  const wrap = document.createElement("div");
  wrap.className = "manage-link" + (backup ? " backup" : "");

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = backup
    ? "Didn't get the email? You can also manage your booking here."
    : "Save this link or take a screenshot. It's the only way to change or cancel your booking.";

  const row = document.createElement("div");
  row.className = "actions";
  const link = document.createElement("a");
  link.className = backup ? "btn btn-ghost btn-xs" : "btn btn-light btn-sm";
  link.href = url;
  link.textContent = "Manage my booking";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = backup ? "btn btn-text btn-xs" : "btn btn-ghost btn-sm";
  copy.textContent = "Copy link";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied ✓";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => (copy.textContent = "Copy link"), 2000);
  });
  row.append(link, copy);

  wrap.append(hint, row);
  return wrap;
}

async function apiGetBooking(token) {
  if (live) {
    const { data, error } = await sb.rpc("get_booking", { token });
    return error ? { error } : { booking: (data && data[0]) || null };
  }
  return { booking: demoBookings.get(token) || null };
}

async function apiCancelBooking(token) {
  if (live) {
    const { data, error } = await sb.rpc("cancel_booking", { token });
    return error ? { error } : { result: data };
  }
  const b = demoBookings.get(token);
  if (!b) return { result: "not_found" };
  if (b.status === "cancelled") return { result: "already_cancelled" };
  if (new Date(b.appointment_time) <= new Date()) return { result: "past" };
  b.status = "cancelled";
  return { result: "cancelled" };
}

function showLookupError(msg) {
  $("booking-card").hidden = true;
  const e = $("lookup-error");
  e.textContent = msg;
  e.hidden = false;
}

function setManageMessage(msg) {
  const m = $("manage-message");
  m.textContent = msg || "";
  m.hidden = !msg;
}

function renderManaged() {
  const { booking } = managed;
  const cancelled = booking.status === "cancelled";
  const past = !cancelled && new Date(booking.appointment_time) <= new Date();

  $("m-barber").textContent = booking.barber;
  $("m-service").textContent = booking.service;
  $("m-when").textContent = whenLabel(booking.appointment_time);
  const status = $("m-status");
  status.textContent = cancelled ? "Cancelled" : past ? "Completed" : "Confirmed";
  status.dataset.state = cancelled ? "cancelled" : past ? "past" : "confirmed";

  $("cancel-start").hidden = cancelled || past;
  $("cancel-confirm").hidden = true;
  $("rebook").hidden = !cancelled;
  $("booking-card").hidden = false;
}

async function lookupBooking(raw, { scroll = false } = {}) {
  $("lookup-error").hidden = true;
  setManageMessage("");
  const found = String(raw).match(UUID_RE);
  if (!found) {
    showLookupError("That doesn't look like a booking code. Paste the code or the full link from your confirmation.");
    return;
  }
  const token = found[0].toLowerCase();
  const btn = $("lookup-btn");
  btn.disabled = true;
  btn.textContent = "Searching…";
  try {
    const { booking, error } = await apiGetBooking(token);
    if (error) {
      console.error("Could not look up booking:", error);
      showLookupError("Sorry, we couldn't look up your booking right now. Please try again.");
    } else if (!booking) {
      showLookupError("We couldn't find a booking with that code. Check it and try again.");
    } else {
      managed = { token, booking };
      renderManaged();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Find booking";
    if (scroll) $("my-booking").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function confirmCancel() {
  if (!managed) return;
  const yes = $("cancel-yes");
  yes.disabled = true;
  yes.textContent = "Cancelling…";
  try {
    const { result, error } = await apiCancelBooking(managed.token);
    $("cancel-confirm").hidden = true;
    if (error) {
      console.error("Cancel failed:", error);
      $("cancel-start").hidden = false;
      return setManageMessage("Sorry, we couldn't cancel your booking. Please try again.");
    }
    if (result === "cancelled" || result === "already_cancelled") {
      managed.booking.status = "cancelled";
      renderManaged();
      setManageMessage(result === "cancelled"
        ? "Your booking has been cancelled. That time is free again for other customers."
        : "This booking was already cancelled.");
      await releaseSlot(managed.booking);
    } else if (result === "past") {
      renderManaged();
      setManageMessage("This appointment has already passed, so it can't be cancelled.");
    } else {
      showLookupError("We couldn't find that booking. Check the code and try again.");
    }
  } finally {
    yes.disabled = false;
    yes.textContent = "Yes, cancel booking";
  }
}

// Make the cancelled slot bookable again straight away in the booking flow
async function releaseSlot(booking) {
  if (live) {
    await refreshTaken();
  } else {
    const b = BARBERS.find((x) => x.name.toLowerCase() === String(booking.barber).toLowerCase());
    const s = b && b.slots.find((x) => slotDate(x).toISOString() === new Date(booking.appointment_time).toISOString());
    if (s) s.booked = false;
  }
  if (selected) renderSlots();
}

$("lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  lookupBooking($("booking-code").value);
});
$("cancel-start").addEventListener("click", () => {
  $("cancel-start").hidden = true;
  $("cancel-confirm").hidden = false;
  setManageMessage("");
  $("cancel-no").focus();
});
$("cancel-no").addEventListener("click", () => {
  $("cancel-confirm").hidden = true;
  $("cancel-start").hidden = false;
  $("cancel-start").focus();
});
$("cancel-yes").addEventListener("click", confirmCancel);

// Opened from a "Manage my booking" link: ?booking=TOKEN
const linkedBooking = new URLSearchParams(location.search).get("booking");
if (linkedBooking) {
  $("booking-code").value = linkedBooking;
  lookupBooking(linkedBooking, { scroll: true });
}

// ---- Optional customer sign-in (email magic link) -----------------------------
// Signing in is optional: guests book exactly as before. A signed-in customer gets "My bookings"
// (upcoming and past, with Cancel) and the booking form pre-filled. No passwords: Supabase emails
// a one-time link. Which bookings a customer may read is decided by the database (supabase/auth.sql),
// not by this page.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let authSession = null;            // the signed-in session, or null for guests
let myBookings = null;             // the signed-in customer's rows (null = not loaded / failed)
let accountName = "";              // name from their latest booking, to pre-fill the form
let scrollToAccount = AUTH_RETURNING; // just arrived from the email link: show My bookings once loaded

function setSigninMsg(text, kind) {
  const m = $("signin-msg");
  m.textContent = text || "";
  m.dataset.kind = kind || "";
  m.hidden = !text;
}

function openSignin() {
  setSigninMsg("");
  $("signin-submit").textContent = "Email me a sign-in link";
  if (typeof signinDialog.showModal === "function") signinDialog.showModal();
  else signinDialog.setAttribute("open", "");
  $("signin-email").focus();
}
function closeSignin() {
  if (typeof signinDialog.close === "function") signinDialog.close();
  else signinDialog.removeAttribute("open");
}

async function sendSigninLink(event) {
  event.preventDefault();
  if (!sbAuth) return;
  const email = $("signin-email").value.trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) return setSigninMsg("Please enter a valid email address.", "error");

  const btn = $("signin-submit");
  btn.disabled = true;
  btn.textContent = "Sending…";
  setSigninMsg("");
  let sent = false;
  try {
    // Back to this same page after the click. That address must be allowed in Supabase
    // (Authentication → URL Configuration → Redirect URLs); see supabase/AUTH_SETUP.md.
    const { error } = await sbAuth.auth.signInWithOtp({ email, options: { emailRedirectTo: signinRedirect() } });
    if (error) {
      console.error("Sign-in email failed:", error);
      const limited = error.status === 429 || /rate limit/i.test(error.message || "");
      setSigninMsg(
        limited
          ? "Too many sign-in emails were requested just now. Please wait a few minutes and try again, or book as a guest."
          : "Sorry, we couldn't send the sign-in link. Please try again, or book as a guest.",
        "error"
      );
    } else {
      sent = true;
      setSigninMsg(`Check your inbox. We've sent a sign-in link to ${email}. It can take a minute to arrive (check spam), and you can open it on any device.`, "ok");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = sent ? "Send it again" : "Email me a sign-in link";
  }
}

function signinRedirect() {
  // this page, without any ?booking= or #... part
  return location.protocol.startsWith("http") ? location.origin + location.pathname : undefined;
}

// Called with the current session (or null) whenever the sign-in state may have changed.
function applySession(session) {
  const previous = authSession;
  authSession = session || null;
  document.body.classList.toggle("signed-in", Boolean(authSession));
  $("nav-signin").hidden = Boolean(authSession) || !sbAuth;
  $("nav-account").hidden = !authSession;
  $("my-bookings").hidden = !authSession;

  if (authSession) {
    $("mb-email").textContent = authSession.user.email || "";
    if (!previous || previous.user.id !== authSession.user.id) {
      accountName = (authSession.user.user_metadata && authSession.user.user_metadata.full_name) || "";
      prefillFromAccount();
      loadMyBookings();
      checkAdmin();
    }
  } else {
    myBookings = null;
    accountName = "";
    $("nav-admin").hidden = true;
    $("mb-upcoming").replaceChildren();
    $("mb-past-list").replaceChildren();
    setMbMessage("");
  }
}

// Admins (barbers listed in the `admins` table, see supabase/admin.sql) get an "Admin" link.
// The database decides: admin_me() returns a row only for an admin. Any failure just means no link.
async function checkAdmin() {
  const link = $("nav-admin");
  link.hidden = true;
  if (!authSession || !sbAuth) return;
  const userId = authSession.user.id;
  try {
    const { data, error } = await sbAuth.rpc("admin_me");
    if (!authSession || authSession.user.id !== userId) return; // signed out or switched meanwhile
    link.hidden = Boolean(error) || !(data && data.length);
  } catch {
    link.hidden = true;
  }
}

function prefillFromAccount() {
  if (!authSession) return;
  const email = $("customer-email");
  const name = $("customer-name");
  if (!email.value) email.value = authSession.user.email || "";
  if (!name.value && accountName) name.value = accountName;
}

function setMbMessage(msg) {
  const m = $("mb-message");
  m.textContent = msg || "";
  m.hidden = !msg;
}

// The database only returns THIS customer's bookings (row-level security in supabase/auth.sql):
// their own, plus guest bookings made with their verified email.
async function loadMyBookings() {
  if (!authSession || !sbAuth) return;
  const { data, error } = await sbAuth
    .from("bookings")
    .select("barber, service, appointment_time, status, cancel_token, customer_name")
    .order("appointment_time", { ascending: false })
    .limit(200);
  if (!authSession) return; // signed out while loading
  if (error) {
    console.error("Could not load My bookings (has supabase/auth.sql been run?):", error);
    myBookings = null;
  } else {
    myBookings = data;
    const named = data.find((r) => r.customer_name);
    if (named) accountName = named.customer_name;
    prefillFromAccount(); // the name may only arrive now
  }
  renderMyBookings();
  if (scrollToAccount) {
    scrollToAccount = false;
    setTimeout(() => $("my-bookings").scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }
}

function bookingItem(row, upcoming) {
  const li = document.createElement("li");
  li.className = "booking-item";

  const main = document.createElement("div");
  main.className = "bi-main";
  const when = document.createElement("p");
  when.className = "bi-when";
  when.textContent = whenLabel(row.appointment_time);
  const meta = document.createElement("p");
  meta.className = "bi-meta";
  meta.textContent = `${row.barber} · ${row.service}`;
  main.append(when, meta);
  li.appendChild(main);

  const side = document.createElement("div");
  side.className = "bi-side";
  if (upcoming && row.cancel_token) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost btn-sm";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => askToCancel(li, row, cancel));
    side.appendChild(cancel);
  } else if (!upcoming) {
    const tag = document.createElement("span");
    tag.className = "status";
    tag.dataset.state = row.status === "cancelled" ? "cancelled" : "past";
    tag.textContent = row.status === "cancelled" ? "Cancelled" : "Completed";
    side.appendChild(tag);
  }
  li.appendChild(side);
  return li;
}

// "Are you sure?" step, same wording as the My booking (paste a code) section
function askToCancel(li, row, cancelBtn) {
  cancelBtn.hidden = true;
  setMbMessage("");
  const box = document.createElement("div");
  box.className = "confirm-box bi-confirm";
  box.setAttribute("role", "group");
  const q = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = "Are you sure?";
  q.append(strong, " Your slot will be released for other customers.");
  const actions = document.createElement("div");
  actions.className = "actions";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn btn-light btn-sm";
  yes.textContent = "Yes, cancel booking";
  yes.addEventListener("click", () => cancelMine(row, yes));
  const no = document.createElement("button");
  no.type = "button";
  no.className = "btn btn-ghost btn-sm";
  no.textContent = "Keep booking";
  no.addEventListener("click", () => {
    box.remove();
    cancelBtn.hidden = false;
    cancelBtn.focus();
  });
  actions.append(yes, no);
  box.append(q, actions);
  li.appendChild(box);
  no.focus();
}

// Uses the same cancel_booking(token) function as the "Manage my booking" link
async function cancelMine(row, yes) {
  yes.disabled = true;
  yes.textContent = "Cancelling…";
  const { result, error } = await apiCancelBooking(row.cancel_token);
  if (error) {
    console.error("Cancel failed:", error);
    renderMyBookings();
    return setMbMessage("Sorry, we couldn't cancel your booking. Please try again.");
  }
  if (result === "cancelled" || result === "already_cancelled") {
    row.status = "cancelled";
    renderMyBookings();
    setMbMessage(result === "cancelled"
      ? "Your booking has been cancelled. That time is free again for other customers."
      : "This booking was already cancelled.");
    await releaseSlot(row); // the slot shows as available again in the booking flow
  } else if (result === "past") {
    renderMyBookings();
    setMbMessage("This appointment has already passed, so it can't be cancelled.");
  } else {
    setMbMessage("We couldn't find that booking any more.");
    loadMyBookings();
  }
}

function renderMyBookings() {
  const upList = $("mb-upcoming");
  const pastList = $("mb-past-list");
  upList.replaceChildren();
  pastList.replaceChildren();
  const err = $("mb-error");

  if (myBookings === null) {
    err.textContent = "Sorry, we couldn't load your bookings right now. You can still book as a guest.";
    err.hidden = false;
    $("mb-empty").hidden = true;
    $("mb-past").hidden = true;
    return;
  }
  err.hidden = true;

  const now = new Date();
  const when = (r) => new Date(r.appointment_time).getTime();
  const upcoming = myBookings.filter((r) => r.status !== "cancelled" && when(r) > now).sort((a, b) => when(a) - when(b));
  const past = myBookings.filter((r) => !upcoming.includes(r)).sort((a, b) => when(b) - when(a));

  upcoming.forEach((r) => upList.appendChild(bookingItem(r, true)));
  past.forEach((r) => pastList.appendChild(bookingItem(r, false)));
  $("mb-empty").hidden = upcoming.length > 0;
  $("mb-past").hidden = past.length === 0;
  $("mb-past-summary").textContent = `Past bookings (${past.length})`;
}

const signinDialog = $("signin-dialog");
$("nav-signin").addEventListener("click", openSignin);
$("signin-close").addEventListener("click", closeSignin);
$("signin-form").addEventListener("submit", sendSigninLink);
signinDialog.addEventListener("click", (e) => {
  // a click on the dark backdrop (outside the box) closes it; clicks inside the box do not
  const r = signinDialog.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (e.target === signinDialog && outside) closeSignin();
});
$("nav-signout").addEventListener("click", async () => {
  if (sbAuth) await sbAuth.auth.signOut();
  applySession(null);
});

function initAuth() {
  if (!sbAuth) return; // demo mode, or the Supabase library didn't load: no sign-in
  $("nav-signin").hidden = false;
  if (AUTH_LINK_ERROR) {
    // an old or already-used link: reopen the sign-in box so they can ask for a fresh one
    history.replaceState(null, "", location.pathname + location.search);
    openSignin();
    setSigninMsg("That sign-in link has expired or was already used. Enter your email to get a new one.", "error");
  }
  sbAuth.auth.onAuthStateChange((event, session) => {
    setTimeout(() => applySession(session), 0); // never call Supabase from inside this callback
  });
  sbAuth.auth.getSession().then(({ data }) => applySession(data.session));
}
initAuth();

// ---- Scroll reveal ----------------------------------------------------------
const revealObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        revealObserver.unobserve(el);
        el.classList.add("in");
        // drop the reveal styles once finished so hover transitions stay snappy
        const delay = parseFloat(el.style.getPropertyValue("--d")) || 0;
        setTimeout(() => el.classList.remove("reveal", "in"), (delay + 1) * 1000 + 100);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" })
  : null;

function observe(el) {
  if (revealObserver) revealObserver.observe(el);
  else el.classList.remove("reveal");
}

// ---- Stats counters ---------------------------------------------------------
// Count up from 0 the first time the section scrolls into view, then never again.
(function () {
  const nums = document.querySelectorAll(".stat-num");
  const section = document.querySelector(".stats");
  if (!nums.length || !section) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (el, v) => {
    const dec = Number(el.dataset.decimals || 0);
    const n = v.toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return el.dataset.suffix ? `${n}<span class="sfx">${el.dataset.suffix}</span>` : n;
  };
  const run = (el) => {
    const target = Number(el.dataset.count);
    const start = performance.now();
    const duration = 1800;
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      el.innerHTML = fmt(el, target * (1 - Math.pow(1 - t, 3))); // ease-out
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // No observer or reduced motion: leave the final values from the HTML in place
  if (reduce || !("IntersectionObserver" in window)) return;

  nums.forEach((el) => (el.innerHTML = fmt(el, 0)));
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect(); // only animate once
    nums.forEach(run);
  }, { threshold: 0.4 });
  io.observe(section);
})();

// ---- Google reviews bar (marquee) --------------------------------------------
// Renders REVIEWS (top of this file) into a slow, endless sideways scroll. The list is
// drawn twice so the loop is seamless. It pauses on hover (mouse) or touch, and with
// "reduce motion" switched on it becomes a plain swipeable row instead.
(function () {
  const marquee = $("reviews-marquee");
  const track = $("reviews-track");
  if (!marquee || !track || !REVIEWS.length) return;

  const SPEED = 32; // pixels per second: slow and smooth
  const G_PATHS = [
    ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
    ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
    ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
    ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"],
  ];
  const NS = "http://www.w3.org/2000/svg";

  function googleG() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "g-icon");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Google");
    G_PATHS.forEach(([fill, d]) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("fill", fill);
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }

  function card(r, isClone) {
    const li = document.createElement("li");
    li.className = "review";
    if (isClone) li.setAttribute("aria-hidden", "true"); // the repeat is for the loop only

    const top = document.createElement("div");
    top.className = "review-top";
    const stars = document.createElement("span");
    stars.className = "stars";
    stars.setAttribute("role", "img");
    stars.setAttribute("aria-label", "5 out of 5 stars");
    stars.textContent = "★★★★★";
    top.append(stars, googleG());

    const text = document.createElement("p");
    text.className = "review-text";
    text.textContent = `“${r.text}”`;

    const name = document.createElement("p");
    name.className = "review-name";
    name.textContent = r.name;

    li.append(top, text, name);
    return li;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function render() {
    const still = reduced.matches;
    track.replaceChildren(...REVIEWS.map((r) => card(r, false)));
    marquee.classList.toggle("is-static", still);
    marquee.classList.remove("is-paused");
    if (still) {
      marquee.tabIndex = 0; // keyboard users can scroll the row
      marquee.setAttribute("aria-label", "Customer reviews from Google (scroll sideways)");
      return;
    }
    marquee.removeAttribute("tabindex");
    marquee.setAttribute("aria-label", "Customer reviews from Google");
    REVIEWS.forEach((r) => track.appendChild(card(r, true)));
    // one full set takes (its width / SPEED) seconds to pass
    const oneSet = track.getBoundingClientRect().width / 2;
    track.style.setProperty("--marquee-duration", `${Math.max(20, oneSet / SPEED).toFixed(1)}s`);
  }

  // Touch: holding or tapping pauses; it carries on 3 seconds after the finger lifts.
  // (Mouse pausing is done in CSS with :hover.)
  let resumeTimer;
  marquee.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(resumeTimer);
    marquee.classList.add("is-paused");
  });
  const letGo = (e) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => marquee.classList.remove("is-paused"), 3000);
  };
  marquee.addEventListener("pointerup", letGo);
  marquee.addEventListener("pointercancel", letGo);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 200);
  });
  reduced.addEventListener("change", render);
  render();
})();

// ---- Hero parallax ----------------------------------------------------------
// The background photo slides down a little as you scroll, so it appears to move slower than
// the page. Transform only (no layout, no background-attachment: fixed, which breaks on iOS).
// With "reduce motion" switched on it stays still.
(function () {
  const hero = $("top");
  const bg = hero && hero.querySelector(".hero-bg");
  if (!bg) return;

  const RATE = 0.3; // 0.3 = the photo moves 30% slower than the page
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let limit = 0;    // stop once the hero has scrolled out of view
  let queued = false;

  function measure() {
    limit = hero.offsetHeight * 1.2;
  }
  function paint() {
    queued = false;
    const y = Math.max(0, window.scrollY); // ignore iOS rubber-banding above the top
    if (y > limit) return;
    // never slide further than the 32% of spare photo above the hero
    const shift = Math.min(y * RATE, hero.offsetHeight * 0.32);
    bg.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
  }
  function onScroll() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(paint);
    }
  }
  function sync() {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", measure);
    if (reduced.matches) {
      bg.style.transform = "";
      return;
    }
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    paint();
  }
  reduced.addEventListener("change", sync);
  sync();
})();

// ---- Sticky "Book now" button -----------------------------------------------
// Visible once the hero has scrolled away, hidden while the booking or
// "My booking" section is on screen.
(function () {
  const btn = $("sticky-book");
  const hero = $("top");
  const booking = $("booking");
  const manage = $("my-booking");
  const mine = $("my-bookings");
  if (!btn || !hero || !booking || !manage || !("IntersectionObserver" in window)) return;

  let heroPast = false;
  let bookingOnScreen = false;
  let manageOnScreen = false;
  let mineOnScreen = false;
  const update = () => btn.classList.toggle("show", heroPast && !bookingOnScreen && !manageOnScreen && !mineOnScreen);

  new IntersectionObserver(([e]) => {
    heroPast = !e.isIntersecting && e.boundingClientRect.top < 0;
    update();
  }).observe(hero);
  new IntersectionObserver(([e]) => {
    bookingOnScreen = e.isIntersecting;
    update();
  }).observe(booking);
  new IntersectionObserver(([e]) => {
    manageOnScreen = e.isIntersecting;
    update();
  }).observe(manage);
  if (mine) {
    new IntersectionObserver(([e]) => {
      mineOnScreen = e.isIntersecting;
      update();
    }).observe(mine);
  }
})();

// ---- Init -------------------------------------------------------------------
$("year").textContent = new Date().getFullYear();
$("next-available").addEventListener("click", jumpToNext);
$("details-form").addEventListener("submit", submitBooking);
$("cancel-booking").addEventListener("click", clearPending);
renderBarbers();
document.querySelectorAll(".reveal").forEach((el) => { if (!el.classList.contains("barber")) observe(el); });

if (configured && !live) {
  showNotice("Booking is unavailable right now (couldn't load the booking service).");
} else {
  refreshTaken(); // warm up so the first barber click is instant
}
