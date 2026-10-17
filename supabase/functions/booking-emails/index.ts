// Blain Hair booking emails: Supabase Edge Function (Deno), sends through Resend.
//
// Called by a Supabase Database Webhook on the `bookings` table:
//   INSERT                          -> "Booking confirmed" email (with the Manage my booking link)
//   UPDATE where status → cancelled -> "Booking cancelled" email
// Anything else is ignored.
//
// Secrets (Edge Functions → Secrets). Nothing secret lives in the website code:
//   RESEND_API_KEY  your Resend API key (re_...)
//   WEBHOOK_SECRET  a long random string; the webhook must send it in the x-webhook-secret header
//   SITE_URL        your website address, e.g. https://example.com/ (used for the manage link)
//   FROM_EMAIL      optional; defaults to Blain Hair <onboarding@resend.dev>. Change it once
//                   you have verified your own domain in Resend.

const DEFAULT_FROM = "Blain Hair <onboarding@resend.dev>";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BookingRow = {
  barber?: string | null;
  customer_name?: string | null;
  service?: string | null;
  appointment_time?: string | null;
  customer_email?: string | null;
  cancel_token?: string | null;
  status?: string | null;
};

type WebhookPayload = {
  type?: string;
  table?: string;
  record?: BookingRow | null;
  old_record?: BookingRow | null;
};

type Kind = "confirmed" | "cancelled";

// ---------- helpers ----------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Everything that came from a customer is escaped before it goes into HTML.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// Constant-time string comparison for the shared secret.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Appointment times are stored in UTC; emails always show UK time (GMT/BST).
function ukWhen(iso: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return { date, time };
}

function siteLink(site: string, token?: string | null) {
  try {
    const u = new URL(site);
    u.search = "";
    u.hash = "";
    if (token) u.searchParams.set("booking", token);
    return u.toString();
  } catch {
    return "";
  }
}

// ---------- email design (dark, minimal, table-based so email apps render it) ----------

const FONT_BODY = "Georgia,'Times New Roman',serif";
const FONT_HEAD = "'Bebas Neue',Impact,'Arial Narrow',Arial,sans-serif";

function layout(opts: { title: string; preheader: string; inner: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0e0d0d;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0e0d0d;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0e0d0d" style="background:#0e0d0d;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
    <tr><td align="center" style="padding:0 0 28px 0.5em;font-family:${FONT_BODY};font-size:22px;letter-spacing:0.5em;color:#ffffff;">BLAIN</td></tr>
    <tr><td bgcolor="#1b1918" style="background:#1b1918;border:1px solid #2e2b2a;border-radius:20px;padding:36px 32px;font-family:${FONT_BODY};color:#d6d3d1;font-size:16px;line-height:1.6;">
      ${opts.inner}
    </td></tr>
    <tr><td align="center" style="padding:24px 8px 0;font-family:${FONT_BODY};font-size:13px;line-height:1.5;color:#78716c;">
      Blain Hair &middot; You're getting this because a booking was made with this email address.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function heading(text: string) {
  return `<h1 style="margin:0 0 16px;font-family:${FONT_HEAD};font-weight:400;font-size:36px;line-height:1.05;letter-spacing:0.03em;text-transform:uppercase;color:#ffffff;">${esc(text)}</h1>`;
}

function detailsTable(rows: [string, string][]) {
  const tr = rows
    .map(
      ([label, value], i) => `<tr>
        <td style="padding:14px 0;${i ? "border-top:1px solid #2e2b2a;" : ""}font-family:${FONT_BODY};font-size:14px;color:#a8a29e;" width="35%">${esc(label)}</td>
        <td align="right" style="padding:14px 0;${i ? "border-top:1px solid #2e2b2a;" : ""}font-family:${FONT_BODY};font-size:16px;font-weight:bold;color:#ffffff;">${esc(value)}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 28px;border-top:1px solid #2e2b2a;border-bottom:1px solid #2e2b2a;">${tr}</table>`;
}

function button(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:12px;">
    <a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_BODY};font-size:16px;font-weight:bold;color:#111111;text-decoration:none;">${esc(label)}</a>
  </td></tr></table>`;
}

function render(kind: Kind, rec: BookingRow, site: string) {
  const first = String(rec.customer_name ?? "").trim().split(/\s+/)[0] || "there";
  const { date, time } = rec.appointment_time ? ukWhen(rec.appointment_time) : { date: "", time: "" };
  const details: [string, string][] = [
    ["Barber", String(rec.barber ?? "")],
    ["Service", String(rec.service ?? "")],
    ["Date", date],
    ["Time (UK)", time],
  ];
  const detailsText = details.map(([k, v]) => `${k}: ${v}`).join("\n");

  if (kind === "confirmed") {
    const manage = siteLink(site, rec.cancel_token);
    const inner =
      heading("Booking confirmed") +
      `<p style="margin:0;">Hi ${esc(first)}, you're all booked in. See you soon.</p>` +
      detailsTable(details) +
      (manage
        ? button(manage, "Manage my booking") +
          `<p style="margin:24px 0 0;font-size:14px;color:#a8a29e;">Keep this email. The link above is the only way to change or cancel your booking.</p>` +
          (rec.cancel_token
            ? `<p style="margin:12px 0 0;font-size:13px;color:#78716c;">Booking code:<br><span style="font-family:Menlo,Consolas,monospace;font-size:12px;color:#d6d3d1;word-break:break-all;">${esc(rec.cancel_token)}</span></p>`
            : "")
        : `<p style="margin:0;font-size:14px;color:#a8a29e;">To change or cancel your booking, please contact the shop.</p>`);
    const text =
      `Booking confirmed\n\nHi ${first}, you're all booked in.\n\n${detailsText}\n\n` +
      (manage
        ? `Manage my booking: ${manage}\nKeep this email. The link is the only way to change or cancel your booking.\n` +
          (rec.cancel_token ? `Booking code: ${rec.cancel_token}\n` : "")
        : "To change or cancel your booking, please contact the shop.\n") +
      `\nBlain Hair`;
    return {
      subject: "Booking confirmed – Blain Hair",
      html: layout({ title: "Booking confirmed", preheader: `${date} at ${time} (UK time) with ${rec.barber ?? "us"}`, inner }),
      text,
    };
  }

  const again = siteLink(site);
  const inner =
    heading("Booking cancelled") +
    `<p style="margin:0;">Hi ${esc(first)}, your booking has been cancelled. Nothing more to do.</p>` +
    detailsTable(details) +
    (again ? button(again, "Book another time") : "");
  const text =
    `Booking cancelled\n\nHi ${first}, your booking has been cancelled.\n\n${detailsText}\n\n` +
    (again ? `Book another time: ${again}\n` : "") +
    `\nBlain Hair`;
  return {
    subject: "Booking cancelled – Blain Hair",
    html: layout({ title: "Booking cancelled", preheader: `Your booking on ${date} at ${time} has been cancelled`, inner }),
    text,
  };
}

// ---------- the function ----------

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Only our own database webhook may call this: it must send the shared secret.
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (!secret) return json({ error: "WEBHOOK_SECRET is not set on the function" }, 500);
  if (!safeEqual(req.headers.get("x-webhook-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ error: "RESEND_API_KEY is not set on the function" }, 500);

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "body is not valid JSON" }, 400);
  }

  const rec = payload.record;
  if (payload.table !== "bookings" || !rec) return json({ skipped: "not a bookings row" });

  let kind: Kind | null = null;
  if (payload.type === "INSERT") {
    kind = "confirmed";
  } else if (payload.type === "UPDATE" && rec.status === "cancelled" && payload.old_record?.status !== "cancelled") {
    kind = "cancelled";
  }
  if (!kind) return json({ skipped: "nothing to send for this change" });

  const to = String(rec.customer_email ?? "").trim();
  if (!EMAIL_RE.test(to) || to.length > 254) return json({ skipped: "booking has no valid customer_email" });

  const site = (Deno.env.get("SITE_URL") ?? "").trim();
  if (!site) console.warn("SITE_URL secret is not set: emails will have no website links.");
  const { subject, html, text } = render(kind, rec, site);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL") || DEFAULT_FROM, to: [to], subject, html, text }),
  });
  const detail = (await res.text()).slice(0, 500);
  if (!res.ok) {
    // e.g. 403: with onboarding@resend.dev Resend only delivers to YOUR OWN Resend account email
    console.error(`Resend rejected the "${kind}" email: HTTP ${res.status} ${detail}`);
    return json({ error: "resend_failed", status: res.status, detail }, 502);
  }
  console.log(`Sent "${kind}" email (Resend HTTP ${res.status})`);
  return json({ sent: kind });
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") Deno.serve(handle);
