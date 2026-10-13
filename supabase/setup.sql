-- Blain Hair booking setup. Run once in Supabase → SQL Editor.
-- Assumes public.bookings has: barber, customer_name, service,
-- appointment_time (timestamptz), customer_phone, status.

-- 1. Stop double bookings: one active booking per barber per time.
--    This is enforced by the database, so it holds even if two people
--    click the same slot at the same moment.
create unique index if not exists bookings_one_active_per_barber_time
  on public.bookings (barber, appointment_time)
  where coalesce(status, '') <> 'cancelled';

-- 2. Row-level security: the public site may create bookings but never read them,
--    so customer names and phone numbers stay private.
alter table public.bookings enable row level security;

drop policy if exists "Anyone can create a booking" on public.bookings;
create policy "Anyone can create a booking"
  on public.bookings for insert
  to anon
  with check (
    status = 'confirmed'
    and char_length(customer_name) between 1 and 80
    and char_length(customer_phone) between 6 and 30
    and appointment_time > now()
  );

grant insert on public.bookings to anon;

-- 3. A read-only view with just barber + time, which is all the site needs to
--    grey out taken slots. (Views run with their owner's rights, so this works
--    even though anon cannot read the bookings table directly.)
create or replace view public.taken_slots as
  select barber, appointment_time
  from public.bookings
  where coalesce(status, '') <> 'cancelled';

grant select on public.taken_slots to anon;
