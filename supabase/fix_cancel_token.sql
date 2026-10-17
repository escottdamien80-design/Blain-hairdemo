-- Blain Hair: "booking saves but there is no manage link" fixer.
-- Run each numbered block on its own in Supabase → SQL Editor. (The editor only
-- shows the result of the LAST statement in a run, so keep them separate.)

-- ───────── Block 1: diagnose (read-only) ─────────
-- Expect: column = one row (uuid, NO, gen_random_uuid()), anon_can_insert = true,
--         anon_can_insert_cancel_token = true, both functions with anon_can_execute = true.
select jsonb_build_object(
  'column', (
    select jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type,
                                        'nullable', is_nullable, 'default', column_default))
    from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings' and column_name = 'cancel_token'),
  'anon_can_insert',              has_table_privilege('anon', 'public.bookings', 'insert'),
  'anon_can_insert_cancel_token', has_column_privilege('anon', 'public.bookings', 'cancel_token', 'insert'),
  'anon_can_select_table',        has_table_privilege('anon', 'public.bookings', 'select'),
  'rls_enabled', (select relrowsecurity from pg_class where oid = 'public.bookings'::regclass),
  'policies', (select jsonb_agg(policyname) from pg_policies
               where schemaname = 'public' and tablename = 'bookings'),
  'functions', (
    select jsonb_agg(jsonb_build_object('name', p.proname,
                                        'anon_can_execute', has_function_privilege('anon', p.oid, 'execute')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('get_booking', 'cancel_booking'))
) as report;

-- ───────── Block 2: make sure anon may insert the column ─────────
-- (Harmless if the table-level grant from setup.sql already covers it.)
grant insert on public.bookings to anon;
grant insert (cancel_token) on public.bookings to anon;

-- ───────── Block 3: reload the API's schema cache ─────────
-- The API (PostgREST) caches the table layout. If it hasn't noticed the new column or
-- functions, inserts that include cancel_token fail with PGRST204 and the site
-- falls back to saving the booking without a manage link.
notify pgrst, 'reload schema';
