"use strict";

// ---- Supabase config --------------------------------------------------------
// Paste your Project URL and anon public key (Supabase → Project Settings → API).
// Leave both empty to run in demo mode (bookings are kept in memory only).
// The anon key is meant to be public; access is controlled by the row-level
// security policies in supabase/setup.sql.
const SUPABASE_URL = "https://mddhykzuxrywhtmjwajy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZGh5a3p1eHJ5d2h0bWp3YWp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MjAyMTQsImV4cCI6MjEwNzQ5NjIxNH0.kPm-ifCf1Pdg35czMDUPqEwqnMLKfKdZmAe88VgIqVI";
const SERVICE = "Haircut"; // saved in the `service` column

const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const sb = configured && window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
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

  if (name.length < 2) return formError("Please enter your name.");
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) return formError("Please enter a valid phone number.");
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
    if (live) {
      const row = {
        barber: selected.name,
        customer_name: name,
        service: SERVICE,
        appointment_time: slotDate(slot).toISOString(),
        customer_phone: phone,
        status: "confirmed",
        cancel_token: token,
      };
      let { error } = await sb.from("bookings").insert(row);
      // cancellation.sql not run yet (no cancel_token column): still take the booking
      if (error && (error.code === "PGRST204" || error.code === "42703")) {
        delete row.cancel_token;
        token = null;
        ({ error } = await sb.from("bookings").insert(row));
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
    book(slot, name, token);
  } finally {
    submit.disabled = false;
    submit.textContent = "Confirm booking";
  }
}

function book(slot, name, token) {
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
  if (token) box.lastElementChild.appendChild(manageBlock(token));
  box.hidden = false;
  // restart the entrance + tick animations on repeat bookings
  box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
  box.scrollIntoView({ behavior: "smooth", block: "center" });
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
function manageBlock(token) {
  const url = manageUrl(token);
  const wrap = document.createElement("div");
  wrap.className = "manage-link";

  const row = document.createElement("div");
  row.className = "actions";
  const link = document.createElement("a");
  link.className = "btn btn-light btn-sm";
  link.href = url;
  link.textContent = "Manage my booking";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn-ghost btn-sm";
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

  const note = document.createElement("p");
  note.className = "note";
  note.append("Save this link or take a screenshot. It's the only way to change or cancel your booking. Booking code: ");
  const code = document.createElement("code");
  code.textContent = token;
  note.append(code);

  wrap.append(row, note);
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

// ---- Sticky "Book now" button -----------------------------------------------
// Visible once the hero has scrolled away, hidden while the booking or
// "My booking" section is on screen.
(function () {
  const btn = $("sticky-book");
  const hero = $("top");
  const booking = $("booking");
  const manage = $("my-booking");
  if (!btn || !hero || !booking || !manage || !("IntersectionObserver" in window)) return;

  let heroPast = false;
  let bookingOnScreen = false;
  let manageOnScreen = false;
  const update = () => btn.classList.toggle("show", heroPast && !bookingOnScreen && !manageOnScreen);

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
