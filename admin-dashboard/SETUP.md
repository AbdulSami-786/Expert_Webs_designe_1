# Admin Dashboard — monthly maintenance control

This folder is **your** tool, separate from the client's dashboard. From here you:

- set each client's **expiry date, day and time**
- **close** a client's dashboard instantly (and re-open it)
- **generate renewal codes** (1, 2, 3, 6 or 12 months) and send them to the client

When the expiry passes, the client's dashboard shows a **black "Your monthly subscription has expired" page** with a box to enter a renewal code. For the last **5 days** (changeable per client) it shows a **popup every time the dashboard is opened**: "Your subscription will expire in just N days", with the same code box and a "Remind me later" button.

```
 Admin Dashboard (this folder)  --->  License server (Google Apps Script, YOUR account)  <---  Client dashboard
   you set dates, make codes             stores clients, expiry, codes                       asks "am I on?" / redeems code
```

The expiry date lives on the license server, not inside the client's program or their Google Sheet, so the client cannot edit it.

## One-time setup

### 1. Create the license server
1. Go to <https://sheets.new> in **your own** Google account and name the sheet `EWD License`.
2. **Extensions > Apps Script**, delete the sample code, paste all of [`license-server/Code.gs`](license-server/Code.gs), save.
3. **Project Settings** (gear icon):
   - set **Time zone** to your local one (e.g. `Asia/Karachi`); month-end maths uses it
4. **Deploy > New deployment > Web app**: *Execute as* **Me**, *Who has access* **Anyone** > Deploy, and authorise when asked.
5. Copy the **Web app URL** (ends in `/exec`). Opening it in a browser should show `license server is running`.

> After any later change to `Code.gs`: **Deploy > Manage deployments > pencil > Version: New version > Deploy** (the URL stays the same).

### 2. Run the admin dashboard
```
cd admin-dashboard
npm install
npm run dev        # http://localhost:5300
```
There is no sign-in screen and no password: it connects straight away. The web app URL (step 1.5) is in `src/config.js`.

There is no password on the license server, so keep the web app URL private: anyone who has it can read the client list or create renewal codes. The client dashboard build contains this URL (so it can check the subscription).

### 3. Add the client and connect their dashboard
1. In the admin dashboard click **Add client**, enter their name, your contact (shown on the expired page) and the first expiry date.
2. Open the client and copy their **Client ID** (like `c_k3m9x2ab`).
3. In the **client dashboard project**, edit `src/lib/config.js`:
   ```js
   const LICENSE_URL = 'https://script.google.com/macros/s/.../exec';   // step 1.5
   const LICENSE_CLIENT_ID = 'c_k3m9x2ab';                              // step 3.2
   ```
4. Rebuild and redeploy the client dashboard (website and/or desktop installer). Until both values are filled in, the client dashboard is never locked.

## Every month

| You want to… | Do this |
|---|---|
| Renew after they pay | Open the client > **Renewal codes** > pick months > **Generate code** > **Copy message for WhatsApp**. They enter it, and the expiry moves forward. |
| Renew without a code | Open the client > **+1 month**, or set an exact date and time > **Save expiry** |
| Stop access now | Open the client > **Close dashboard** (black page at once). **Re-open dashboard** undoes it |
| Cancel an unused code | Renewal codes table > **Cancel code** |

Rules worth knowing:
- A code works **once**, and **only for the client it was made for**.
- Renewing **before** the expiry adds the months on top of the remaining time; renewing **after** gives a full period from today.
- A valid code also re-opens a dashboard that you closed.
- 10 wrong codes in 15 minutes pause code entry for that client.

## How the client dashboard behaves
- It checks when opened, when the window regains focus, and every 10 minutes; a close or expiry applies within minutes while it is open.
- No internet: it keeps using the last known expiry, so a short outage never locks a shop. If it has *never* reached the server, it stays open.
- Winding the computer clock back does not extend the subscription.
- The public customer ledger links (`/#/share/...`) are never blocked.
- This stops a shop owner from using the program, not a developer from editing the source code. That is the usual limit for any client-side check.
