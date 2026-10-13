# Blain Hair

Single-page barber booking site: `index.html`, `styles.css`, `script.js` (plus `logo.png`).

## Connecting Supabase

1. In the Supabase SQL Editor, run `supabase/setup.sql`. It adds a unique index (no double bookings), row-level security (the site can create bookings but not read customer details) and a `taken_slots` view used to grey out booked times.
2. In `script.js`, fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API). The anon key is safe to publish; never use the `service_role` key here.
3. Open `index.html` (or serve the folder). With both values empty the site runs in demo mode.
