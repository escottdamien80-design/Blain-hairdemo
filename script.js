"use strict";

// ---- Dummy data (no backend) ----------------------------------------------
// Each slot: day offset from today, 24h time, price in £, and whether it's already booked.
const BARBERS = [
  {
    id: "marcus",
    name: "Marcus",
    role: "Senior barber · Fades & beards",
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
    id: "jay",
    name: "Jay",
    role: "Stylist · Classic cuts & styling",
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
let selected = null;

function renderBarbers() {
  const wrap = $("barbers");
  BARBERS.forEach((b) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "barber";
    btn.id = `barber-${b.id}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.innerHTML =
      `<span class="avatar">${b.name[0]}</span>` +
      `<span class="barber-name">${b.name}</span>` +
      `<span class="barber-role">${b.role}</span>`;
    btn.addEventListener("click", () => selectBarber(b));
    wrap.appendChild(btn);
  });
}

function selectBarber(barber) {
  selected = barber;
  document.querySelectorAll(".barber").forEach((el) =>
    el.setAttribute("aria-checked", String(el.id === `barber-${barber.id}`))
  );
  $("confirmation").hidden = true;
  renderSlots();
  const step = $("slots-step");
  const wasHidden = step.hidden;
  step.hidden = false;
  if (wasHidden) step.scrollIntoView({ behavior: "smooth", block: "start" });
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
      .forEach((slot) => list.appendChild(slotEl(slot)));

    section.append(title, list);
    container.appendChild(section);
  });

  $("next-available").disabled = !nextAvailable(selected);
}

function slotEl(slot) {
  const free = isAvailable(slot);
  const el = document.createElement("div");
  el.className = "slot" + (free ? "" : " taken");
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
  btn.addEventListener("click", () => book(slot));
  el.appendChild(btn);
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

function book(slot) {
  slot.booked = true;
  renderSlots();

  const box = $("confirmation");
  box.innerHTML =
    `<h3>✓ Booking confirmed</h3>` +
    `<p>You're booked with <strong>${selected.name}</strong> on ` +
    `<strong>${fullDayLabel(slot)}</strong>. Price: <strong>£${slot.price}</strong> (pay in shop).</p>`;
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---- Init -------------------------------------------------------------------
$("year").textContent = new Date().getFullYear();
$("next-available").addEventListener("click", jumpToNext);
renderBarbers();
