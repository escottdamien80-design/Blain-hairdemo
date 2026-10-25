-- Just enough of Supabase for the real SQL files in supabase/ to run on plain Postgres:
-- the two API roles, auth.users + auth.uid(), a stand-in for pg_net, and Supabase's default
-- "everything is granted to anon/authenticated" table privileges (the worst case the scripts must cope with).
create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- pg_net stand-in: remember every email request instead of sending it
create schema net;
create table net.calls (id serial primary key, url text, body jsonb);
create function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)
  returns bigint language sql as
  $$ insert into net.calls (url, body) values (url, body) returning id::bigint $$;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;

-- the table the project already had before any of the scripts ran
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  barber text,
  customer_name text,
  service text,
  appointment_time timestamptz,
  customer_phone text,
  status text
);
