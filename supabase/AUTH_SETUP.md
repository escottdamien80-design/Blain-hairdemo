# Optional customer sign-in (magic link): setup, Supabase dashboard only

Customers can sign in with just their email: Supabase emails them a one-time link, they click it, and they
are signed in. No passwords. Signing in is **optional**: guests book exactly as before.

A signed-in customer gets:
- **My bookings**: their upcoming bookings (with Cancel) and a smaller, collapsed list of past ones. This
  includes earlier *guest* bookings made with the same email address.
- The booking form **pre-filled** with their name and email.

Allow about 20 minutes. Do the steps in order. (Button names in the dashboard change from time to time; if
something looks slightly different, look for the closest match.)

> **Read this first.** Magic links are emails, and Supabase's built-in email sender is only meant for
> testing: it is heavily rate-limited and may only deliver to people on your Supabase team. To send sign-in
> links to real customers you need to plug in an email provider. You already use **Resend**, so step 6 shows
> how. And the same Resend rule applies as for booking emails: until you verify your own domain in Resend,
> `onboarding@resend.dev` only delivers to **your own Resend sign-up email**. So while testing, sign in with
> that address.

---

## Step 1: Run the SQL

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/auth.sql` from this project, copy everything, paste it in and click **Run**.
3. You should see "Success. No rows returned". It's safe to run again later.

It adds a `user_id` to bookings and the security rules that make sure **a signed-in customer can only ever
read their own bookings**, never anyone else's. Guest booking and the "Manage my booking" links keep working
exactly as before.

## Step 2: Check the sign-in settings

1. Open **Authentication** → **Sign In / Providers** (older dashboards: **Providers**) → **Email**.
2. Make sure these are set:
   - **Enable Email provider**: **ON**
   - **Confirm email**: **ON**. *This one matters for security:* it's what makes sure a customer really owns
     the email address before they can see bookings made with it. Don't switch it off.
   - **Allow new users to sign up** (or "Enable sign ups"): **ON**. Customers don't need to register
     first: their account is created the first time they click a link.
3. Optional but recommended: set **Email OTP Expiration** to `900` (15 minutes) so old links stop working sooner.
4. Click **Save**.

## Step 3: Tell Supabase your website address (Site URL and Redirect URLs)

This is the step most people trip over. After the customer clicks the link in their email, Supabase must
send them **back to your site**. It will only do that to addresses you've allowed.

1. Open **Authentication** → **URL Configuration**.
2. **Site URL**: your site's address, exactly as it appears in your browser, for example
   `https://escottdamien80-design.github.io/Blain-hairdemo/`
   (If you use your own domain, use that instead. Copy it from your browser's address bar.)
3. **Redirect URLs** → **Add URL**, add:
   `https://escottdamien80-design.github.io/Blain-hairdemo/**`
   (the two stars at the end mean "this page and anything under it"). Add one for every address your site
   is served from, e.g. a custom domain later.
4. Click **Save**.

> If you leave the default Site URL (`http://localhost:3000`), the link in the email will take customers to
> a page that doesn't exist. If the redirect address isn't allowed, Supabase quietly falls back to the Site URL.

## Step 4: (Optional) Use your own website address while testing locally

Only if you test on your own computer: also add `http://localhost:8000/**` to **Redirect URLs**.

## Step 5: Make the sign-in email look like Blain Hair

1. Open **Authentication** → **Email Templates** (newer dashboards: **Emails** → **Templates**).
2. Open **Magic link**:
   - **Subject:** `Your Blain Hair sign-in link`
   - **Message (HTML):** delete what's there, then paste in the contents of `supabase/auth_email_template.html`.
   - Leave `{{ .ConfirmationURL }}` exactly as it is: Supabase fills in the real link.
   - Click **Save**.
3. Open **Confirm sign up** and do exactly the same (same subject, same HTML). The first time someone signs
   in, Supabase uses this template instead, so both should match.

## Step 6: Send the emails through Resend (so real customers get them)

1. Open **Authentication** → **SMTP Settings** (older dashboards: **Project Settings** → **Authentication**
   → **SMTP Settings**) and switch **Enable Custom SMTP** on.
2. Fill in:

| Field | Value |
| --- | --- |
| **Sender email** | `onboarding@resend.dev` (change to e.g. `hello@yourdomain.com` once your domain is verified in Resend) |
| **Sender name** | `Blain Hair` |
| **Host** | `smtp.resend.com` |
| **Port** | `465` |
| **Username** | `resend` |
| **Password** | your Resend API key (the same `re_...` key you used for booking emails) |

3. Click **Save**.
4. Open **Authentication** → **Rate Limits** and check **Rate limit for sending emails**. With your own SMTP
   the default is fine for a barber shop (30 per hour). Raise it if you ever need more.

## Step 7: Put the new site live

Merge the pull request for this change on GitHub and wait for your site to update. Until then the site
doesn't show the "Sign in" link.

## Step 8: Test it

1. Open your site. In the top menu click **Sign in**, type **your Resend sign-up email** and click
   **Email me a sign-in link**.
2. Open the email (check spam the first time) and click **Sign in**.
3. You land back on your site, signed in. The menu now shows **My bookings** and **Sign out**, and the page
   scrolls to your bookings.
4. Make a booking: the name and email are filled in for you, and the new booking appears under
   **My bookings** straight away. Try **Cancel** (you'll be asked "Are you sure?").
5. Click **Sign out**. The menu goes back to **Sign in**. Book once as a guest to check that still works.

## If something doesn't work

| What you see | What to do |
| --- | --- |
| No "Sign in" link on the site | The site isn't updated yet (step 7), or the Supabase address/key at the top of `script.js` is empty. |
| "Sorry, we couldn't send the sign-in link" | **Authentication → Logs** shows why. Usually the SMTP settings (step 6): re-check host, port `465`, username `resend`, and the API key as password. |
| "Too many sign-in emails were requested" | Supabase limits how often one email can be asked for a link. Wait a few minutes. |
| The email never arrives | Check spam. With `onboarding@resend.dev`, Resend only delivers to **your own Resend sign-up email**. In Resend open **Emails** to see what happened. |
| The link opens a page that doesn't exist / `localhost` | Step 3: the **Site URL** is wrong. |
| The link opens your site but you're not signed in | The Redirect URL isn't allowed (step 3), or the link was already used or expired. Request a new one: the site opens the sign-in box for you. |
| Signed in, but **My bookings** says it couldn't load | Run `supabase/auth.sql` (step 1), then run `notify pgrst, 'reload schema';` in the SQL Editor. |
| Signed in, but an earlier booking is missing | It was made with a different email, or without one. Only bookings made with the same **verified** email (or while signed in) show up. |

Booking never depends on signing in: if sign-in is misconfigured, guests can still book, and a signed-in
customer's booking is saved as a guest booking rather than lost.

## Good to know

- **Privacy:** a customer can only ever read their own bookings. This is enforced by the database
  (row-level security in `auth.sql`), not by the web page. Someone typing another person's email address
  gets nothing, because they would have to open the link in that person's inbox.
- **Seeing who has signed in:** **Authentication → Users** lists everyone. Deleting a user does **not**
  delete their bookings (they simply become guest bookings).
- **Signing in on a different device** than the one that asked for the link works fine.
- **Cancelling** from My bookings uses exactly the same cancel as the "Manage my booking" link, so the
  customer still gets the "Booking cancelled" email and the slot is freed for others.
