-- Blain Hair: send booking emails from a database trigger (pg_net → Edge Function).
--
-- Use this INSTEAD of Database → Webhooks (the dashboard webhook form needs a
-- "supabase_functions" schema that your project doesn't have). It does the same job:
--   new booking                → calls the booking-emails function ("Booking confirmed")
--   booking updated (cancelled)→ calls the booking-emails function ("Booking cancelled")
-- and sends the same payload the function expects: type, table, schema, record, old_record.
--
-- BEFORE YOU RUN IT, edit the two lines marked  ▼ EDIT ▼  below:
--   1. YOUR-PROJECT-REF  → your project's reference (the part before .supabase.co)
--   2. PASTE-YOUR-WEBHOOK-SECRET-HERE → the SAME value as the WEBHOOK_SECRET Edge Function secret
-- Safe to run more than once (run it again after changing either value).

-- 0. Check that pg_net is installed ------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    raise exception 'pg_net is not installed. Turn it on under Database → Extensions (search "pg_net"), then run this again.';
  end if;
end $$;

-- 1. The trigger function ----------------------------------------------------------
-- SECURITY DEFINER: it runs with the owner's rights, so a customer booking through the
-- website (the "anon" role, which has no access to pg_net) can still trigger the email.
create or replace function public.notify_booking_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- ▼ EDIT ▼  (keep the quotes and the rest of the line exactly as they are)
  v_url    constant text := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/booking-emails';
  v_secret constant text := 'PASTE-YOUR-WEBHOOK-SECRET-HERE';
  -- ▲ EDIT ▲
  v_old    jsonb := null;
begin
  -- Never send anything from a half-finished setup (and never block a booking because of it).
  if v_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/booking-emails$'
     or length(v_secret) < 16
     or v_secret like 'PASTE%' then
    raise warning 'booking email trigger: project URL / secret not filled in, no email sent';
    return null;
  end if;

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
  end if;

  -- An email problem must NEVER stop a booking or a cancellation from being saved, so any
  -- error here is turned into a warning. (pg_net sends the request after the booking has
  -- been saved; if the booking is rolled back, nothing is sent.)
  begin
    perform net.http_post(
      v_url,
      jsonb_build_object(
        'type',       tg_op,            -- 'INSERT' or 'UPDATE'
        'table',      tg_table_name,    -- 'bookings'
        'schema',     tg_table_schema,  -- 'public'
        'record',     to_jsonb(new),
        'old_record', v_old             -- null for INSERT
      ),
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type',     'application/json',
        'x-webhook-secret', v_secret
      ),
      8000                              -- give up after 8 seconds
    );
  exception when others then
    raise warning 'booking email trigger: could not queue the request (%): %', sqlstate, sqlerrm;
  end;

  return null;  -- AFTER trigger: the return value is ignored
end;
$$;

-- Only the trigger should run this function.
revoke all on function public.notify_booking_email() from public, anon, authenticated;

-- 2. The trigger -------------------------------------------------------------------
drop trigger if exists booking_email_webhook on public.bookings;
create trigger booking_email_webhook
  after insert or update on public.bookings
  for each row
  execute function public.notify_booking_email();

-- 3. Stop here if the two values above were not filled in ------------------------------
-- (Checks the saved function for a real-looking project URL and secret, so it also works
-- if you used Find & Replace.)
do $$
declare
  v_src    text;
  v_url    text;
  v_secret text;
begin
  select prosrc into v_src from pg_proc
  where proname = 'notify_booking_email' and pronamespace = 'public'::regnamespace;
  v_url    := substring(v_src from 'v_url\s+constant text := ''([^'']*)''');
  v_secret := substring(v_src from 'v_secret\s+constant text := ''([^'']*)''');
  if v_url is null or v_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/booking-emails$'
     or v_secret is null or length(v_secret) < 16 or v_secret like 'PASTE%' then
    raise exception 'Almost there: fill in your project reference and your webhook secret on the two lines marked EDIT near the top of this script, then run it again.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- TEST IT (run these one at a time, AFTER the script above succeeded)
-- Use YOUR OWN Resend sign-up email below: with onboarding@resend.dev, Resend only
-- delivers to that address until you verify a domain.
--
--   a) New booking → should send "Booking confirmed":
--        insert into public.bookings
--          (barber, customer_name, service, appointment_time, customer_phone, status, customer_email, cancel_token)
--        values ('Matty', 'Test Customer', 'Haircut', now() + interval '30 days',
--                '07700900123', 'confirmed', 'YOUR-RESEND-SIGNUP-EMAIL', gen_random_uuid());
--
--   b) Cancel it → should send "Booking cancelled":
--        update public.bookings set status = 'cancelled' where customer_name = 'Test Customer';
--
--   c) See what happened (wait ~5 seconds first). status_code 200 = the function accepted it:
--        select id, status_code, content::text, error_msg, created
--        from net._http_response order by created desc limit 5;
--
--   d) Clean up the test row:
--        delete from public.bookings where customer_name = 'Test Customer';
--
-- To remove the email trigger later:
--        drop trigger if exists booking_email_webhook on public.bookings;
