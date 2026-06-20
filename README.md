# 🧭 TripSplit

**Share travel dinner costs fairly — city by city.**

You travel through different cities with a group that changes along the way. Every
night someone picks up the dinner bill, and the cost should be split **only among the
people who actually attended**. TripSplit makes that effortless: snap the invoice, tap
who paid and who was there, and it tells everyone who owes whom.

No accounts, no servers, no fees. It's a single installable web app — your data stays
on your phone.

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

## 🔒 Privacy & storage

- Everything is stored locally in your browser (`localStorage`) — nothing is uploaded.
- Invoice photos are automatically resized/compressed to save space.
- Browser local storage is limited (~5 MB). For long trips with many photos, **export a
  backup** now and then. Clearing your browser data will erase trips, so keep exports.

---

## 🗂 Project structure

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `styles.css` | All styles (mobile-first) |
| `app.js` | App logic: state, views, splitting math, photos |
| `manifest.webmanifest` | PWA metadata (installable) |
| `sw.js` | Service worker (offline caching) |
| `icon.svg` | App icon |

---

Made for travelers who'd rather enjoy dinner than do math at the table. 🍽️
