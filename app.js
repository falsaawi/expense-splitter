/* ============================================================
   TripSplit — share travel costs among whoever attended.
   Vanilla JS frontend. Local-first cache + shared cloud sync
   via the /api/data endpoint (Neon Postgres on Vercel).
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Constants ---------- */
  var STORAGE_KEY = "tripsplit.v1";
  var CURRENCIES = [
    { code: "EUR", sym: "€" }, { code: "USD", sym: "$" }, { code: "GBP", sym: "£" },
    { code: "JPY", sym: "¥" }, { code: "CHF", sym: "CHF " }, { code: "AED", sym: "AED " },
    { code: "SAR", sym: "SAR " }, { code: "TRY", sym: "₺" }, { code: "THB", sym: "฿" },
    { code: "AUD", sym: "A$" }, { code: "CAD", sym: "C$" }, { code: "SEK", sym: "kr " },
    { code: "INR", sym: "₹" }, { code: "MXN", sym: "MX$" }, { code: "ZAR", sym: "R " }
  ];
  var CITY_EMOJIS = ["🏙️","🌆","🗼","🏝️","⛩️","🕌","🏰","🌃","🌅","🗽","🏖️","⛰️","🌉","🎡"];
  var AVATAR_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444","#14b8a6","#f97316","#0ea5e9"];

  /* ---------- State ---------- */
  var state = load();
  var view = { name: "trips", tripId: null, tab: "expenses" };

  /* ---------- Persistence ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { trips: [], lastCurrency: "EUR" };
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("Storage is full — try removing some invoice photos.", "bad");
    }
  }

  /* ---------- Cloud sync (shared trips via the Neon-backed API) ----------
     Local cache stays the source of truth for instant UI + offline use;
     every change is also pushed to the cloud so the whole group shares it. */
  var API_URL = "/api/data";
  var cloud = { ok: false, checked: false, warned: false };
  var poller = null;

  function api(op, payload) {
    return fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ op: op }, payload || {}))
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(
          function (j) { throw new Error((j && j.error) || ("HTTP " + r.status)); },
          function () { throw new Error("HTTP " + r.status); }
        );
      }
      return r.json();
    });
  }

  // Fire-and-forget cloud write (local cache already updated + rendered).
  function push(op, payload) {
    api(op, payload).then(function () {
      cloud.ok = true; cloud.warned = false;
    }).catch(function () {
      cloud.ok = false;
      if (!cloud.warned) { cloud.warned = true; toast("Working offline — changes sync when you reconnect", ""); }
    });
  }

  function shortCode() {
    var s = "", chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    for (var i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function ensureCode(trip) { if (!trip.code) trip.code = shortCode(); return trip.code; }

  function mergeTrip(serverTrip) {
    for (var i = 0; i < state.trips.length; i++) {
      if (state.trips[i].id === serverTrip.id) { state.trips[i] = serverTrip; return; }
    }
    state.trips.push(serverTrip);
  }

  // Pull one trip from the cloud; merge if changed. cb(changed, trip).
  function pullTrip(q, cb) {
    api("getTrip", q.code ? { code: q.code } : { id: q.id }).then(function (res) {
      if (!res.trip) { if (cb) cb(false, null); return; }
      var existing = getTrip(res.trip.id);
      var changed = !existing || JSON.stringify(existing) !== JSON.stringify(res.trip);
      if (changed) { mergeTrip(res.trip); save(); }
      if (cb) cb(changed, res.trip);
    }).catch(function () { if (cb) cb(false, null); });
  }

  // Refresh all known trips from the cloud; migrate any local-only trips up.
  function refreshAll(cb) {
    var ids = state.trips.map(function (t) { return t.id; });
    if (!ids.length) { cloud.checked = true; if (cb) cb(); return; }
    api("getTrips", { ids: ids }).then(function (res) {
      cloud.ok = true; cloud.checked = true;
      var have = {};
      (res.trips || []).forEach(function (t) { have[t.id] = true; });
      // push local trips the server doesn't know yet (e.g. created before sync)
      state.trips.forEach(function (t) {
        if (!have[t.id]) { ensureCode(t); push("saveTripFull", { trip: t }); }
      });
      (res.trips || []).forEach(function (t) { mergeTrip(t); });
      save();
      if (cb) cb();
    }).catch(function () { cloud.checked = true; if (cb) cb(); });
  }

  function startPolling() {
    stopPolling();
    poller = setInterval(function () {
      if (view.name === "trip" && view.tripId && !document.querySelector(".sheet")) {
        pullTrip({ id: view.tripId }, function (changed) { if (changed) render(); });
      }
    }, 12000);
  }
  function stopPolling() { if (poller) { clearInterval(poller); poller = null; } }

  // Build + share a join link for a trip — only after it's confirmed in the cloud.
  function shareTrip(trip) {
    ensureCode(trip);
    save();
    var link = location.origin + location.pathname + "?join=" + trip.code;
    function reveal() {
      if (navigator.share) {
        navigator.share({ title: "TripSplit — " + trip.name, text: "Join our trip on TripSplit", url: link }).catch(function () {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(
          function () { toast("Share link copied — send it to your group", "good"); },
          function () { window.prompt("Copy this trip link:", link); }
        );
      } else {
        window.prompt("Copy this trip link:", link);
      }
    }
    toast("Syncing trip to the cloud…");
    // Push the whole trip (people + expenses) and only share once it lands.
    api("saveTripFull", { trip: trip }).then(function () {
      cloud.ok = true; cloud.warned = false;
      reveal();
    }).catch(function () {
      toast("Couldn't sync this trip — check your connection, then tap Share again", "bad");
    });
  }

  // Boot: join via ?join=CODE if present, then sync from the cloud.
  function boot() {
    render();
    var joinCode = null;
    try { joinCode = new URLSearchParams(location.search).get("join"); } catch (e) {}
    if (joinCode) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      api("getTrip", { code: joinCode }).then(function (res) {
        if (res.trip) {
          mergeTrip(res.trip); save();
          view = { name: "trip", tripId: res.trip.id, tab: "expenses" };
          render();
          toast("Joined “" + res.trip.name + "” 🎉", "good");
        } else {
          toast("That trip link wasn't found", "bad");
        }
        refreshAll(function () { render(); });
      }).catch(function () { toast("Couldn't load the shared trip (offline?)", "bad"); });
    } else {
      refreshAll(function () { render(); });
    }
    startPolling();
  }

  /* ---------- Utilities ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function curSym(code) {
    for (var i = 0; i < CURRENCIES.length; i++) if (CURRENCIES[i].code === code) return CURRENCIES[i].sym;
    return (code || "") + " ";
  }
  function money(amount, code) {
    var n = Number(amount) || 0;
    var dp = code === "JPY" ? 0 : 2;
    return curSym(code) + n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function initials(name) {
    var p = String(name || "?").trim().split(/\s+/);
    return ((p[0] ? p[0][0] : "?") + (p[1] ? p[1][0] : "")).toUpperCase();
  }
  function colorFor(id) {
    var h = 0; id = String(id);
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function todayISO() {
    var d = new Date(); var off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtDateLong(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric" });
  }
  function getTrip(id) {
    return state.trips.filter(function (t) { return t.id === id; })[0] || null;
  }
  function personName(trip, id) {
    var p = (trip.people || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.name : "—";
  }

  /* ---------- Core math: balances & settlement ---------- */
  // Positive balance = the group owes this person (they are owed money).
  // Negative balance = this person owes the group.
  function computeBalances(trip) {
    var bal = {};
    (trip.people || []).forEach(function (p) { bal[p.id] = 0; });
    (trip.expenses || []).forEach(function (e) {
      var attendees = (e.attendees || []).filter(function (id) { return bal[id] !== undefined; });
      if (!attendees.length || !(e.amount > 0)) {
        // still credit the payer if there are no valid attendees? No — skip, nothing to split.
        return;
      }
      var share = e.amount / attendees.length;
      if (bal[e.paidBy] !== undefined) bal[e.paidBy] += e.amount;   // payer fronted the whole bill
      attendees.forEach(function (id) { bal[id] -= share; });        // each attendee owes their share
    });
    // round to cents to avoid floating dust
    Object.keys(bal).forEach(function (k) { bal[k] = Math.round(bal[k] * 100) / 100; });
    return bal;
  }

  // Greedy minimal-transaction settlement.
  function settle(bal) {
    var creditors = [], debtors = [];
    Object.keys(bal).forEach(function (id) {
      var v = bal[id];
      if (v > 0.005) creditors.push({ id: id, amt: v });
      else if (v < -0.005) debtors.push({ id: id, amt: -v });
    });
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    debtors.sort(function (a, b) { return b.amt - a.amt; });
    var tx = [], i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var pay = Math.min(debtors[i].amt, creditors[j].amt);
      pay = Math.round(pay * 100) / 100;
      if (pay > 0) tx.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
      debtors[i].amt -= pay; creditors[j].amt -= pay;
      if (debtors[i].amt < 0.005) i++;
      if (creditors[j].amt < 0.005) j++;
    }
    return tx;
  }

  function tripTotal(trip) {
    return (trip.expenses || []).reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
  }

  /* ---------- Image handling (resize + compress to keep storage small) ---------- */
  function fileToCompressedDataURL(file, cb) {
    if (!file) { cb(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1100;
        var w = img.width, h = img.height;
        if (w > max || h > max) {
          if (w > h) { h = Math.round(h * max / w); w = max; }
          else { w = Math.round(w * max / h); h = max; }
        }
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        try { cb(c.toDataURL("image/jpeg", 0.62)); }
        catch (e) { cb(reader.result); }
      };
      img.onerror = function () { cb(reader.result); };
      img.src = reader.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }

  /* ---------- UI helpers ---------- */
  var app = document.getElementById("app");
  function render() {
    if (view.name === "trips") app.innerHTML = renderTrips();
    else if (view.name === "trip") app.innerHTML = renderTrip();
    window.scrollTo(0, 0);
  }

  var toastTimer;
  function toast(msg, kind) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  function openLightbox(src) {
    var lb = document.getElementById("lightbox");
    document.getElementById("lightboxImg").src = src;
    lb.classList.remove("hidden");
  }
  document.getElementById("lightbox").addEventListener("click", function () {
    this.classList.add("hidden");
    document.getElementById("lightboxImg").src = "";
  });

  /* ---------- Bottom sheet ---------- */
  function openSheet(title, bodyHTML, onMount) {
    closeSheet(true);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML =
      '<div class="sheet__handle"></div>' +
      '<div class="sheet__head"><h2>' + esc(title) + '</h2>' +
      '<button class="iconbtn iconbtn--ghost" data-close>✕</button></div>' +
      '<div class="sheet__body">' + bodyHTML + '</div>';
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () { scrim.classList.add("show"); sheet.classList.add("show"); });
    scrim.addEventListener("click", function () { closeSheet(); });
    sheet.querySelector("[data-close]").addEventListener("click", function () { closeSheet(); });
    if (onMount) onMount(sheet);
  }
  function closeSheet(immediate) {
    var sheet = document.querySelector(".sheet");
    var scrim = document.querySelector(".scrim");
    document.body.style.overflow = "";
    if (!sheet && !scrim) return;
    if (immediate) {
      if (sheet) sheet.remove(); if (scrim) scrim.remove(); return;
    }
    if (scrim) scrim.classList.remove("show");
    if (sheet) {
      sheet.classList.remove("show");
      setTimeout(function () { if (sheet) sheet.remove(); if (scrim) scrim.remove(); }, 260);
    }
  }

  /* ============================================================
     SCREEN: Trips list
     ============================================================ */
  function renderTrips() {
    var trips = state.trips.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var body;
    if (!trips.length) {
      body =
        '<div class="empty">' +
          '<div class="empty__emoji">🧳</div>' +
          '<div class="empty__title">Start your first trip</div>' +
          '<div class="empty__text">Create a trip for each city. Add who\'s there, log each dinner with the invoice photo, and we\'ll split it fairly.</div>' +
          '<button class="btn btn--lg" data-action="new-trip">＋ New trip</button>' +
          '<div style="margin-top:14px"><button class="linkbtn" data-action="seed-demo">or load a sample trip</button></div>' +
        '</div>';
    } else {
      body = '<div class="stack">' + trips.map(function (t) {
        var ppl = (t.people || []).length, exp = (t.expenses || []).length;
        return (
          '<div class="card trip-card" data-action="open-trip" data-id="' + t.id + '">' +
            '<div class="trip-card__emoji">' + (t.emoji || "🏙️") + '</div>' +
            '<div class="trip-card__body">' +
              '<div class="trip-card__title">' + esc(t.name) + '</div>' +
              '<div class="trip-card__meta">' +
                '<span>👥 ' + ppl + (ppl === 1 ? " person" : " people") + '</span>' +
                '<span>🧾 ' + exp + (exp === 1 ? " expense" : " expenses") + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="trip-card__total"><b>' + money(tripTotal(t), t.currency) + '</b><span>total</span></div>' +
            '<div class="chev">›</div>' +
          '</div>'
        );
      }).join("") + '</div>';
    }

    return (
      '<div class="app">' +
        '<header class="appbar">' +
          '<div class="appbar__row">' +
            '<div class="brand-logo">🧭</div>' +
            '<div style="min-width:0">' +
              '<div class="appbar__title"><span class="ttl">TripSplit</span></div>' +
              '<div class="appbar__sub">Fair dinner splitting, city by city</div>' +
            '</div>' +
            '<div class="appbar__spacer"></div>' +
            (trips.length ? '<button class="iconbtn" data-action="menu" aria-label="Menu">⋯</button>' : '') +
          '</div>' +
        '</header>' +
        '<main class="content">' + body + '</main>' +
        (trips.length ? '<button class="fab" data-action="new-trip"><span class="plus">＋</span> New trip</button>' : '') +
      '</div>'
    );
  }

  /* ============================================================
     SCREEN: Single trip (tabs: expenses / people / balances)
     ============================================================ */
  function renderTrip() {
    var trip = getTrip(view.tripId);
    if (!trip) { view.name = "trips"; return renderTrips(); }
    var bal = computeBalances(trip);
    var inner = view.tab === "people" ? tabPeople(trip, bal)
              : view.tab === "balances" ? tabBalances(trip, bal)
              : tabExpenses(trip);

    var nPeople = (trip.people || []).length, nExp = (trip.expenses || []).length;

    return (
      '<div class="app">' +
        '<header class="appbar">' +
          '<div class="appbar__row">' +
            '<button class="iconbtn" data-action="back" aria-label="Back">‹</button>' +
            '<div style="min-width:0">' +
              '<div class="appbar__title"><span style="flex:none">' + (trip.emoji || "🏙️") + '</span><span class="ttl">' + esc(trip.name) + '</span></div>' +
              '<div class="appbar__sub">' + money(tripTotal(trip), trip.currency) + ' total · ' + trip.currency + '</div>' +
            '</div>' +
            '<div class="appbar__spacer"></div>' +
            '<button class="iconbtn" data-action="trip-menu" aria-label="Trip options">⋯</button>' +
          '</div>' +
        '</header>' +
        '<main class="content">' +
          '<div class="tabs">' +
            tabBtn("expenses", "🧾", "Expenses", nExp) +
            tabBtn("people", "👥", "People", nPeople) +
            tabBtn("balances", "⚖️", "Balances", null) +
          '</div>' +
          inner +
        '</main>' +
        (view.tab === "expenses"
          ? '<button class="fab" data-action="add-expense"><span class="plus">＋</span> Add expense</button>'
          : view.tab === "people"
          ? '<button class="fab" data-action="focus-add-person"><span class="plus">＋</span> Add person</button>'
          : '') +
      '</div>'
    );
  }

  function tabBtn(name, icon, label, count) {
    return '<button data-action="tab" data-tab="' + name + '"' + (view.tab === name ? ' class="active"' : '') + '>' +
      icon + ' ' + label + (count != null && count > 0 ? ' <span class="badge">' + count + '</span>' : '') + '</button>';
  }

  /* ---------- Tab: Expenses ---------- */
  function tabExpenses(trip) {
    var exps = (trip.expenses || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return (b.date || "").localeCompare(a.date || "");
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    if (!(trip.people || []).length) {
      return emptyBox("👥", "Add people first", "Add everyone who might join dinners on this trip, then start logging expenses.",
        "Go to People", 'data-action="tab" data-tab="people"');
    }
    if (!exps.length) {
      return emptyBox("🧾", "No expenses yet", "Tap “Add expense” to log your first dinner — set the amount, snap the invoice, and tick who was there.",
        "＋ Add expense", 'data-action="add-expense"');
    }

    // group by date
    var groups = [], lastDate = null, cur = null;
    exps.forEach(function (e) {
      if (e.date !== lastDate) { cur = { date: e.date, items: [] }; groups.push(cur); lastDate = e.date; }
      cur.items.push(e);
    });

    var html = groups.map(function (g) {
      return '<div class="daygroup"><div class="daygroup__label">' + esc(fmtDateLong(g.date)) + '</div><div class="stack">' +
        g.items.map(function (e) { return expenseRow(trip, e); }).join("") + '</div></div>';
    }).join("");

    return html;
  }

  function expenseRow(trip, e) {
    var n = (e.attendees || []).length;
    var share = n ? e.amount / n : 0;
    var thumb = e.photo
      ? '<div class="expense__thumb"><img src="' + e.photo + '" alt=""></div>'
      : '<div class="expense__thumb">' + (e.emoji || "🍽️") + '</div>';
    return (
      '<div class="expense" data-action="open-expense" data-id="' + e.id + '">' +
        thumb +
        '<div class="expense__body">' +
          '<div class="expense__title">' + esc(e.title) + '</div>' +
          '<div class="expense__meta">' +
            '<span class="pill">' + esc(personName(trip, e.paidBy)) + ' paid</span>' +
            '<span>· ' + n + (n === 1 ? " person" : " people") + '</span>' +
            (e.photo ? '<span class="pill pill--cam">📷</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="expense__amt">' + money(e.amount, trip.currency) + '<span>' + money(share, trip.currency) + '/ea</span></div>' +
      '</div>'
    );
  }

  /* ---------- Tab: People ---------- */
  function tabPeople(trip, bal) {
    var people = (trip.people || []);
    var list = people.length ? '<div class="stack">' + people.map(function (p) {
      var b = bal[p.id] || 0;
      var status = Math.abs(b) < 0.005
        ? '<div class="person__bal">settled<small>all square</small></div>'
        : b > 0
        ? '<div class="person__bal txt-good">+' + money(b, trip.currency) + '<small>gets back</small></div>'
        : '<div class="person__bal txt-bad">' + money(b, trip.currency) + '<small>owes</small></div>';
      return (
        '<div class="person">' +
          '<div class="avatar" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</div>' +
          '<div class="person__name">' + esc(p.name) + '</div>' +
          status +
          '<button class="iconbtn iconbtn--ghost" data-action="remove-person" data-id="' + p.id + '" aria-label="Remove">🗑️</button>' +
        '</div>'
      );
    }).join("") + '</div>' : '<div class="muted-note">No one added yet.</div>';

    return (
      '<div class="addrow">' +
        '<input id="newPerson" type="text" placeholder="Add a name…" autocomplete="off" enterkeyhint="done" />' +
        '<button class="btn" data-action="add-person">Add</button>' +
      '</div>' +
      list +
      (people.length ? '<div class="hint" style="text-align:center;margin-top:16px">Tip: only people ticked as “attended” on an expense help pay for it.</div>' : '')
    );
  }

  /* ---------- Tab: Balances ---------- */
  function tabBalances(trip, bal) {
    var people = trip.people || [];
    if (!people.length || !(trip.expenses || []).length) {
      return emptyBox("⚖️", "Nothing to settle yet", "Once you've added people and logged a few expenses, you'll see exactly who owes whom here.",
        null, null);
    }
    var tx = settle(bal);

    var settleHTML;
    if (!tx.length) {
      settleHTML = '<div class="card" style="text-align:center;padding:26px"><div style="font-size:40px">🎉</div>' +
        '<div style="font-weight:700;margin-top:8px">Everyone is settled up!</div>' +
        '<div class="hint">No payments needed.</div></div>';
    } else {
      settleHTML = '<div class="stack">' + tx.map(function (t) {
        return (
          '<div class="settle">' +
            '<div class="avatar" style="background:' + colorFor(t.from) + '">' + esc(initials(personName(trip, t.from))) + '</div>' +
            '<div class="settle__names"><b>' + esc(personName(trip, t.from)) + '</b> <span class="settle__arrow">→</span> <b>' + esc(personName(trip, t.to)) + '</b></div>' +
            '<div class="settle__amt">' + money(t.amount, trip.currency) + '</div>' +
          '</div>'
        );
      }).join("") + '</div>';
    }

    // per-person summary
    var balHTML = '<div class="stack">' + people.map(function (p) {
      var b = bal[p.id] || 0;
      var cls = Math.abs(b) < 0.005 ? "" : b > 0 ? "txt-good" : "txt-bad";
      var label = Math.abs(b) < 0.005 ? "settled" : b > 0 ? "+" + money(b, trip.currency) : money(b, trip.currency);
      return (
        '<div class="person">' +
          '<div class="avatar" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</div>' +
          '<div class="person__name">' + esc(p.name) + '</div>' +
          '<div class="person__bal ' + cls + '">' + label + '</div>' +
        '</div>'
      );
    }).join("") + '</div>';

    return (
      '<div class="summary">' +
        '<div class="summary__label">Trip total</div>' +
        '<div class="summary__total">' + money(tripTotal(trip), trip.currency) + '</div>' +
        '<div class="summary__grid">' +
          '<div class="summary__stat"><b>' + people.length + '</b><span>people</span></div>' +
          '<div class="summary__stat"><b>' + (trip.expenses || []).length + '</b><span>expenses</span></div>' +
          '<div class="summary__stat"><b>' + tx.length + '</b><span>payments to settle</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="section-title">Who pays whom</div>' +
      settleHTML +
      '<div class="section-title" style="margin-top:22px">Everyone\'s balance</div>' +
      balHTML
    );
  }

  function emptyBox(emoji, title, text, btnLabel, btnAttrs) {
    return '<div class="empty">' +
      '<div class="empty__emoji">' + emoji + '</div>' +
      '<div class="empty__title">' + esc(title) + '</div>' +
      '<div class="empty__text">' + esc(text) + '</div>' +
      (btnLabel ? '<button class="btn btn--lg" ' + btnAttrs + '>' + esc(btnLabel) + '</button>' : '') +
      '</div>';
  }

  /* ============================================================
     FORMS: new/edit trip
     ============================================================ */
  function tripFormSheet(existing) {
    var t = existing || { name: "", currency: state.lastCurrency || "EUR", emoji: CITY_EMOJIS[0] };
    var curOpts = CURRENCIES.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === t.currency ? " selected" : "") + '>' + c.code + ' (' + c.sym.trim() + ')</option>';
    }).join("");
    var emojiBtns = CITY_EMOJIS.map(function (em) {
      return '<button type="button" class="chip emoji-pick' + (em === t.emoji ? " sel" : "") + '" data-emoji="' + em + '" style="font-size:20px;padding:8px 11px">' + em + '</button>';
    }).join("");

    var body =
      '<form id="tripForm">' +
        '<div class="field"><label>City / trip name</label>' +
          '<input id="f_name" type="text" placeholder="e.g. Barcelona" value="' + esc(t.name) + '" required /></div>' +
        '<div class="field"><label>Currency</label><select id="f_currency">' + curOpts + '</select></div>' +
        '<div class="field"><label>Icon</label><div class="chips" id="emojiPick">' + emojiBtns + '</div></div>' +
        '<button type="submit" class="btn btn--block btn--lg">' + (existing ? "Save changes" : "Create trip") + '</button>' +
      '</form>';

    openSheet(existing ? "Edit trip" : "New trip", body, function (sheet) {
      var chosen = t.emoji;
      sheet.querySelectorAll(".emoji-pick").forEach(function (b) {
        b.addEventListener("click", function () {
          chosen = b.getAttribute("data-emoji");
          sheet.querySelectorAll(".emoji-pick").forEach(function (x) { x.classList.remove("sel"); });
          b.classList.add("sel");
        });
      });
      sheet.querySelector("#tripForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var name = sheet.querySelector("#f_name").value.trim();
        if (!name) { toast("Give the trip a name", "bad"); return; }
        var currency = sheet.querySelector("#f_currency").value;
        state.lastCurrency = currency;
        if (existing) {
          existing.name = name; existing.currency = currency; existing.emoji = chosen;
          push("updateTrip", { id: existing.id, name: name, currency: currency, emoji: chosen });
          toast("Trip updated", "good");
        } else {
          var nt = { id: uid(), code: shortCode(), name: name, currency: currency, emoji: chosen, createdAt: Date.now(), people: [], expenses: [] };
          state.trips.push(nt);
          push("saveTripFull", { trip: nt });
          view = { name: "trip", tripId: nt.id, tab: "people" };
          toast("Trip created — add people next 👇", "good");
        }
        save(); closeSheet(); render();
      });
      setTimeout(function () { var el = sheet.querySelector("#f_name"); if (el && !existing) el.focus(); }, 300);
    });
  }

  /* ============================================================
     FORM: add / edit expense
     ============================================================ */
  function expenseFormSheet(trip, existing) {
    var people = trip.people || [];
    if (!people.length) { toast("Add people first", "bad"); return; }

    var e = existing || {
      title: "", amount: "", date: todayISO(),
      paidBy: people[0].id,
      attendees: people.map(function (p) { return p.id; }),
      photo: null, note: ""
    };
    var draftPhoto = e.photo || null;
    var paidBy = e.paidBy;
    var attendees = (e.attendees || []).slice();

    function paidChips() {
      return people.map(function (p) {
        return '<button type="button" class="chip paid-chip' + (p.id === paidBy ? " sel" : "") + '" data-id="' + p.id + '">' +
          '<span class="dot" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</span>' + esc(p.name) + '</button>';
      }).join("");
    }
    function attendChips() {
      return people.map(function (p) {
        var on = attendees.indexOf(p.id) >= 0;
        return '<button type="button" class="chip attend attend-chip' + (on ? " sel attend" : "") + '" data-id="' + p.id + '">' +
          '<span class="dot" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</span>' + esc(p.name) +
          '<span class="chip__check">' + (on ? "✓" : "") + '</span></button>';
      }).join("");
    }
    function photoBlock() {
      if (draftPhoto) {
        return '<div class="photo-preview"><img src="' + draftPhoto + '" alt="invoice" id="photoImg">' +
          '<button type="button" class="photo-preview__remove" id="photoRemove" aria-label="Remove photo">✕</button></div>';
      }
      return '<label class="photo-pick" for="photoInput"><div class="ic">📷</div><b>Add invoice photo</b>' +
        '<span class="hint">Take a photo or pick from gallery</span></label>';
    }

    var curOpts = CURRENCIES.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === trip.currency ? " selected" : "") + '>' + c.code + '</option>';
    }).join("");

    var body =
      '<form id="expForm">' +
        '<div class="field"><label>What was it?</label>' +
          '<input id="e_title" type="text" placeholder="e.g. Dinner at La Rambla" value="' + esc(e.title) + '" required /></div>' +
        '<div class="field"><label>Amount</label>' +
          '<div class="field__row">' +
            '<div class="amount-input" style="flex:2"><span class="cur">' + esc(curSym(trip.currency).trim() || trip.currency) + '</span>' +
              '<input id="e_amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="' + esc(e.amount) + '" required /></div>' +
            '<input id="e_date" type="date" value="' + esc(e.date) + '" style="flex:1.3" />' +
          '</div>' +
        '</div>' +
        '<div class="field"><label>Who paid?</label><div class="chips" id="paidChips">' + paidChips() + '</div></div>' +
        '<div class="field"><label>Who attended? <span style="color:var(--good)">(splits the bill)</span></label>' +
          '<div class="mini-actions"><button type="button" id="selAll">Select all</button><button type="button" id="selNone">Clear</button></div>' +
          '<div class="chips" id="attendChips">' + attendChips() + '</div>' +
          '<div class="split-row" id="splitRow"></div>' +
        '</div>' +
        '<div class="field"><label>Invoice photo</label>' +
          '<div id="photoBlock">' + photoBlock() + '</div>' +
          '<input id="photoInput" type="file" accept="image/*" capture="environment" class="hidden" /></div>' +
        '<div class="field"><label>Note (optional)</label>' +
          '<textarea id="e_note" placeholder="Anything to remember…">' + esc(e.note || "") + '</textarea></div>' +
        '<button type="submit" class="btn btn--block btn--lg">' + (existing ? "Save expense" : "Add expense") + '</button>' +
        (existing ? '<button type="button" id="delExp" class="btn btn--block btn--danger" style="margin-top:10px">Delete expense</button>' : '') +
        '<div style="height:8px"></div>' +
      '</form>';

    openSheet(existing ? "Edit expense" : "Add expense", body, function (sheet) {
      function refreshSplit() {
        var amt = parseFloat(sheet.querySelector("#e_amount").value) || 0;
        var n = attendees.length;
        var row = sheet.querySelector("#splitRow");
        if (n === 0) { row.innerHTML = '<span style="color:var(--bad)">Pick at least one attendee</span>'; }
        else { row.innerHTML = '<span>Split between <b>' + n + '</b></span><span><b>' + money(amt / n, trip.currency) + '</b> each</span>'; }
      }
      sheet.querySelector("#paidChips").addEventListener("click", function (ev) {
        var b = ev.target.closest(".paid-chip"); if (!b) return;
        paidBy = b.getAttribute("data-id");
        sheet.querySelectorAll(".paid-chip").forEach(function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
      });
      sheet.querySelector("#attendChips").addEventListener("click", function (ev) {
        var b = ev.target.closest(".attend-chip"); if (!b) return;
        var id = b.getAttribute("data-id");
        var i = attendees.indexOf(id);
        if (i >= 0) attendees.splice(i, 1); else attendees.push(id);
        b.classList.toggle("sel"); b.classList.toggle("attend");
        b.querySelector(".chip__check").textContent = i >= 0 ? "" : "✓";
        refreshSplit();
      });
      sheet.querySelector("#selAll").addEventListener("click", function () {
        attendees = people.map(function (p) { return p.id; });
        sheet.querySelector("#attendChips").innerHTML = attendChips(); refreshSplit();
      });
      sheet.querySelector("#selNone").addEventListener("click", function () {
        attendees = [];
        sheet.querySelector("#attendChips").innerHTML = attendChips(); refreshSplit();
      });
      sheet.querySelector("#e_amount").addEventListener("input", refreshSplit);

      function bindPhoto() {
        var rm = sheet.querySelector("#photoRemove");
        if (rm) rm.addEventListener("click", function () { draftPhoto = null; sheet.querySelector("#photoBlock").innerHTML = photoBlock(); bindPhoto(); });
        var img = sheet.querySelector("#photoImg");
        if (img) img.addEventListener("click", function () { openLightbox(draftPhoto); });
      }
      sheet.querySelector("#photoInput").addEventListener("change", function () {
        var f = this.files && this.files[0];
        if (!f) return;
        toast("Processing photo…");
        fileToCompressedDataURL(f, function (data) {
          if (!data) { toast("Couldn't read that image", "bad"); return; }
          draftPhoto = data;
          sheet.querySelector("#photoBlock").innerHTML = photoBlock();
          bindPhoto();
        });
      });
      bindPhoto();
      refreshSplit();

      if (existing) {
        sheet.querySelector("#delExp").addEventListener("click", function () {
          if (!confirm("Delete this expense?")) return;
          trip.expenses = trip.expenses.filter(function (x) { return x.id !== existing.id; });
          push("deleteExpense", { tripId: trip.id, expenseId: existing.id });
          save(); closeSheet(); render(); toast("Expense deleted");
        });
      }

      sheet.querySelector("#expForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var title = sheet.querySelector("#e_title").value.trim();
        var amount = parseFloat(sheet.querySelector("#e_amount").value);
        if (!title) { toast("Add a description", "bad"); return; }
        if (!(amount > 0)) { toast("Enter an amount", "bad"); return; }
        if (!attendees.length) { toast("Pick who attended", "bad"); return; }
        var payload = {
          title: title, amount: Math.round(amount * 100) / 100,
          date: sheet.querySelector("#e_date").value || todayISO(),
          paidBy: paidBy, attendees: attendees.slice(),
          photo: draftPhoto, note: sheet.querySelector("#e_note").value.trim()
        };
        if (existing) {
          Object.keys(payload).forEach(function (k) { existing[k] = payload[k]; });
          push("saveExpense", { tripId: trip.id, expense: existing });
          toast("Expense saved", "good");
        } else {
          payload.id = uid(); payload.createdAt = Date.now();
          trip.expenses.push(payload);
          push("saveExpense", { tripId: trip.id, expense: payload });
          toast("Expense added", "good");
        }
        save(); closeSheet(); render();
      });

      setTimeout(function () { var el = sheet.querySelector("#e_title"); if (el && !existing) el.focus(); }, 300);
    });
  }

  /* ---------- Expense detail sheet ---------- */
  function expenseDetailSheet(trip, e) {
    var n = (e.attendees || []).length;
    var share = n ? e.amount / n : 0;
    var attendeeList = (e.attendees || []).map(function (id) {
      return '<span class="chip" style="font-size:13px">' +
        '<span class="dot" style="background:' + colorFor(id) + '">' + esc(initials(personName(trip, id))) + '</span>' +
        esc(personName(trip, id)) + '</span>';
    }).join("");

    var body =
      (e.photo ? '<img src="' + e.photo + '" class="detail-photo" id="detailPhoto" alt="invoice" />' : '') +
      '<div class="card stack" style="margin-bottom:14px">' +
        '<div style="font-size:20px;font-weight:750">' + esc(e.title) + '</div>' +
        '<div style="font-size:30px;font-weight:800;color:var(--primary-dark)">' + money(e.amount, trip.currency) + '</div>' +
        '<div class="kv"><span>Date</span><b>' + esc(fmtDateLong(e.date)) + '</b></div>' +
        '<div class="kv"><span>Paid by</span><b>' + esc(personName(trip, e.paidBy)) + '</b></div>' +
        '<div class="kv"><span>Split between</span><b>' + n + (n === 1 ? " person" : " people") + '</b></div>' +
        '<div class="kv"><span>Each pays</span><b>' + money(share, trip.currency) + '</b></div>' +
        (e.note ? '<div class="kv"><span>Note</span><b style="text-align:right;max-width:60%">' + esc(e.note) + '</b></div>' : '') +
      '</div>' +
      '<div class="section-title">Attended</div>' +
      '<div class="chips" style="margin-bottom:18px">' + attendeeList + '</div>' +
      '<button class="btn btn--block btn--soft" id="editExp">✏️ Edit expense</button>';

    openSheet("Expense", body, function (sheet) {
      var dp = sheet.querySelector("#detailPhoto");
      if (dp) dp.addEventListener("click", function () { openLightbox(e.photo); });
      sheet.querySelector("#editExp").addEventListener("click", function () {
        closeSheet(true); expenseFormSheet(trip, e);
      });
    });
  }

  /* ---------- Trip options menu ---------- */
  function tripMenuSheet(trip) {
    var body =
      '<button class="btn btn--block btn--lg" data-m="share" style="margin-bottom:12px">🔗 Share trip with the group</button>' +
      '<div class="hint" style="text-align:center;margin:-4px 0 16px">Anyone who opens the link joins this trip and sees the same expenses, live.</div>' +
      '<button class="btn btn--block btn--soft" data-m="edit" style="margin-bottom:10px">✏️ Edit trip name / currency</button>' +
      '<button class="btn btn--block btn--soft" data-m="export" style="margin-bottom:10px">⬇️ Export backup (JSON)</button>' +
      '<button class="btn btn--block btn--danger" data-m="delete">🗑️ Delete this trip</button>';
    openSheet(trip.name, body, function (sheet) {
      sheet.querySelector('[data-m="share"]').addEventListener("click", function () { closeSheet(); shareTrip(trip); });
      sheet.querySelector('[data-m="edit"]').addEventListener("click", function () { closeSheet(true); tripFormSheet(trip); });
      sheet.querySelector('[data-m="export"]').addEventListener("click", function () { closeSheet(); exportData(trip); });
      sheet.querySelector('[data-m="delete"]').addEventListener("click", function () {
        if (!confirm('Delete "' + trip.name + '" and all its expenses?')) return;
        state.trips = state.trips.filter(function (t) { return t.id !== trip.id; });
        push("deleteTrip", { id: trip.id });
        save(); view = { name: "trips" }; closeSheet(); render(); toast("Trip deleted");
      });
    });
  }

  /* ---------- App menu (trips list) ---------- */
  function appMenuSheet() {
    var body =
      '<button class="btn btn--block btn--soft" data-m="export" style="margin-bottom:10px">⬇️ Export all data (JSON)</button>' +
      '<label class="btn btn--block btn--soft" for="importInput" style="margin-bottom:10px">⬆️ Import backup</label>' +
      '<input id="importInput" type="file" accept="application/json,.json" class="hidden" />' +
      '<button class="btn btn--block btn--soft" data-m="demo">✨ Load a sample trip</button>' +
      '<div class="hint" style="text-align:center;margin-top:14px">Trips sync to the cloud so your whole group shares them. Export is a personal backup.</div>';
    openSheet("TripSplit", body, function (sheet) {
      sheet.querySelector('[data-m="export"]').addEventListener("click", function () { closeSheet(); exportData(null); });
      sheet.querySelector('[data-m="demo"]').addEventListener("click", function () { closeSheet(); seedDemo(); });
      sheet.querySelector("#importInput").addEventListener("change", function () {
        var f = this.files && this.files[0]; if (!f) return;
        var r = new FileReader();
        r.onload = function () {
          try {
            var data = JSON.parse(r.result);
            if (!data || !Array.isArray(data.trips)) throw new Error("bad");
            state = data;
            state.trips.forEach(function (t) { ensureCode(t); push("saveTripFull", { trip: t }); });
            save(); closeSheet(); view = { name: "trips" }; render(); toast("Backup imported", "good");
          } catch (e) { toast("That file isn't a valid backup", "bad"); }
        };
        r.readAsText(f);
      });
    });
  }

  function exportData(trip) {
    var data = trip ? { trips: [trip], lastCurrency: state.lastCurrency } : state;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (trip ? "tripsplit-" + trip.name.replace(/\s+/g, "-").toLowerCase() : "tripsplit-backup") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Backup downloaded", "good");
  }

  /* ---------- Demo data ---------- */
  function seedDemo() {
    var pid = function () { return uid(); };
    var a = pid(), b = pid(), c = pid(), d = pid();
    var trip = {
      id: uid(), code: shortCode(), name: "Barcelona", currency: "EUR", emoji: "🌆", createdAt: Date.now(),
      people: [
        { id: a, name: "Omar" }, { id: b, name: "Sara" },
        { id: c, name: "Liam" }, { id: d, name: "Nadia" }
      ],
      expenses: [
        { id: uid(), title: "Tapas dinner at El Xampanyet", amount: 184.50, date: todayISO(),
          paidBy: a, attendees: [a, b, c, d], photo: null, note: "Shared lots of plates", createdAt: Date.now(), emoji: "🍤" },
        { id: uid(), title: "Paella by the beach", amount: 96.00, date: todayISO(),
          paidBy: b, attendees: [a, b, d], photo: null, note: "Liam skipped this one", createdAt: Date.now() - 1000, emoji: "🥘" },
        { id: uid(), title: "Late-night drinks", amount: 54.00, date: shiftDate(-1),
          paidBy: c, attendees: [b, c, d], photo: null, note: "", createdAt: Date.now() - 2000, emoji: "🍷" }
      ]
    };
    state.trips.push(trip);
    state.lastCurrency = "EUR";
    push("saveTripFull", { trip: trip });
    save();
    view = { name: "trip", tripId: trip.id, tab: "expenses" };
    render();
    toast("Sample trip loaded ✨", "good");
  }
  function shiftDate(days) {
    var d = new Date(); d.setDate(d.getDate() + days);
    var off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  /* ============================================================
     People add/remove
     ============================================================ */
  function addPersonFromInput() {
    var trip = getTrip(view.tripId); if (!trip) return;
    var input = document.getElementById("newPerson");
    if (!input) return;
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    var person = { id: uid(), name: name };
    trip.people.push(person);
    push("addPerson", { tripId: trip.id, person: person });
    save();
    render();
    // re-focus the (re-rendered) input for fast multi-add
    var again = document.getElementById("newPerson");
    if (again) again.focus();
  }

  /* ============================================================
     Global event delegation
     ============================================================ */
  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    var trip = view.tripId ? getTrip(view.tripId) : null;

    switch (action) {
      case "new-trip": tripFormSheet(null); break;
      case "seed-demo": seedDemo(); break;
      case "menu": appMenuSheet(); break;
      case "open-trip": view = { name: "trip", tripId: id, tab: "expenses" }; render(); break;
      case "back": view = { name: "trips" }; render(); break;
      case "tab": view.tab = el.getAttribute("data-tab"); render(); break;
      case "trip-menu": if (trip) tripMenuSheet(trip); break;
      case "add-expense": if (trip) expenseFormSheet(trip, null); break;
      case "open-expense":
        if (trip) { var e = trip.expenses.filter(function (x) { return x.id === id; })[0]; if (e) expenseDetailSheet(trip, e); }
        break;
      case "add-person": addPersonFromInput(); break;
      case "focus-add-person":
        view.tab = "people"; render();
        setTimeout(function () { var i = document.getElementById("newPerson"); if (i) i.focus(); }, 60);
        break;
      case "remove-person":
        if (trip) {
          var used = trip.expenses.some(function (x) { return x.paidBy === id || (x.attendees || []).indexOf(id) >= 0; });
          var msg = used ? "This person is in some expenses. Remove them anyway? Those expenses stay but will recalculate." : "Remove this person?";
          if (confirm(msg)) {
            trip.people = trip.people.filter(function (p) { return p.id !== id; });
            trip.expenses.forEach(function (x) { x.attendees = (x.attendees || []).filter(function (pid) { return pid !== id; }); });
            push("removePerson", { tripId: trip.id, personId: id });
            save(); render();
          }
        }
        break;
    }
  });

  // Enter key adds a person quickly
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target && ev.target.id === "newPerson") {
      ev.preventDefault(); addPersonFromInput();
    }
    if (ev.key === "Escape") {
      var lb = document.getElementById("lightbox");
      if (lb && !lb.classList.contains("hidden")) { lb.classList.add("hidden"); return; }
      if (document.querySelector(".sheet")) closeSheet();
    }
  });

  // Browser back button closes sheets / navigates between views
  window.addEventListener("popstate", function () {
    if (document.querySelector(".sheet")) { closeSheet(); return; }
    if (view.name === "trip") { view = { name: "trips" }; render(); }
  });

  /* ---------- Service worker (offline) ---------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  /* ---------- Boot ---------- */
  boot();

  // expose a tiny hook for the preview/demo tooling
  window.__tripsplit = { seedDemo: seedDemo, state: function () { return state; }, render: render, go: function (v) { view = v; render(); } };
})();
