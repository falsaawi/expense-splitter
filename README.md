# 🧭 TripSplit

**Share travel dinner costs fairly — city by city.**

You travel through different cities with a group that changes along the way. Every
night someone picks up the dinner bill, and the cost should be split **only among the
people who actually attended**. TripSplit makes that effortless: snap the invoice, tap
who paid and who was there, and it tells everyone who owes whom.

It's an installable web app with a **shared cloud backend**: create a trip, tap
**Share**, and everyone who opens the link sees and edits the *same* trip — expenses,
photos and balances stay in sync. No login required to join. Works offline too: changes
are cached on your device and sync when you reconnect.

---

## ✨ Features

- **A trip per city** — each city has its own group of people and its own expenses, so
  changing companions between cities is handled naturally.
- **Add people per trip** — only the folks on *this* leg of the journey.
- **Log each dinner/event** — title, amount, currency, date, and who paid.
- **📷 Snap the invoice** — attach a photo of the bill to every expense (camera on
  mobile). Tap any photo to view it full-screen.
- **Split among attendees only** — tick exactly who was there. The payer can even be
  someone who didn't eat (they're just owed the full amount back).
- **Live balances & settlement** — see each person's balance and the **minimum set of
  payments** needed to settle up ("Sara → Omar: €34.50").
- **Works offline** — installable as a PWA; open it with no signal mid-trip.
- **Multi-currency** — pick the local currency per trip (EUR, USD, GBP, JPY, AED, SAR…).
- **Backup & restore** — export/import your data as a JSON file. Share a single trip or
  everything.

---

## 🚀 Run it

It's pure HTML/CSS/JS — no build step.

**Option A — open locally**
```bash
# from the project folder, start any static server, e.g.
python3 -m http.server 8080
# then visit http://localhost:8080
```
(Using a server rather than opening the file directly lets the camera, install prompt,
and offline mode work properly.)

**Option B — deploy free on Vercel** (recommended)
1. Go to [vercel.com/new](https://vercel.com/new) and import **`falsaawi/expense-splitter`**.
2. It's a static site — leave **Framework: Other**, no build command. Click **Deploy**.
3. Open the `*.vercel.app` URL on your phone and **"Add to Home Screen"** to install it.
4. Every push redeploys; pull requests get their own **preview URL** automatically.

A `vercel.json` is included with PWA-friendly headers (no-cache for the service
worker so updates always reach users).

**Option C — host free on GitHub Pages**
1. Settings → Pages → Deploy from branch → pick your branch, root folder.
2. Open the published URL on your phone and **"Add to Home Screen"** to install it.

> When you share the deployed link in a chat, it unfurls with a preview card
> (`og-image.png`). For Twitter/Facebook, set the `og:image`/`twitter:image` URLs in
> `index.html` to your absolute deployed URL.

---

## 📲 How to use

1. **New trip** → name the city (e.g. *Barcelona*) and pick the currency.
2. **People tab** → add everyone on this leg.
3. **＋ Add expense** → enter the dinner amount, choose **who paid**, tick **who
   attended**, and add the **invoice photo**. The form shows the per-person share live.
4. **Balances tab** → see who owes whom, settled with the fewest payments.

> Want to see it populated first? On the home screen menu (**⋯**) choose **"Load a
> sample trip"**.

---

## 🧮 How the split works

For each expense the amount is divided **equally among its attendees only**:

```
each attendee owes:  amount ÷ number of attendees
the payer is credited the full amount they fronted
```

Everyone's net balance is summed across all expenses, then a greedy algorithm produces
the **minimum number of transfers** to settle the group. People who didn't attend an
expense pay nothing toward it.

---

## 🔗 Sharing & sync

- Each trip has a private **share code**. Tap **Share trip** to copy a join link
  (`…/?join=CODE`); anyone who opens it joins the same trip — no account needed.
- Trips, expenses, attendees and invoice photos live in a **Neon Postgres** database
  (via a Vercel serverless function at `/api/data`), so the whole group stays in sync.
- **Local-first:** every change updates instantly on your device and is mirrored to the
  cloud. Offline, changes are kept locally and sync when you reconnect; open trips also
  refresh automatically every few seconds so you see others' updates.

## 🔧 Backend setup (Vercel + Neon)

1. In your Vercel project, add a **Neon Postgres** database (Storage tab). Vercel injects
   a connection string (`DATABASE_URL` / `POSTGRES_URL`) into the project automatically.
2. Deploy. The `/api/data` function creates its tables on first request — no migrations
   to run. Photos are stored as compressed data URLs in Postgres.

---

## 🗂 Project structure

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `styles.css` | All styles (mobile-first) |
| `app.js` | Frontend: views, splitting math, local cache + cloud sync + sharing |
| `api/data.js` | Serverless backend (Neon Postgres): one endpoint, all data ops |
| `package.json` | Declares the `@neondatabase/serverless` dependency |
| `manifest.webmanifest` | PWA metadata (installable) |
| `sw.js` | Service worker (offline caching) |
| `icon.svg` | App icon |

---

Made for travelers who'd rather enjoy dinner than do math at the table. 🍽️
