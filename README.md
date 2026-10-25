# Blain Hair

Single-page barber booking site: `index.html`, `styles.css`, `script.js` (plus `logo.png`).

## Connecting Supabase

1. In the Supabase SQL Editor, run `supabase/setup.sql`. It adds a unique index (no double bookings), row-level security (the site can create bookings but not read customer details) and a `taken_slots` view used to grey out booked times.
2. In `script.js`, fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API). The anon key is safe to publish; never use the `service_role` key here.
3. To enable booking cancellation, also run `supabase/cancellation.sql` (adds a secret `cancel_token`, a partial unique index so cancelled slots can be re-booked, and the `get_booking` / `cancel_booking` functions). Customers get a "Manage my booking" link (`?booking=TOKEN`) on the confirmation screen, or can paste their code under "My booking".
4. Open `index.html` (or serve the folder). With both values empty the site runs in demo mode.

## Booking confirmation emails

Customers enter an email on the booking form and get a "Booking confirmed" email (with a Manage my booking link) and a "Booking cancelled" email, sent through Resend. The Resend key lives only in Supabase secrets, never in the site. Setup is dashboard-only: see [`supabase/EMAILS_SETUP.md`](supabase/EMAILS_SETUP.md). Files: `supabase/emails.sql` (database), `supabase/functions/booking-emails/index.ts` (the function) and `supabase/email_trigger.sql` (the database trigger that calls it).

## Optional customer sign-in

Customers can sign in with an emailed magic link (no passwords) to see **My bookings** (upcoming, with Cancel, and past) and get the booking form pre-filled. Signing in is optional: guest booking and the "Manage my booking" links work exactly as before. Setup is dashboard-only: see [`supabase/AUTH_SETUP.md`](supabase/AUTH_SETUP.md). Files: `supabase/auth.sql` (row-level security: a customer can only read their own bookings) and `supabase/auth_email_template.html` (the sign-in email).

## Barber admin

Admins (emails in the `admins` table) get an **Admin** link and a phone-friendly page to see bookings by day, cancel, and add phone/walk-in bookings. Setup, including the one line of SQL that makes you an admin: [`supabase/ADMIN_SETUP.md`](supabase/ADMIN_SETUP.md). Files: `admin.html`, `admin.css`, `admin.js`, `admin-logic.js`, `supabase/admin.sql`. Tests: `npm install && npm test`.
