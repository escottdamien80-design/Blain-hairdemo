-- Blain Hair: barber admin area, part 1 (who is an admin, see all bookings, add a booking by hand).
-- Run once in Supabase → SQL Editor, AFTER setup.sql, cancellation.sql, emails.sql and auth.sql.
-- Safe to run more than once.
--
-- What this does:
--   • an `admins` table: only emails listed there are admins (as many as you like)
--   • an admin can READ every booking (a row-level-security policy that checks the admins table)
--   • an admin can ADD a booking for a phone / walk-in customer (admin_create_booking), with the same
--     double-booking protection as normal bookings
--   • cancelling uses the EXISTING cancel_booking(token) function, so the slot is freed and the
--     "Booking cancelled" email is sent exactly as before
-- Customers and guests get nothing new: they still read only their own bookings, and cannot see the
-- admins table or call the admin functions.
--
-- ► TO MAKE YOURSELF AN ADMIN (run this one line, with your own email and barber name):
--
--     insert into public.admins (email, barber_name) values ('you@example.com', 'Matty');
--
--   To remove an admin:   delete from public.admins where email = 'you@example.com';
--   Emails are matched ignoring upper/lower case. You must sign in on the site with that email.

-- 0. Stop early if the earlier scripts haven't been run ------------------------------------
do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'public.bookings does not exist. Run setup.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'bookings' and column_name = 'cancel_token') then
    raise exception 'bookings.cancel_token is missing. Run cancellation.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'bookings' and column_name = 'customer_email') then
    raise exception 'bookings.customer_email is missing. Run emails.sql first.';
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'bookings' and policyname = 'Customers read their own bookings') then
    raise exception 'Run auth.sql first (it sets up the customer rules this script builds on).';
  end if;
end $$;

-- 1. The admins table ---------------------------------------------------------------------
create table if not exists public.admins (
  email       text primary key,
  barber_name text,
  created_at  timestamptz not null default now()
);

-- one row per person, however the email was typed
create unique index if not exists admins_email_lower_key on public.admins (lower(btrim(email)));

-- Locked down completely: no policies and no grants, so the website can never read or change
-- it. Only you (in the SQL editor) can add or remove admins.
alter table public.admins enable row level security;
revoke all on public.admins from public, anon, authenticated;

-- 2. "Is the signed-in person an admin?" ----------------------------------------------------
-- SECURITY DEFINER so it can read the locked admins table. Only a CONFIRMED sign-in email counts
-- (the customer has clicked the emailed link), and guests (no sign-in) are never admins.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins a
    join auth.users u on lower(btrim(u.email)) = lower(btrim(a.email))
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
  );
$$;

-- The site asks this to decide whether to show the Admin link: one row for an admin, none for
-- anybody else. It only ever describes the caller.
create or replace function public.admin_me()
returns table (email text, barber_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.email::text, a.barber_name::text
  from public.admins a
  join auth.users u on lower(btrim(u.email)) = lower(btrim(a.email))
  where u.id = (select auth.uid())
    and u.email_confirmed_at is not null
  limit 1;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.admin_me() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_me() to authenticated;

-- 3. Admins can read every booking ----------------------------------------------------------
-- Added next to the customer policy ("their own bookings"): Postgres lets a row through if ANY
-- select policy allows it, so customers are unchanged and admins additionally see everything.
drop policy if exists "Admins read all bookings" on public.bookings;
create policy "Admins read all bookings"
  on public.bookings for select
  to authenticated
  using ((select public.is_admin()));

grant select on public.bookings to authenticated;

-- 4. Add a booking by hand (phone / walk-in customers) ----------------------------------------
-- Returns one of: 'created', 'taken', 'past', 'invalid_barber', 'invalid_service', 'invalid_time',
-- 'invalid_name', 'invalid_phone', 'invalid_email'. A caller who is not an admin gets an error.
--
-- p_token is a random id made by the page for this one attempt. If the connection drops and the page
-- sends the same request again, the booking is NOT made twice: the repeat is recognised and answers
-- 'created'. Double bookings are stopped by the same unique index as normal bookings (one active
-- booking per barber per time), plus a check up front that ignores upper/lower case in the barber name.
-- The confirmation email (when an email is given) is sent by the existing booking trigger.
create or replace function public.admin_create_booking(
  p_barber  text,
  p_service text,
  p_time    timestamptz,
  p_name    text,
  p_phone   text,
  p_email   text default null,
  p_token   uuid default gen_random_uuid()
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barber  text := btrim(coalesce(p_barber, ''));
  v_service text := btrim(coalesce(p_service, ''));
  v_name    text := btrim(coalesce(p_name, ''));
  v_phone   text := btrim(coalesce(p_phone, ''));
  v_email   text := nullif(btrim(coalesce(p_email, '')), '');
  v_token   uuid := coalesce(p_token, gen_random_uuid());
begin
  if not (select public.is_admin()) then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if char_length(v_barber) not between 1 and 40 then return 'invalid_barber'; end if;
  if char_length(v_service) not between 1 and 60 then return 'invalid_service'; end if;
  if p_time is null or p_time > now() + interval '366 days' then return 'invalid_time'; end if;
  if char_length(v_name) not between 1 and 80 then return 'invalid_name'; end if;
  if char_length(v_phone) not between 6 and 30 then return 'invalid_phone'; end if;
  if v_email is not null
     and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return 'invalid_email';
  end if;

  -- The same request arriving twice (slow connection, double tap): already saved, so say so.
  if exists (select 1 from public.bookings b
             where b.cancel_token = v_token
               and b.status is distinct from 'cancelled'
               and b.appointment_time = p_time
               and lower(b.barber) = lower(v_barber)) then
    return 'created';
  end if;

  if p_time <= now() then return 'past'; end if;

  if exists (select 1 from public.bookings b
             where lower(b.barber) = lower(v_barber)
               and b.appointment_time = p_time
               and b.status is distinct from 'cancelled') then
    return 'taken';
  end if;

  begin
    insert into public.bookings
      (barber, customer_name, service, appointment_time, customer_phone, customer_email, status, cancel_token)
    values
      (v_barber, v_name, v_service, p_time, v_phone, v_email, 'confirmed', v_token);
  exception when unique_violation then
    -- someone else took the slot a split second ago (the unique index decides)
    return 'taken';
  end;

  return 'created';
end;
$$;

revoke all on function public.admin_create_booking(text, text, timestamptz, text, text, text, uuid) from public, anon;
grant execute on function public.admin_create_booking(text, text, timestamptz, text, text, text, uuid) to authenticated;

-- 5. Tell the API about the new table, functions and policy ------------------------------------
notify pgrst, 'reload schema';
