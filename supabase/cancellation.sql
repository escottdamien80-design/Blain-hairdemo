-- Blain Hair: booking cancellation. Run once in Supabase → SQL Editor,
-- after supabase/setup.sql. Safe to run more than once.
--
-- Customers get a secret cancel_token when they book. Anyone holding the token can
-- look up and cancel that one booking, through two functions. The bookings table
-- itself stays closed: the public site can insert rows but never read or update them.

-- 1. Cancel token --------------------------------------------------------------
-- Existing rows get a token too (the default is evaluated per row).
alter table public.bookings
  add column if not exists cancel_token uuid not null default gen_random_uuid();

create unique index if not exists bookings_cancel_token_key
  on public.bookings (cancel_token);

-- 2. Double-booking rule: only active (non-cancelled) bookings count ---------------
-- A cancelled slot can be booked again. "is distinct from" also treats a NULL status
-- as active, so a row with no status can never slip past the rule.
drop index if exists public.bookings_one_active_per_barber_time;
create unique index bookings_one_active_per_barber_time
  on public.bookings (barber, appointment_time)
  where status is distinct from 'cancelled';

-- 3. Taken slots view: ignore cancelled bookings ----------------------------------
create or replace view public.taken_slots as
  select barber, appointment_time
  from public.bookings
  where status is distinct from 'cancelled';

grant select on public.taken_slots to anon;

-- 4. Look up and cancel by token --------------------------------------------------
-- SECURITY DEFINER = runs with the owner's rights, so these work even though anon
-- has no access to the table. Each one only ever touches the single row whose
-- (unguessable, 122-bit random) token was supplied.

-- Returns just barber, service, appointment_time and status (no name or phone).
-- No match = no rows.
create or replace function public.get_booking(token uuid)
returns table (barber text, service text, appointment_time timestamptz, status text)
language sql
stable
security definer
set search_path = public
as $$
  select b.barber::text, b.service::text, b.appointment_time::timestamptz, b.status::text
  from public.bookings b
  where b.cancel_token = token;
$$;

-- Cancels only if the booking exists, is not already cancelled and is in the future.
-- Returns one of: 'cancelled', 'not_found', 'already_cancelled', 'past'.
create or replace function public.cancel_booking(token uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_time   timestamptz;
begin
  select b.status::text, b.appointment_time::timestamptz
    into v_status, v_time
  from public.bookings b
  where b.cancel_token = token
  for update;                       -- lock the row so two cancels can't race

  if not found then
    return 'not_found';
  end if;
  if v_status is not distinct from 'cancelled' then
    return 'already_cancelled';
  end if;
  if v_time <= now() then
    return 'past';
  end if;

  update public.bookings set status = 'cancelled' where cancel_token = token;
  return 'cancelled';
end;
$$;

revoke all on function public.get_booking(uuid)    from public;
revoke all on function public.cancel_booking(uuid) from public;
grant execute on function public.get_booking(uuid)    to anon, authenticated;
grant execute on function public.cancel_booking(uuid) to anon, authenticated;

-- 5. Keep the table closed ---------------------------------------------------------
-- The public site may only insert (policy from setup.sql). Make sure it cannot
-- read, change or delete rows directly.
revoke select, update, delete on public.bookings from anon;
