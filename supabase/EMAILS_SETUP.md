# Booking confirmation emails: setup (Supabase dashboard only, no command line)

You'll set up four things: **Resend** (sends the emails), **a database change**, **a function**
(builds and sends the email) and **a webhook** (tells the function when a booking is made or cancelled).
Allow about 20 minutes. Do the steps in order.

> **Read this first: the testing limit.** Until you verify your own domain in Resend, emails sent from
> `onboarding@resend.dev` are **only delivered to the email address you signed up to Resend with**.
> So while testing, book using *that* email address. Real customers won't get emails until you do the
> "Later: send to real customers" step at the bottom.

---

## Step 1: Get a Resend API key

1. Go to <https://resend.com> and sign up (use the email address you'll test with).
2. In Resend, open **API Keys** → **Create API Key**.
3. Name it `blain-hair`, set **Permission** to **Sending access**, click **Add**.
4. **Copy the key now** (it starts with `re_`) and paste it somewhere safe. Resend only shows it once.

Never paste this key into the website or into GitHub. It only goes into Supabase (Step 4).

## Step 2: Add the email column to the database

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/emails.sql` from this project, copy everything, paste it in, click **Run**.
3. You should see "Success. No rows returned".

## Step 3: Create the function

1. In Supabase, open **Edge Functions** in the left menu → **Deploy a new function** → **Via Editor**.
2. Rename the function (top left of the editor) to exactly: `booking-emails`
3. Delete all the example code in the editor.
4. Open `supabase/functions/booking-emails/index.ts` from this project (on GitHub use the **Copy raw file**
   button), copy everything, and paste it into the editor.
5. Click **Deploy function**. Wait for "Deployed".
6. Open the function → **Details** tab → switch **Verify JWT** to **OFF** → **Save changes**.
   (Why: the function is protected by your own secret instead, set up in Steps 4 and 5. Without this the
   webhook can fail with "401 Invalid JWT".)

## Step 4: Add the secrets

1. In **Edge Functions**, open **Secrets** (left side or top tab).
2. Add these three, one per row, then click **Save**:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | the `re_...` key from Step 1 |
| `WEBHOOK_SECRET` | a long random password (see below) |
| `SITE_URL` | your website address, e.g. `https://yourname.github.io/Blain-hairdemo/` |

**To make `WEBHOOK_SECRET`:** go to **SQL Editor** → New query, run
`select replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');`
and copy the long result. **Keep a copy: you need the same value again in Step 5.**

`SITE_URL` is the address people type to open your booking site. The "Manage my booking" button in the
email is built from it (`SITE_URL` + `?booking=` + the customer's code).

## Step 5: Create the webhook

1. In Supabase, open **Database** → **Webhooks** (in newer dashboards: **Integrations** → **Database Webhooks**).
   If you see an **Enable webhooks** button, click it first.
2. Click **Create a new hook** and fill it in:
   - **Name:** `booking-emails`
   - **Table:** `public.bookings`
   - **Events:** tick **Insert** and **Update** (leave Delete unticked)
   - **Type of webhook:** **Supabase Edge Functions**
   - **Edge Function:** `booking-emails`, **Method:** `POST`
   - **HTTP Headers:** click **Add a new header**: name `x-webhook-secret`, value = the **same** `WEBHOOK_SECRET`
     you made in Step 4. Leave the other headers as they are.
3. Click **Create webhook**.

## Step 6: Put the new booking form live

The website needs the new version (with the Email box). Merge the pull request for this change on GitHub
and wait for your site to update. (The site works either way: if the SQL is missing it still saves the booking.)

## Step 7: Test it

1. Open your booking site, make a booking and use **your Resend sign-up email** in the Email box.
2. Within a few seconds you should get **"Booking confirmed – Blain Hair"** (check spam the first time).
   Click **Manage my booking**, then cancel the booking.
3. You should then get **"Booking cancelled – Blain Hair"**.

### If no email arrives

Look at the function's logs first: **Edge Functions → booking-emails → Logs**.

| What you see | What it means / what to do |
| --- | --- |
| Nothing at all in the logs | The webhook isn't firing. Re-check Step 5 (table `public.bookings`, Insert + Update ticked, function chosen). |
| `401` / `unauthorized` | The `x-webhook-secret` header doesn't match `WEBHOOK_SECRET`. Re-paste both (no spaces). |
| `401 Invalid JWT` | Step 3.6: switch **Verify JWT** off. |
| `WEBHOOK_SECRET is not set` / `RESEND_API_KEY is not set` | A secret is missing or misspelled in Step 4. If you just added it, redeploy the function. |
| `Resend rejected ... 403 ... You can only send testing emails to your own email address` | Expected until your domain is verified. Book with your Resend sign-up email. |
| `skipped: booking has no valid customer_email` | The booking had no email (made before this change, or the SQL in Step 2 wasn't run). |
| `Sent "confirmed" email` but nothing in your inbox | Check spam. In Resend, open **Emails** to see its delivery status. |

To see what the webhook itself received, run this in the SQL Editor:
`select status_code, content::text, created from net._http_response order by created desc limit 5;`

## Later: send to real customers

1. In Resend open **Domains** → **Add Domain**, add the DNS records it shows at wherever you bought your
   domain, then click **Verify**.
2. In Supabase **Edge Functions → Secrets**, add `FROM_EMAIL` = `Blain Hair <bookings@yourdomain.com>`
   (use your own domain). No code change is needed.

## Good to know

- The function only emails when a booking is **created** or its status **changes to cancelled**. Other
  edits to a booking send nothing.
- Times in emails are always shown in **UK time** (GMT/BST).
- Customer emails are private: the website can't read them back, and the cancel lookup doesn't return them.
- Anyone can type any email address into the booking form, so someone could make a booking that sends a
  confirmation to an address that isn't theirs. For a small shop that's low risk, but if it ever becomes a
  problem, add rate limiting or an email-verification step.
