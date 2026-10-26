# Working hours, days off and the week view: setup (beginner steps)

This is **part 2** of the barber admin. Part 1 (`admin.sql`) must already be set up and you must be an admin
(see `ADMIN_SETUP.md`). You only do the steps below **once**. It takes about two minutes.

You don't need to install anything or change any settings. It is copy, paste, click Run.

## Step 1: Open the SQL Editor in Supabase

1. Go to **supabase.com** and sign in.
2. Click your project (the Blain Hair one).
3. In the menu down the left-hand side, click **SQL Editor** (the icon that looks like `>_`).
4. Click **+ New query** (top left of the editor). You get an empty white box.

## Step 2: Copy the SQL

1. On GitHub, open the file **`supabase/hours.sql`** in this project.
2. Click the **Copy raw file** button (the two overlapping squares, top right of the file).

   *Or:* click inside the file, press **Ctrl+A** (Cmd+A on a Mac) to select everything, then **Ctrl+C** (Cmd+C) to copy.

## Step 3: Paste it and Run

1. Click inside the empty box in Supabase and press **Ctrl+V** (Cmd+V) to paste.
2. Click the green **Run** button (bottom right). Wait a second or two.
3. You should see **"Success. No rows returned"** underneath. That's it, it worked.

> **You see a red error instead?** Read the message, it says what to do:
>
> | The message says | What to do |
> |---|---|
> | `Run admin.sql first` | Run `supabase/admin.sql` the same way (steps 2 and 3 with that file), then run `hours.sql` again. |
> | `public.bookings does not exist` or `cancel_token is missing` | The earlier set-up files weren't run. Run them in this order, one at a time: `setup.sql`, `cancellation.sql`, `emails.sql`, `auth.sql`, `admin.sql`, then `hours.sql`. |
> | anything else | Take a screenshot of the message and send it over. Running `hours.sql` twice is always safe. |

## Step 4: Check it (optional)

Click **Table Editor** in the left menu. You should now see two new tables: **`barber_hours`** and **`barber_exceptions`**. They start empty. That's right.

## Step 5: Set the hours

1. Open the admin page on your phone (`admin.html`) and sign in as usual.
2. Tap the **Hours** tab. Pick **Matty** or **Alfie**.
3. For each day, tap **Working / Day off**, choose the start and end times, and tap **+ Add a break** if there's a lunch break.
4. Tap **Save hours** at the bottom. You'll see a green confirmation.

Until you save hours for a barber, customers keep seeing **09:00 to 18:00 every day** for that barber, exactly as before, so nothing breaks while you set things up.

## If you ever re-run `admin.sql`

Run **`hours.sql` again straight afterwards**. (`admin.sql` contains an older copy of the "Add booking" function, and `hours.sql` puts the working-hours check back.)

## How it works, in plain words

- **Appointments are 30 minutes.** A time is offered only if the whole 30 minutes fits inside working hours, doesn't touch the break, and doesn't touch blocked time.
- **Hours are a weekly pattern** (Monday to Sunday) that repeats every week, so there's no "copy last week" to do: set it once. Use **Use Monday's hours Mon-Fri** and **Copy Alfie's hours** to fill in the week quickly.
- **Days off and extra hours** are one-offs for a particular date: block a whole day (or a run of days for a holiday) or a few hours, or open extra hours on a day off. If a block and extra hours overlap, the block wins.
- **Existing bookings are never touched.** If you block a time, or shorten the hours, over bookings that already exist, you get a clear warning listing them, and they stay booked. You then ring those customers yourself. Bookings that sit outside the hours are marked on the Day list and in the Week view so you can spot them.
- **Times are UK time**, including when the clocks change.
- **Customers** pick a day (next 7 days) and then a time. Only open times are offered. A time that's taken shows struck through.
- If someone's page is out of date and they try to book a time that has just been blocked, the booking is refused with a friendly message. Nothing is saved.

## Who can do what

- Only admins can read or change hours and days off (checked by the database, same as part 1).
- Customers and guests can only ask "which times are bookable?", which returns times and nothing else: no names, phone numbers or emails.
