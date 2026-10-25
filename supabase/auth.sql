-- Blain Hair: optional customer sign-in (Supabase Auth magic links).
-- Run once in Supabase → SQL Editor, after setup.sql, cancellation.sql and emails.sql.
-- Safe to run more than once.
--
-- What this does:
--   • bookings get a user_id (who made it, if they were signed in)
--   • a signed-in customer can READ ONLY THEIR OWN bookings (never anyone else's)
--   • signed-in customers can create bookings too (guests keep working exactly as before)
--   • the public site can still never read, change or delete bookings directly
-- Guest booking, the token-based "Manage my booking" link, get_booking and cancel_booking
-- are not changed.

-- 1. Link a booking to the customer who made it -------------------------------------
-- on delete set null: if someone deletes their account, their bookings stay (as guest bookings).
alter table public.bookings
  add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists bookings_user_id_idx on public.bookings (user_id);
create index if not exists bookings_customer_email_lower_idx on public.bookings (lower(customer_email));

-- 2. "Which verified email does the signed-in customer have?" ------------------------
-- Used to show earlier GUEST bookings made with the same email. Only an email the customer
-- has actually confirmed (by clicking a sign-in link) counts, so nobody can read someone
-- else's bookings by typing in their address.
create or replace function public.my_verified_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from auth.users u
  where u.id = (select auth.uid())
    and u.email_confirmed_at is not null;
$$;

revoke all on function public.my_verified_email() from public, anon;
grant execute on function public.my_verified_email() to authenticated;

-- 3. Who can read bookings ------------------------------------------------------------
alter table public.bookings enable row level security;

drop policy if exists "Customers read their own bookings" on public.bookings;
create policy "Customers read their own bookings"
  on public.bookings for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or lower(customer_email) = lower((select public.my_verified_email()))
  );

-- 4. Who can create bookings ----------------------------------------------------------
-- Guests (role "anon") keep their existing insert policy from setup.sql / emails.sql.
-- Signed-in customers (role "authenticated") need one too, with the same checks:
drop policy if exists "Signed-in customers can create a booking" on public.bookings;
create policy "Signed-in customers can create a booking"
  on public.bookings for insert
  to authenticated
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

-- Nobody can attach a booking to somebody else. These are RESTRICTIVE policies: they apply
-- on top of every other insert policy, so they still hold even if you re-run emails.sql.
drop policy if exists "Guests cannot set user_id" on public.bookings;
create policy "Guests cannot set user_id"
  on public.bookings as restrictive for insert
  to anon
  with check (user_id is null);

drop policy if exists "Signed-in customers can only book as themselves" on public.bookings;
create policy "Signed-in customers can only book as themselves"
  on public.bookings as restrictive for insert
  to authenticated
  with check (user_id is null or user_id = (select auth.uid()));

-- 5. Table permissions (RLS above decides WHICH rows) ----------------------------------
-- Signed-in customers: read and create only. No updating or deleting directly: cancelling
-- goes through cancel_booking(token), exactly like before.
revoke all on public.bookings from authenticated;
grant select, insert on public.bookings to authenticated;
-- Guests: create only (unchanged).
revoke select, update, delete on public.bookings from anon;

-- The "taken slots" view lets the site grey out booked times. Signed-in customers need it too.
grant select on public.taken_slots to authenticated;

-- 6. Tell the API about the new column and policies ------------------------------------
notify pgrst, 'reload schema';
