-- Blain Hair: barber admin, part 2 (working hours, days off / extra hours, and bookable times).
-- Run once in Supabase → SQL Editor, AFTER admin.sql (and the scripts before it). Safe to run more than once.
-- Step-by-step instructions for beginners: supabase/HOURS_SETUP.md
--
-- What this does:
--   • barber_hours      each barber's weekly schedule: for Mon–Sun working or not, start/end, optional break
--   • barber_exceptions one-off changes: block a whole day (or several days) or a time range ("off"),
--                       or open extra hours on one date ("extra")
--   • bookable_slots()  the ONE place that works out which times can be booked. The customer page and the
--                       admin "Add booking" form both ask it. It returns times only, never customer details.
--   • admin_set_hours / admin_add_exception / admin_remove_exception: admin-only writes (checked against
--     the admins table). Nothing here ever cancels or changes a booking.
--   • a safety check on new bookings: once a barber HAS hours, a booking outside them is refused
--     (a barber with no hours yet keeps working exactly as before: 09:00–18:00 every 30 minutes).
--
-- Rules, in plain words:
--   • Appointments are 30 minutes. A start time is offered when the whole 30 minutes fits inside working
--     hours, does not touch the break, and does not touch blocked time. Blocked time always wins.
--   • "Extra hours" on a date add open time (even on a day off). A "block" removes time again.
--   • All days and times are UK time (Europe/London), including when the clocks change.
--   • A barber with NO hours saved yet: 09:00 to 18:00 (last start 18:00) every day, as before.

-- 0. Stop early if the earlier scripts haven't been run ------------------------------------
do $$
begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run admin.sql first (it creates the admins table this script uses).';
  end if;
  if to_regclass('public.bookings') is null then
    raise exception 'public.bookings does not exist. Run setup.sql first.';
  end if;
end $$;

-- 1. Weekly hours ------------------------------------------------------------------------------
-- weekday: 1 = Monday ... 7 = Sunday.  Times are UK wall-clock times on :00 or :30.
-- A day that is not working may still remember its times (so switching it back on is one tap).
create table if not exists public.barber_hours (
  barber       text     not null,
  weekday      smallint not null check (weekday between 1 and 7),
  working      boolean  not null default true,
  start_time   time,
  end_time     time,
  break_start  time,
  break_end    time,
  primary key (barber, weekday),
  constraint barber_hours_aligned check (
    (start_time  is null or (extract(minute from start_time)::int % 30 = 0 and extract(second from start_time) = 0)) and
    (end_time    is null or (extract(minute from end_time)::int % 30 = 0 and extract(second from end_time) = 0)) and
    (break_start is null or (extract(minute from break_start)::int % 30 = 0 and extract(second from break_start) = 0)) and
    (break_end   is null or (extract(minute from break_end)::int % 30 = 0 and extract(second from break_end) = 0))
  ),
  constraint barber_hours_working_ok check (
    not working or (start_time is not null and end_time is not null and start_time < end_time)
  ),
  constraint barber_hours_break_ok check (
    (break_start is null and break_end is null)
    or (working and break_start is not null and break_end is not null
        and start_time < break_start and break_start < break_end and break_end < end_time)
  )
);
create unique index if not exists barber_hours_barber_lower_key on public.barber_hours (lower(barber), weekday);

-- 2. One-off changes -----------------------------------------------------------------------------
--   kind 'off'   + no times   = whole day(s) off, from date_from to date_to inclusive
--   kind 'off'   + times      = that time range off, on one date
--   kind 'extra' + times      = extra open hours on one date
create table if not exists public.barber_exceptions (
  id          uuid primary key default gen_random_uuid(),
  barber      text not null,
  kind        text not null check (kind in ('off', 'extra')),
  date_from   date not null,
  date_to     date not null,
  start_time  time,
  end_time    time,
  note        text,
  created_at  timestamptz not null default now(),
  constraint barber_exceptions_dates check (date_to >= date_from and date_to - date_from <= 62),
  constraint barber_exceptions_times_pair check ((start_time is null) = (end_time is null)),
  constraint barber_exceptions_times_ok check (
    start_time is null
    or (start_time < end_time and date_from = date_to
        and extract(minute from start_time)::int % 30 = 0 and extract(second from start_time) = 0
        and extract(minute from end_time)::int % 30 = 0 and extract(second from end_time) = 0)
  ),
  constraint barber_exceptions_extra_has_times check (kind <> 'extra' or start_time is not null),
  constraint barber_exceptions_note_len check (note is null or char_length(note) <= 80)
);
create index if not exists barber_exceptions_lookup on public.barber_exceptions (lower(barber), date_from, date_to);

-- 3. Locked down: only admins can READ the two tables, and nobody can write to them directly ---
-- (Supabase hands new tables to the website's roles by default, so take that away first.)
alter table public.barber_hours enable row level security;
alter table public.barber_exceptions enable row level security;
revoke all on public.barber_hours from public, anon, authenticated;
revoke all on public.barber_exceptions from public, anon, authenticated;
grant select on public.barber_hours to authenticated;
grant select on public.barber_exceptions to authenticated;

drop policy if exists "Admins read hours" on public.barber_hours;
create policy "Admins read hours" on public.barber_hours for select to authenticated
  using ((select public.is_admin()));
drop policy if exists "Admins read exceptions" on public.barber_exceptions;
create policy "Admins read exceptions" on public.barber_exceptions for select to authenticated
  using ((select public.is_admin()));

-- 4. Does this barber have hours yet? ------------------------------------------------------------
create or replace function public.barber_has_hours(p_barber text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.barber_hours h where lower(h.barber) = lower(btrim(p_barber)));
$$;

-- 5. The start times a barber is open on one UK date (before looking at bookings or the clock) ---
-- Returns UK wall-clock timestamps (no time zone). 30-minute appointments; see the rules at the top.
create or replace function public.schedule_starts(p_barber text, p_day date)
returns table (local_start timestamp)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_barber     text := lower(btrim(p_barber));
  v_configured boolean := exists (select 1 from public.barber_hours h where lower(h.barber) = lower(btrim(p_barber)));
  v_work       boolean := false;
  v_start      time;
  v_end        time;
  v_bs         time;
  v_be         time;
  v_row        public.barber_hours;
begin
  if v_configured then
    select * into v_row from public.barber_hours h
      where lower(h.barber) = v_barber and h.weekday = extract(isodow from p_day)::int;
    if found and v_row.working then
      v_work := true; v_start := v_row.start_time; v_end := v_row.end_time;
      v_bs := v_row.break_start; v_be := v_row.break_end;
    end if;
  else
    -- no hours saved yet: the original grid, 09:00 to 18:00 inclusive, every day
    v_work := true; v_start := '09:00'; v_end := '18:30';
  end if;

  return query
  with cand as (
    select gs as s
    from generate_series(p_day + v_start, p_day + v_end - interval '30 minutes', interval '30 minutes') gs
    where v_work
      and not (v_bs is not null and gs < p_day + v_be and gs + interval '30 minutes' > p_day + v_bs)
    union
    select gs
    from public.barber_exceptions x,
         generate_series(p_day + x.start_time, p_day + x.end_time - interval '30 minutes', interval '30 minutes') gs
    where x.kind = 'extra' and lower(x.barber) = v_barber and p_day between x.date_from and x.date_to
  )
  select c.s
  from cand c
  where not exists (
    select 1 from public.barber_exceptions x
    where x.kind = 'off' and lower(x.barber) = v_barber and p_day between x.date_from and x.date_to
      and (x.start_time is null
           or (c.s < p_day + x.end_time and c.s + interval '30 minutes' > p_day + x.start_time))
  )
  order by c.s;
end;
$$;

-- 6. Is this exact moment inside the barber's hours? (used by the safety checks below) ----------
create or replace function public.slot_is_open(p_barber text, p_time timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.schedule_starts(p_barber, (p_time at time zone 'Europe/London')::date) s
    where s.local_start = (p_time at time zone 'Europe/London')
  );
$$;

-- 7. The bookable times: what the customer page and the admin form ask --------------------------
-- One row per start time in the next p_days days (1 to 31) from p_from (a UK date), with free = false
-- when it is already booked. Past times are left out. Times only: no names, no phone numbers.
create or replace function public.bookable_slots(p_barber text, p_from date, p_days int default 7)
returns table (slot_time timestamptz, free boolean)
language sql
stable
security definer
set search_path = public
as $$
  select (s.local_start at time zone 'Europe/London') as slot_time,
         not exists (
           select 1 from public.bookings b
           where lower(b.barber) = lower(btrim(p_barber))
             and b.appointment_time = (s.local_start at time zone 'Europe/London')
             and b.status is distinct from 'cancelled'
         ) as free
  from generate_series(0, least(greatest(coalesce(p_days, 7), 1), 31) - 1) n
  cross join lateral public.schedule_starts(p_barber, p_from + n) s
  where (s.local_start at time zone 'Europe/London') > now()
  order by 1;
$$;

-- 8. Safety check on new bookings -------------------------------------------------------------------
-- Only for bookings made from the website (guests, customers). Admins' bookings are checked inside
-- admin_create_booking. Barbers without hours are not checked, so nothing changes until hours are saved.
create or replace function public.enforce_booking_hours()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- current_setting('role') is the website role (anon / authenticated) set by the API; inside a
  -- SECURITY DEFINER function current_user would be the owner, so it can't be used here.
  if current_setting('role', true) in ('anon', 'authenticated')
     and public.barber_has_hours(new.barber)
     and not public.slot_is_open(new.barber, new.appointment_time) then
    raise exception 'slot_not_available' using errcode = 'P0001',
      hint = 'That time is outside the barber''s working hours or is blocked.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_booking_hours() from public, anon, authenticated;

drop trigger if exists bookings_enforce_hours on public.bookings;
create trigger bookings_enforce_hours
  before insert on public.bookings
  for each row execute function public.enforce_booking_hours();

-- Admin "Add booking" now follows the hours too (same function as before, plus one check).
-- Barbers with no hours yet are unchanged. New answer: 'closed'.
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

  if public.barber_has_hours(v_barber) and not public.slot_is_open(v_barber, p_time) then
    return 'closed';
  end if;

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
    return 'taken';
  end;

  return 'created';
end;
$$;

-- 9. Admin writes -------------------------------------------------------------------------------------
-- Replace a barber's whole weekly schedule in one go (all or nothing).
-- p_days: a JSON list of 7 objects, one per weekday:
--   {"weekday":1,"working":true,"start":"09:00","end":"18:00","break_start":"12:00","break_end":"13:00"}
-- (break_start / break_end optional; start / end may be given for a day off to remember them).
-- Returns 'saved', or 'invalid_barber' / 'invalid_days' / 'invalid_hours' / 'invalid_break'.
create or replace function public.admin_set_hours(p_barber text, p_days jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barber text := btrim(coalesce(p_barber, ''));
  d        jsonb;
  v_wd     int;
  v_seen   int[] := '{}';
  v_work   boolean;
  v_start  time;
  v_end    time;
  v_bs     time;
  v_be     time;
begin
  if not (select public.is_admin()) then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if char_length(v_barber) not between 1 and 40 then return 'invalid_barber'; end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) <> 7 then return 'invalid_days'; end if;

  -- pass 1: check every day before touching anything
  for d in select * from jsonb_array_elements(p_days) loop
    begin
      v_wd := (d ->> 'weekday')::int;
      v_work := coalesce((d ->> 'working')::boolean, false);
      v_start := nullif(d ->> 'start', '')::time;
      v_end := nullif(d ->> 'end', '')::time;
      v_bs := nullif(d ->> 'break_start', '')::time;
      v_be := nullif(d ->> 'break_end', '')::time;
    exception when others then
      return 'invalid_days';
    end;
    if v_wd is null or v_wd not between 1 and 7 or v_wd = any (v_seen) then return 'invalid_days'; end if;
    v_seen := v_seen || v_wd;
    if not v_work then v_bs := null; v_be := null; end if;   -- a day off has no break
    if v_work and (v_start is null or v_end is null or v_start >= v_end) then return 'invalid_hours'; end if;
    if (v_bs is null) <> (v_be is null) then return 'invalid_break'; end if;
    if v_bs is not null and not (v_work and v_start < v_bs and v_bs < v_be and v_be < v_end) then return 'invalid_break'; end if;
  end loop;

  -- pass 2: replace the schedule (the whole function is one transaction: all or nothing)
  begin
    delete from public.barber_hours where lower(barber) = lower(v_barber);
    for d in select * from jsonb_array_elements(p_days) loop
      v_work := coalesce((d ->> 'working')::boolean, false);
      insert into public.barber_hours (barber, weekday, working, start_time, end_time, break_start, break_end)
      values (
        v_barber, (d ->> 'weekday')::int, v_work,
        nullif(d ->> 'start', '')::time, nullif(d ->> 'end', '')::time,
        case when v_work then nullif(d ->> 'break_start', '')::time end,
        case when v_work then nullif(d ->> 'break_end', '')::time end
      );
    end loop;
  exception when check_violation then
    -- e.g. a time that is not on the hour or half hour; the delete above is undone with it
    return 'invalid_hours';
  end;
  return 'saved';
end;
$$;

-- Block time off ('off') or open extra hours ('extra').
--   off, whole days:  p_from..p_to (inclusive, up to 63 days), p_start and p_end null
--   off, time range:  one date (p_from = p_to), p_start < p_end
--   extra:            one date, p_start < p_end
-- p_id is made by the page for this one attempt, so a repeated request (slow connection) is not saved twice.
-- This NEVER cancels or changes a booking. Returns 'created' or 'invalid_*'.
create or replace function public.admin_add_exception(
  p_id      uuid,
  p_barber  text,
  p_kind    text,
  p_from    date,
  p_to      date,
  p_start   time default null,
  p_end     time default null,
  p_note    text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barber text := btrim(coalesce(p_barber, ''));
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_today  date := (now() at time zone 'Europe/London')::date;
begin
  if not (select public.is_admin()) then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_id is null then return 'invalid_id'; end if;
  if char_length(v_barber) not between 1 and 40 then return 'invalid_barber'; end if;
  if p_kind is null or p_kind not in ('off', 'extra') then return 'invalid_kind'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then return 'invalid_date'; end if;
  if p_to < v_today or p_from > v_today + 366 then return 'invalid_date'; end if;
  if (p_start is null) <> (p_end is null) then return 'invalid_time'; end if;
  if p_start is not null and (p_start >= p_end or p_from <> p_to) then return 'invalid_time'; end if;
  if p_kind = 'extra' and p_start is null then return 'invalid_time'; end if;
  if v_note is not null and char_length(v_note) > 80 then return 'invalid_note'; end if;

  if exists (select 1 from public.barber_exceptions where id = p_id) then
    return 'created';   -- the same request again: already saved
  end if;

  begin
    insert into public.barber_exceptions (id, barber, kind, date_from, date_to, start_time, end_time, note)
    values (p_id, v_barber, p_kind, p_from, p_to, p_start, p_end, v_note);
  exception when check_violation then
    return 'invalid_time';   -- e.g. a time that is not on the hour or half hour
  end;
  return 'created';
end;
$$;

-- Remove a block or extra-hours entry. Returns 'removed' or 'not_found' (already gone = fine).
create or replace function public.admin_remove_exception(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  delete from public.barber_exceptions where id = p_id;
  return case when found then 'removed' else 'not_found' end;
end;
$$;

-- 10. Who may call what -----------------------------------------------------------------------------
revoke all on function public.barber_has_hours(text) from public, anon, authenticated;
revoke all on function public.schedule_starts(text, date) from public, anon, authenticated;
revoke all on function public.slot_is_open(text, timestamptz) from public, anon, authenticated;
revoke all on function public.bookable_slots(text, date, int) from public, anon;
revoke all on function public.admin_set_hours(text, jsonb) from public, anon;
revoke all on function public.admin_add_exception(uuid, text, text, date, date, time, time, text) from public, anon;
revoke all on function public.admin_remove_exception(uuid) from public, anon;
revoke all on function public.admin_create_booking(text, text, timestamptz, text, text, text, uuid) from public, anon;

-- Anyone (guests too) may ask which times are bookable: it returns times only.
grant execute on function public.bookable_slots(text, date, int) to anon, authenticated;
grant execute on function public.admin_set_hours(text, jsonb) to authenticated;
grant execute on function public.admin_add_exception(uuid, text, text, date, date, time, time, text) to authenticated;
grant execute on function public.admin_remove_exception(uuid) to authenticated;
grant execute on function public.admin_create_booking(text, text, timestamptz, text, text, text, uuid) to authenticated;

-- 11. Tell the API about the new tables and functions ---------------------------------------------------
notify pgrst, 'reload schema';
