-- Blain Hair: booking confirmation emails. Run once in Supabase → SQL Editor,
-- after setup.sql and cancellation.sql. Safe to run more than once.

-- 1. Customer email column ---------------------------------------------------------
-- Nullable on purpose: bookings made before this change have no email, and the old
-- version of the site (still cached in someone's browser) can keep booking. The booking
-- form on the site makes the email required.
alter table public.bookings
  add column if not exists customer_email text;

-- 2. Insert rule: same checks as before, plus "if an email is given it must look valid" ---
-- (get_booking and the taken_slots view do NOT return the email, so it stays private.)
drop policy if exists "Anyone can create a booking" on public.bookings;
create policy "Anyone can create a booking"
  on public.bookings for insert
  to anon
  with check (
    status = 'confirmed'
    and char_length(customer_name) between 1 and 80
    and char_length(customer_phone) between 6 and 30
    and appointment_time > now()
    and (
      customer_email is null
      or (char_length(customer_email) <= 254
          and customer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    )
  );

-- The table-level insert grant from setup.sql already covers the new column; this
-- just makes sure.
grant insert on public.bookings to anon;
grant insert (customer_email) on public.bookings to anon;

-- 3. Tell the API about the new column (otherwise inserts that include it can fail
--    with "column not found in the schema cache") ------------------------------------
notify pgrst, 'reload schema';

-- Optional, later: once every booking has an email and the old site is gone, you can
-- make the column mandatory in the database too:
--   alter table public.bookings alter column customer_email set not null;
