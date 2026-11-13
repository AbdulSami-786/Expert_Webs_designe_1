# Connecting the dashboard to Google Sheets

The dashboard runs out of the box on local browser storage, so you can use it
immediately. Follow this guide when you want your real data stored in Google
Sheets, as described in the PRD.

Budget about 15 minutes. You do this once.

---

## Step 1 — Create the spreadsheet

1. Go to [sheets.new](https://sheets.new) to create a blank spreadsheet.
2. Name it something you will recognise, for example `Expert Webs Designs Data`.
3. Leave it open.

## Step 2 — Add the backend script

1. In that spreadsheet, click **Extensions → Apps Script**.
2. Delete whatever is in the editor (usually an empty `myFunction`).
3. Open `Code.gs` from this folder, copy all of it, and paste it in.
4. Click the save icon.
5. Rename the project to `EWD Dashboard Backend` (click "Untitled project" at the top).

## Step 3 — Create the sheet tabs

1. In the Apps Script editor, pick **`setup`** from the function dropdown at the top.
2. Click **Run**.
3. Google asks for permission the first time. Click **Review permissions**, choose
   your account, click **Advanced**, then **Go to (project name) (unsafe)**, then **Allow**.
   This warning is normal for your own scripts. You are granting your script access
   to your own spreadsheet.
4. When it finishes, switch back to the spreadsheet. Every tab now exists with its
   header row.

You may see a popup confirming setup, or you may just see the result in the
execution log at the bottom of the editor. Both mean it worked. Google only
allows popups when the script runs with the sheet open in front of it.

**To check it all wired up correctly**, pick **`healthCheck`** from the function
dropdown and click **Run**. Read the execution log: it names your spreadsheet,
confirms all tabs exist, and reports whether settings read back correctly.

## Step 4 — Deploy as a Web App

1. Back in the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: `EWD Dashboard API`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
4. Click **Deploy**.
5. Copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfy..../exec`.

### About that URL

**Who has access: Anyone** is required — Apps Script cannot answer the browser's
CORS preflight for a deployment restricted to signed-in Google users, so the
dashboard could not call it at all. It means anyone who has the URL can *send a
request* to your backend.

What protects your data is that **every action except signing in requires a valid
session token**, which the backend issues only after a correct username and
password, and which expires after 12 hours. A caller with the URL but no token
gets `Your session has expired. Please sign in again.` and nothing else — no
bills, no parties, no totals.

The one deliberate exception is a **party ledger share link**, which is meant to
be opened by a customer who has no dashboard account. It needs both its own
unguessable token and the password you set when you created it, and it shows only
that one party's own ledger.

**Still do not post the URL publicly.** It is not a password, but it is the
address of your business's data, and there is no reason for strangers to have it.

## Step 5 — Point the dashboard at it

Open `src/lib/config.js` in the project and change two lines:

```js
export const CONFIG = {
  backend: 'sheets',                                          // was 'local'
  appsScriptUrl: 'https://script.google.com/macros/s/AKfy..../exec',  // your URL
  ...
};
```

Save, then restart the dev server (`npm run dev`).

## Step 6 — Sign in and secure it

1. Log in with **admin** / **admin123**.
2. Go to **Settings → Change Password** and set a real password immediately.
3. Turn on **2-Step Verification** on the Google account that owns the spreadsheet.
   That account is the real security perimeter, not the dashboard login. Anyone
   who gets into it could open the spreadsheet directly.

---

## Recommended: nightly automatic backups

The script includes a `nightlyBackup` function that copies the whole spreadsheet
to a dated file in Drive and keeps the last 30 copies.

1. In the Apps Script editor, click the clock icon (**Triggers**) in the left sidebar.
2. Click **Add Trigger**.
3. Set: function `nightlyBackup`, event source **Time-driven**, type **Day timer**,
   and pick a time when the shop is closed.
4. Click **Save**.

You now have a backup even on days you forget to click Download Backup.

---

## Working offline and syncing to the Sheet

There are two ways to run the dashboard, and they suit different shops.

**`backend: 'sheets'`** — every action writes straight to the Google Sheet. The
Sheet is always current, but each save needs internet. Best where the connection
is reliable.

**`backend: 'local'` plus sync** — every action saves to the device first, so
billing is instant and a dropped connection changes nothing. Whenever there is
internet, the records upload to the Sheet on their own: after each save, on
reconnect, and on a slow timer. Best where the internet comes and goes.

To use the second mode:

1. Keep `backend: 'local'` in `src/lib/config.js`, with `appsScriptUrl` set to
   your deployed Web App.
2. Make sure your Apps Script has the `syncPush` action — it is in the current
   `Code.gs`. If you deployed before syncing existed, paste the new `Code.gs`
   in and redeploy (see **Updating the backend later** below).
3. Put the Sheet's login in `sheetsAuth` in the same file:

```js
export const CONFIG = {
  backend: 'local',
  appsScriptUrl: 'https://script.google.com/macros/s/AKfy..../exec',
  sheetsAuth: { username: 'admin', password: 'your-sheet-password' },
};
```

That is the whole setup. The dashboard connects on its own, and nobody is shown
a sync login. **Settings → Google Sheets Sync** just reports how many records
are waiting and when the last upload ran; pressing **Sync now** is never
required, it only does immediately what would happen anyway.

> **What putting the password here costs you.** It is compiled into the
> dashboard's JavaScript, so anyone who can open the dashboard can read it and
> reach the Sheet directly. That is the price of having no login on screen.
> Keep the dashboard off the public internet — a shop PC or a private host —
> and never reuse that password anywhere else. If you would rather not ship a
> password at all, leave `sheetsAuth` out: sync then stays off, everything is
> still saved on the device, and you can export a backup from Settings instead.

### Why it cannot duplicate or lose a bill

Records keep the id the device gave them, and the Sheet stores that same id.
Uploading is an *upsert*: an id already in the Sheet is updated in place, never
added a second time. So syncing twice, or syncing a day that was half-uploaded
when the connection dropped, is harmless.

A record is only marked as synced once the Sheet confirms it in that same
response. Anything rejected or lost in transit stays pending and goes again on
the next sync.

If both sides changed the same record, the more recently edited version wins and
the other is reported rather than silently discarded. One case is handled
specially: bill numbers are allocated independently on each side, so a bill
created offline can arrive holding a number the Sheet already used. The bill is
still saved — never dropped — under the next free number, and both the dashboard
and the Sheet are updated to show it.

### Checking that sync really works

```bash
node tests/sync-live.mjs <sheet-username> <sheet-password>
```

This writes a test party named `ZZ Sync Test …` to your real Sheet, pushes it
twice, and confirms only one row exists. Archive or delete that row afterwards.
If it reports `syncPush is deployed: FAIL`, your deployment predates syncing —
redeploy as described below.

---

## Updating the backend later

If `Code.gs` changes, paste the new version in, then **Deploy → Manage deployments
→ edit (pencil) → Version: New version → Deploy**. The URL stays the same, so you
do not need to touch `config.js` again.

Creating a *new deployment* instead gives you a *new URL* and leaves the old one
live. That is usually not what you want.

---

## If something goes wrong

**"No Apps Script URL configured"**
`appsScriptUrl` in `src/lib/config.js` is empty, or `backend` is still `'local'`.

**Requests fail or hang**
Open the Web app URL directly in a browser. You should see
`{"ok":true,"data":{"status":"Expert Webs Designs backend is running"}}`.
If you see a login page instead, the deployment's **Who has access** is not
set to **Anyone**. Redeploy with that corrected.

**"Your session has expired. Please sign in again." right after updating Code.gs**
Sessions are stored by the script, and pasting in a new version can clear them.
Sign in again and it will not recur. If it happens on *every* action, check that
you deployed a **New version** rather than editing the file without deploying —
the live deployment can otherwise be running older code than you are looking at.

**"Too many failed attempts. Try again in N seconds."**
Five wrong passwords in a row on the same username locks that name for a minute.
This is deliberate, it is per-username, and it clears itself — just wait.

**"System busy, please try again"**
Two writes collided and the lock timed out. This is the concurrency protection
working as intended. Retry the action.

**Everything is slow on the first request of the day**
Apps Script cold start. It costs a second or two once, then it is fast. This is
normal and not fixable.

**"Cannot call SpreadsheetApp.getUi() from this context"**
Harmless, and fixed in the current `Code.gs`. It meant only that the confirmation
popup could not be shown; the setup work itself had already completed. If you see
it, you are running an older copy of the file. Paste in the latest and it will not
recur.

**"this script is not bound to a spreadsheet" from healthCheck**
Your Apps Script project is standalone rather than attached to the sheet, so it
cannot read or write any data. Open your Google Sheet, choose
**Extensions → Apps Script**, and paste the code into that project instead. Then
deploy from there and update `appsScriptUrl` with the new URL.

**You want to start over**
Delete all tabs except one, then run `setup` again.
