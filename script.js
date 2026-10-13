"use strict";

// ---- Supabase config --------------------------------------------------------
// Paste your Project URL and anon public key (Supabase → Project Settings → API).
// Leave both empty to run in demo mode (bookings are kept in memory only).
// The anon key is meant to be public; access is controlled by the row-level
// security policies in supabase/setup.sql.
const SUPABASE_URL = "";
const SUPABASE_ANON_KEY = "";
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
    if (live) {
      const { error } = await sb.from("bookings").insert({
        barber: selected.name,
        customer_name: name,
        service: SERVICE,
        appointment_time: slotDate(slot).toISOString(),
        customer_phone: phone,
        status: "confirmed",
      });
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
    }
    book(slot, name);
  } finally {
    submit.disabled = false;
    submit.textContent = "Confirm booking";
  }
}

function book(slot, name) {
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
  box.hidden = false;
  // restart the entrance + tick animations on repeat bookings
  box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
  box.scrollIntoView({ behavior: "smooth", block: "center" });
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
