# Barber admin (part 1): setup

Admins sign in with the same emailed magic link as customers. Only emails listed in the `admins` table are admins.

## 1. Run the SQL

Supabase → SQL Editor → run `supabase/admin.sql` (after `setup.sql`, `cancellation.sql`, `emails.sql` and `auth.sql`; it stops with a clear message if one is missing). Safe to run again.

## 2. Make yourself an admin (one line)

```sql
insert into public.admins (email, barber_name) values ('you@example.com', 'Matty');
```

Use the email you sign in with, and the barber's name exactly as on the site (`Matty` or `Alfie`). Add Matty or Alfie later with the same line. Remove someone with `delete from public.admins where email = 'you@example.com';` (their access stops straight away). Letter case in the email doesn't matter.

## 3. Sign in

Sign in on the website (**Sign in**), then tap **Admin** in the menu. Or go straight to `admin.html` and sign in there. To make the email link land on the admin page, add `https://YOUR-SITE/admin.html` under Authentication → URL Configuration → Redirect URLs (see `AUTH_SETUP.md`). If you don't, the link lands on the main site, where the **Admin** link appears once you're signed in.

Keep **Confirm email** switched ON (AUTH_SETUP step 3): admin access only counts for an email that has been confirmed by clicking a link.

## What the admin page does

- Bookings by day (today first, previous/next day, date picker), filter by barber. Times are UK time.
- Cancel any upcoming booking ("Are you sure?"). This uses the existing `cancel_booking`, so the slot frees up and the cancellation email goes out as usual.
- Add a booking for a phone or walk-in customer: barber, service, date, a free time, name, phone, optional email. It uses the same one-active-booking-per-barber-per-time rule as online bookings, and sends the confirmation email if an email is given.
- The times offered follow each barber's working hours, breaks, days off and extra hours (part 2, below). Until a barber has hours saved, 09:00 to 18:00 every 30 minutes.

## Security

Everything is decided in the database: the admins table has no access from the website at all; `is_admin()` checks the signed-in, confirmed email; admins get a read policy on `bookings`; adding a booking goes through `admin_create_booking`, which refuses non-admins. Customers still see only their own bookings. `admin.html` itself is a public file with no data in it.

## Tests

`npm install` then `npm test`. The SQL tests start a throwaway Postgres 16 (needs PostgreSQL binaries) and load the real `supabase/*.sql` files; the browser tests use Playwright's Chromium with a fake Supabase API.

## Part 2: working hours, days off and the week view

Set each barber's weekly hours (with an optional break), block days or hours off, open extra hours, and see the whole week at a glance. Setup is one more SQL file: follow **`HOURS_SETUP.md`** (beginner steps). After that the admin page has **Day**, **Week** and **Hours** tabs.
