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
  // Default exchange rates → Saudi Riyal (SAR per 1 unit of currency). Editable in-app.
  var SAR_RATES = { SAR: 1, USD: 3.75, EUR: 4.05, GBP: 4.70, AED: 1.02, JPY: 0.025, CHF: 4.20, TRY: 0.11, THB: 0.105, AUD: 2.45, CAD: 2.75, SEK: 0.36, INR: 0.045, MXN: 0.20, ZAR: 0.20 };

  /* ---------- State ---------- */
  var state = load();
  if (!state.rates || typeof state.rates !== "object") state.rates = {};
  if (!Array.isArray(state.settlements)) state.settlements = []; // global overall settlements (SAR)
  var view = { name: "trips", tripId: null, tab: "expenses" };
  var memberDirectory = []; // names of all registered users (for the add-person dropdown)

  /* ---------- Persistence ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { trips: [], lastCurrency: "EUR" };
  }
  // localStorage holds metadata only. Invoice photos are kept OUT of it (they're
  // large base64 blobs) and stored in IndexedDB instead — see mirrorPhotos below.
  function cacheSnapshot() {
    var snap = {};
    for (var k in state) {
      if (k === "auth") continue;
      if (k === "trips") {
        snap.trips = (state.trips || []).map(function (t) {
          return Object.assign({}, t, {
            expenses: (t.expenses || []).map(function (e) {
              return e.photo ? Object.assign({}, e, { photo: null }) : e;
            })
          });
        });
      } else {
        snap[k] = state[k];
      }
    }
    return snap;
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cacheSnapshot()));
    } catch (e) {
      // Metadata-only, so this should essentially never fire now.
      toast("Storage is full — try removing some invoice photos.", "bad");
    }
    scheduleMirror(); // persist invoice photos to IndexedDB (large quota)
  }

  /* ---------- Invoice photos → IndexedDB ----------
     Photos are large base64 blobs; localStorage (~5MB) overflows fast. We mirror
     them to IndexedDB (hundreds of MB) keyed by expense id, prune removed ones,
     and rehydrate into memory on load so they appear even offline. */
  var IDB_NAME = "tripsplit", IDB_STORE = "photos", _idb = null;
  function idbOpen() {
    if (_idb) return _idb;
    _idb = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no-idb")); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    _idb.catch(function () { _idb = null; }); // allow a later retry if open failed
    return _idb;
  }
  function idbGetAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var out = {}, tx = db.transaction(IDB_STORE, "readonly"), st = tx.objectStore(IDB_STORE);
        var req = st.openCursor();
        req.onsuccess = function () { var c = req.result; if (c) { out[c.key] = c.value; c.continue(); } else resolve(out); };
        req.onerror = function () { resolve(out); };
      });
    });
  }
  // Upsert every current photo, delete keys no longer referenced.
  function idbSync(currentMap) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, "readwrite"), st = tx.objectStore(IDB_STORE);
        var kReq = st.getAllKeys();
        kReq.onsuccess = function () {
          (kReq.result || []).forEach(function (k) { if (!(k in currentMap)) st.delete(k); });
        };
        Object.keys(currentMap).forEach(function (id) { st.put(currentMap[id], id); });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }
  var _mirrorTimer = null;
  function scheduleMirror() {
    if (!window.indexedDB) return;
    if (_mirrorTimer) clearTimeout(_mirrorTimer);
    _mirrorTimer = setTimeout(function () {
      _mirrorTimer = null;
      var current = {};
      (state.trips || []).forEach(function (t) {
        (t.expenses || []).forEach(function (e) { if (e.photo) current[e.id] = e.photo; });
      });
      idbSync(current);
    }, 700);
  }
  // Restore photos from IDB for expenses missing one in memory (e.g. offline load).
  function hydratePhotos() {
    if (!window.indexedDB) return;
    idbGetAll().then(function (map) {
      var changed = false;
      (state.trips || []).forEach(function (t) {
        (t.expenses || []).forEach(function (e) {
          if (!e.photo && map[e.id]) { e.photo = map[e.id]; changed = true; }
        });
      });
      if (changed) render();
    }).catch(function () {});
  }

  /* ---------- Auth persistence ----------
     Kept in its own tiny slot, separate from the big trips/photos cache, so
     a full cache can never evict the login (which used to cause surprise
     logouts). "Remember me" → localStorage (survives closing the browser);
     otherwise → sessionStorage (cleared when the tab/browser closes). */
  var AUTH_KEY = STORAGE_KEY + ".auth";
  function loadAuth() {
    try {
      var raw = localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }
  function saveAuth(auth, remember) {
    try {
      var s = JSON.stringify(auth);
      if (remember) { localStorage.setItem(AUTH_KEY, s); sessionStorage.removeItem(AUTH_KEY); }
      else { sessionStorage.setItem(AUTH_KEY, s); localStorage.removeItem(AUTH_KEY); }
    } catch (e) {}
  }
  function clearAuth() {
    try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
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
      // drop trips the server reports as deleted (propagates deletions across devices)
      if (res.deleted && res.deleted.length) {
        var del = {};
        res.deleted.forEach(function (id) { del[id] = true; });
        state.trips = state.trips.filter(function (t) { return !del[t.id]; });
      }
      var have = {};
      (res.trips || []).forEach(function (t) { have[t.id] = true; });
      // Reconcile local trips the server doesn't have: migrate real ones up,
      // but drop dead empty shells (0 people, 0 expenses) so deleted/duplicate
      // empties aren't recreated. Recent or currently-open trips are never pruned.
      var prune = [];
      state.trips.forEach(function (t) {
        if (have[t.id]) return;
        var empty = !(t.people || []).length && !(t.expenses || []).length;
        var oldEnough = (Date.now() - (t.createdAt || 0)) > 120000;
        if (empty && oldEnough && view.tripId !== t.id) { prune.push(t.id); }
        else { ensureCode(t); push("saveTripFull", { trip: t }); }
      });
      if (prune.length) state.trips = state.trips.filter(function (t) { return prune.indexOf(t.id) < 0; });
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

  // Boot: restore the remembered login, then sync from the cloud.
  function boot() {
    // Prefer the dedicated auth slot; fall back to legacy auth in the big blob
    // (migrates already-signed-in users to the new slot on next login).
    var saved = loadAuth() || (state.auth && state.auth.name && state.auth.code ? state.auth : null);
    if (saved && saved.name && saved.code) {
      state.auth = saved;
      render(); // show cached trips while we refresh
      hydratePhotos(); // restore cached invoice photos from IndexedDB (offline-friendly)
      doLogin(saved.name, saved.code, saved.remember !== false, function (ok, reason) {
        if (ok) { view = { name: "trips" }; render(); startPolling(); refreshMemberDirectory(); refreshSettlements(); }
        else if (reason === "invalid") {
          // Server says the credentials are no longer valid → really sign out.
          clearAuth(); state.auth = null; state.trips = []; save(); render();
        } else {
          // Network blip on startup — stay signed in, keep cached trips, retry via polling.
          startPolling();
        }
      });
    } else {
      state.auth = null;
      render(); // login screen
    }
  }

  // Sign in with name + 4-digit code; loads only that member's trips (all if admin).
  // remember=false keeps the session only until the browser closes.
  function doLogin(name, code, remember, cb) {
    var keep = remember !== false;
    api("login", { name: name, code: code }).then(function (res) {
      if (res && res.ok) {
        state.auth = { name: res.name, code: String(code), isAdmin: !!res.isAdmin, remember: keep };
        state.trips = res.trips || [];
        state.settlements = res.settlements || [];
        saveAuth(state.auth, keep);
        save();
        if (cb) cb(true);
      } else { if (cb) cb(false, "invalid"); }
    }).catch(function () { if (cb) cb(false, "network"); });
  }

  // Pull the directory of registered user names (for the add-person dropdown).
  function refreshMemberDirectory() {
    if (!(state.auth && state.auth.name && state.auth.code)) return;
    api("listMemberNames", { name: state.auth.name, code: state.auth.code }).then(function (r) {
      if (r && r.ok && Array.isArray(r.names)) {
        memberDirectory = r.names;
        if (view.name === "trip" && view.tab === "people") render();
      }
    }).catch(function () {});
  }

  // Pull the global (overall) settlements from the cloud.
  function refreshSettlements() {
    if (!(state.auth && state.auth.name && state.auth.code)) return;
    api("getSettlements", { name: state.auth.name, code: state.auth.code }).then(function (r) {
      if (r && r.ok && Array.isArray(r.settlements)) {
        state.settlements = r.settlements; save();
        if (view.name === "overall") render();
      }
    }).catch(function () {});
  }

  function renderLogin() {
    return (
      '<div class="app">' +
        '<header class="appbar"><div class="appbar__row">' +
          '<img class="brand-logo" src="icon.svg" alt="Lean" />' +
          '<div style="min-width:0"><div class="appbar__title"><span class="ttl">TripSplit</span></div>' +
          '<div class="appbar__sub">Sign in to see your trips</div></div>' +
        '</div></header>' +
        '<main class="content">' +
          '<div class="card" style="margin-top:8px">' +
            '<div style="font-size:19px;font-weight:750">Sign in</div>' +
            '<div class="hint" style="margin:6px 0 16px">Enter your name and the 4-digit code you were given.</div>' +
            '<div class="field"><label>Your name</label><input id="loginName" type="text" autocomplete="off" enterkeyhint="next" placeholder="e.g. Fahad" /></div>' +
            '<div class="field"><label>4-digit code</label><input id="loginCode" type="text" inputmode="numeric" maxlength="4" autocomplete="off" enterkeyhint="go" placeholder="••••" /></div>' +
            '<label class="remember"><input id="rememberMe" type="checkbox" checked /> <span>Keep me signed in on this device</span></label>' +
            '<button class="btn btn--block btn--lg" data-action="do-login">Sign in</button>' +
          '</div>' +
          '<div class="muted-note" style="margin-top:14px">Don’t have a code? Ask Fahad for yours.</div>' +
        '</main>' +
      '</div>'
    );
  }

  // Build a single link that loads ALL of this device's trips (handy for moving
  // to a new phone/browser, since trips otherwise live only in local storage).
  function shareAllTrips() {
    var codes = state.trips.map(function (t) { ensureCode(t); return t.code; }).filter(Boolean);
    if (!codes.length) { toast("No trips to share yet"); return; }
    state.trips.forEach(function (t) { push("saveTripFull", { trip: t }); }); // ensure all are in the cloud
    save();
    var link = location.origin + location.pathname + "?join=" + codes.join(",");
    if (navigator.share) {
      navigator.share({ title: "My TripSplit trips", url: link }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(
        function () { toast("Link to all your trips copied — open it on any device", "good"); },
        function () { window.prompt("Copy this link:", link); }
      );
    } else {
      window.prompt("Copy this link:", link);
    }
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
  // Lowercased name of the logged-in user — used to match settlement parties.
  function myNameKey() {
    return state.auth && state.auth.name ? String(state.auth.name).trim().toLowerCase() : "";
  }

  // Per-person breakdown: total paid (fronted) vs share (what they consumed on
  // expenses they attended). net = paid - share, matching computeBalances.
  function computeStats(trip) {
    var paid = {}, share = {}, net = {};
    (trip.people || []).forEach(function (p) { paid[p.id] = 0; share[p.id] = 0; });
    (trip.expenses || []).forEach(function (e) {
      var attendees = (e.attendees || []).filter(function (id) { return paid[id] !== undefined; });
      if (!attendees.length || !(e.amount > 0)) return;
      var sh = e.amount / attendees.length;
      if (paid[e.paidBy] !== undefined) paid[e.paidBy] += e.amount;
      attendees.forEach(function (id) { share[id] += sh; });
    });
    Object.keys(paid).forEach(function (k) {
      paid[k] = Math.round(paid[k] * 100) / 100;
      share[k] = Math.round(share[k] * 100) / 100;
      net[k] = Math.round((paid[k] - share[k]) * 100) / 100;
    });
    return { paid: paid, share: share, net: net };
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
    if (!state.auth) { app.innerHTML = renderLogin(); window.scrollTo(0, 0); return; }
    if (view.name === "trips") app.innerHTML = renderTrips();
    else if (view.name === "trip") app.innerHTML = renderTrip();
    else if (view.name === "overall") app.innerHTML = renderOverall();
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
        '</div>';
    } else {
      body = '<button class="overall-cta" data-action="overall">📊 Overall settlement across all trips<span class="chev">›</span></button>' +
        '<div class="stack">' + trips.map(function (t) {
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
            '<img class="brand-logo" src="icon.svg" alt="Lean" />' +
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

  // Everyone is auto-approved — except Marwan, whose expenses are flagged for review.
  function isMarwan(name) { return String(name || "").trim().toLowerCase() === "marwan"; }

  // Fraud marker shown beside a flagged person's name throughout the app.
  // The risk % is a deterministic "random" value in 65–100, derived from the
  // name so it stays stable across the ~12 places a name is rendered (a truly
  // per-render random would show different numbers for the same person at once).
  // Random fraud-risk score in 65–100%, re-rolled each time it's shown.
  function fraudScore() {
    return 65 + Math.floor(Math.random() * 36); // 65..100 inclusive
  }
  // Beside a name we show only the flag; the risk % lives with the fraud-status label.
  function fraudFlag(name) {
    return isMarwan(name)
      ? ' <span class="fraud-flag" title="Flagged for fraud — under review">🚩</span>'
      : '';
  }
  function nameHTML(name) { return esc(name) + fraudFlag(name); }

  // Standalone glowing risk badge (orb + %), no flag emoji — for placing beside
  // the "Fraud review" / "Fraud detected" labels, which already carry the 🚩.
  function fraudScoreBadge(name) {
    var p = fraudScore(name);
    return ' <span class="fraud-mark" tabindex="0" role="img" aria-label="Fraud risk ' + p + ' percent"' +
           ' title="Fraud risk ' + p + '% — flagged for review">' +
             '<span class="fraud-score"><span class="fraud-orb"></span>' + p + '%</span>' +
           '</span>';
  }

  function statusBadge(e, who) {
    var s = e.status || "autoapproved";
    if (s === "approved") return '<span class="pill pill--ok">✓ Approved</span>';
    if (s === "autoapproved") return '<span class="pill pill--ok">✓ Auto Approved</span>';
    if (s === "returned") return '<span class="pill pill--ret">⤺ Returned</span>';
    if (s === "declined") return '<span class="pill pill--ret">✕ Declined</span>';
    if (s === "flagged") return '<span class="pill pill--flag">🚩 Fraud review</span>' + fraudScoreBadge(who || e.submittedBy);
    return '<span class="pill pill--pend">⏳ Pending</span>';
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
            statusBadge(e, personName(trip, e.paidBy)) +
            '<span class="pill">' + nameHTML(personName(trip, e.paidBy)) + ' paid</span>' +
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
          '<div class="person__tap" data-action="edit-person" data-id="' + p.id + '">' +
            '<div class="avatar" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</div>' +
            '<div class="person__name">' + nameHTML(p.name) + ' <span class="edit-hint">✎</span></div>' +
          '</div>' +
          status +
          '<button class="iconbtn iconbtn--ghost" data-action="remove-person" data-id="' + p.id + '" aria-label="Remove">🗑️</button>' +
        '</div>'
      );
    }).join("") + '</div>' : '<div class="muted-note">No one added yet.</div>';

    var pool = existingNamesPool(trip);
    var picker = pool.length
      ? '<div class="addrow addrow--picker">' +
          '<select id="existingPicker" class="picker">' +
            '<option value="">＋ Add an existing person…</option>' +
            pool.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join("") +
          '</select>' +
        '</div>'
      : '';

    return (
      '<div class="addrow">' +
        '<input id="newPerson" type="text" placeholder="Type a new name…" autocomplete="off" enterkeyhint="done" />' +
        '<button class="btn" data-action="add-person">Add</button>' +
      '</div>' +
      picker +
      list +
      (people.length ? '<div class="hint" style="text-align:center;margin-top:16px">Type a new name, or pick someone from the dropdown — same spelling links the same person across cities.</div>' : '')
    );
  }

  // Rename a person; suggests names from other trips so the same person can be
  // linked across cities (the overall analysis groups people by name).
  function personEditSheet(trip, person) {
    var seen = {}, suggestions = [];
    state.trips.forEach(function (t) {
      if (t.id === trip.id) return;
      (t.people || []).forEach(function (p) {
        var k = (p.name || "").trim().toLowerCase();
        if (!k || seen[k]) return;
        var dup = (trip.people || []).some(function (x) { return x.id !== person.id && (x.name || "").trim().toLowerCase() === k; });
        if (dup) return;
        seen[k] = 1; suggestions.push((p.name || "").trim());
      });
    });
    var sugHTML = suggestions.length
      ? '<div class="field"><label>Link to someone from another trip</label>' +
          '<div class="chips" id="nameSug">' + suggestions.map(function (n) {
            return '<button type="button" class="chip" data-name="' + esc(n) + '"><span class="dot" style="background:' + colorFor(n.toLowerCase()) + '">' + esc(initials(n)) + '</span>' + esc(n) + '</button>';
          }).join("") + '</div>' +
          '<div class="hint">Pick a name to copy its exact spelling, so they count as one person across cities.</div></div>'
      : '';
    var body = '<form id="personForm">' +
      '<div class="field"><label>Name</label><input id="pname" type="text" value="' + esc(person.name) + '" autocomplete="off" required /></div>' +
      sugHTML +
      '<button type="submit" class="btn btn--block btn--lg">Save name</button>' +
      '</form>';
    openSheet("Edit person", body, function (sheet) {
      var sug = sheet.querySelector("#nameSug");
      if (sug) sug.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-name]"); if (!b) return;
        sheet.querySelector("#pname").value = b.getAttribute("data-name");
      });
      sheet.querySelector("#personForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var name = sheet.querySelector("#pname").value.trim();
        if (!name) { toast("Enter a name", "bad"); return; }
        person.name = name;
        push("addPerson", { tripId: trip.id, person: { id: person.id, name: name } });
        save(); closeSheet(); render(); toast("Name updated", "good");
      });
      setTimeout(function () { var el = sheet.querySelector("#pname"); if (el) { el.focus(); el.select(); } }, 300);
    });
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
            '<div class="settle__names"><b>' + nameHTML(personName(trip, t.from)) + '</b> <span class="settle__arrow">→</span> <b>' + nameHTML(personName(trip, t.to)) + '</b></div>' +
            '<div class="settle__amt">' + money(t.amount, trip.currency) + '</div>' +
          '</div>'
        );
      }).join("") + '</div>';
    }

    // detailed per-person analysis: paid vs share vs net
    var stats = computeStats(trip);
    var balHTML = '<div class="stack">' + people.map(function (p) {
      var b = bal[p.id] || 0;
      var cls = Math.abs(b) < 0.005 ? "" : b > 0 ? "txt-good" : "txt-bad";
      var label = Math.abs(b) < 0.005 ? "settled" : b > 0 ? "+" + money(b, trip.currency) : money(b, trip.currency);
      var sub = Math.abs(b) < 0.005 ? "all square" : b > 0 ? "gets back" : "owes";
      return (
        '<div class="person analysis">' +
          '<div class="avatar" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</div>' +
          '<div class="person__body">' +
            '<div class="person__name">' + nameHTML(p.name) + '</div>' +
            '<div class="analysis__sub">paid <b>' + money(stats.paid[p.id] || 0, trip.currency) + '</b> · share <b>' + money(stats.share[p.id] || 0, trip.currency) + '</b></div>' +
          '</div>' +
          '<div class="person__bal ' + cls + '">' + label + '<small>' + sub + '</small></div>' +
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
      '<div class="section-title" style="margin-top:22px">Split analysis · paid vs share</div>' +
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
     SCREEN: Overall settlement across all trips
     People are matched by name; trips are grouped by currency so different
     city currencies are never mixed.
     ============================================================ */
  // Combine same-pair transfers across trips, netting opposing directions.
  // Inputs/outputs use display names (not ids), since people are matched by name.
  function mergeTx(list) {
    var map = {};
    list.forEach(function (t) {
      var a = t.from, b = t.to, amt = t.amount;
      if (!a || !b || !(Math.abs(amt) > 0)) return;
      var ka = a.toLowerCase(), kb = b.toLowerCase();
      if (ka === kb) return;
      var key = ka < kb ? JSON.stringify([ka, kb]) : JSON.stringify([kb, ka]);
      if (!map[key]) map[key] = { a: ka < kb ? a : b, b: ka < kb ? b : a, amt: 0 };
      map[key].amt += (ka < kb ? amt : -amt);
    });
    var out = [];
    Object.keys(map).forEach(function (k) {
      var m = map[k], amt = Math.round(m.amt * 100) / 100;
      if (Math.abs(amt) < 0.005) return;
      if (amt > 0) out.push({ from: m.a, to: m.b, amount: amt });
      else out.push({ from: m.b, to: m.a, amount: -amt });
    });
    out.sort(function (x, y) { return y.amount - x.amount; });
    return out;
  }

  function computeOverall() {
    var groups = {}; // currency -> { people: {nameKey->{...}}, tx: [{from,to,amount}] }
    state.trips.forEach(function (trip) {
      var cur = trip.currency || "EUR";
      var st = computeStats(trip);
      if (!groups[cur]) groups[cur] = { people: {}, tx: [] };
      var gp = groups[cur].people;
      (trip.people || []).forEach(function (p) {
        var key = (p.name || "").trim().toLowerCase();
        if (!key) return;
        if (!gp[key]) gp[key] = { name: (p.name || "").trim(), net: 0, paid: 0, share: 0, trips: 0 };
        gp[key].net += st.net[p.id] || 0; gp[key].paid += st.paid[p.id] || 0; gp[key].share += st.share[p.id] || 0; gp[key].trips += 1;
      });
      // settle THIS trip within its own group, then record the transfers by name
      settle(computeBalances(trip)).forEach(function (t) {
        groups[cur].tx.push({ from: personName(trip, t.from), to: personName(trip, t.to), amount: t.amount });
      });
    });
    var out = [];
    Object.keys(groups).forEach(function (cur) {
      var people = groups[cur].people;
      Object.keys(people).forEach(function (k) {
        people[k].net = Math.round(people[k].net * 100) / 100;
        people[k].paid = Math.round(people[k].paid * 100) / 100;
        people[k].share = Math.round(people[k].share * 100) / 100;
      });
      var rows = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return b.net - a.net; });
      var total = rows.reduce(function (s, r) { return s + (r.paid || 0); }, 0);
      out.push({ currency: cur, settle: mergeTx(groups[cur].tx), rows: rows, total: Math.round(total * 100) / 100 });
    });
    out.sort(function (a, b) { return b.rows.length - a.rows.length; });
    return out;
  }

  function rateFor(cur) {
    if (state.rates && typeof state.rates[cur] === "number" && state.rates[cur] > 0) return state.rates[cur];
    return SAR_RATES[cur] || 1;
  }

  // Convert every trip to SAR and net each person across all trips, then apply
  // confirmed overall settlements and settle the remaining balance. This is THE
  // combined cross-trip settlement, where payments are marked/confirmed.
  function computeOverallSAR() {
    var people = {};
    state.trips.forEach(function (trip) {
      var rate = rateFor(trip.currency || "EUR");
      var st = computeStats(trip);
      (trip.people || []).forEach(function (p) {
        var key = (p.name || "").trim().toLowerCase(); if (!key) return;
        if (!people[key]) people[key] = { key: key, name: (p.name || "").trim(), net: 0, paid: 0, share: 0 };
        people[key].net += (st.net[p.id] || 0) * rate;
        people[key].paid += (st.paid[p.id] || 0) * rate;
        people[key].share += (st.share[p.id] || 0) * rate;
      });
    });
    // confirmed settlements (global, by name key, in SAR) move real money:
    // the payer owes less, the payee is owed less.
    (state.settlements || []).forEach(function (s) {
      if (s.status !== "confirmed") return;
      if (!people[s.from]) people[s.from] = { key: s.from, name: s.from, net: 0, paid: 0, share: 0 };
      if (!people[s.to]) people[s.to] = { key: s.to, name: s.to, net: 0, paid: 0, share: 0 };
      people[s.from].net += s.amount;
      people[s.to].net -= s.amount;
    });
    Object.keys(people).forEach(function (k) {
      people[k].net = Math.round(people[k].net * 100) / 100;
      people[k].paid = Math.round(people[k].paid * 100) / 100;
      people[k].share = Math.round(people[k].share * 100) / 100;
    });
    var bal = {}; Object.keys(people).forEach(function (k) { bal[k] = people[k].net; });
    var tx = settle(bal).map(function (t) {
      return { fromKey: t.from, toKey: t.to,
        from: people[t.from] ? people[t.from].name : t.from,
        to: people[t.to] ? people[t.to].name : t.to, amount: t.amount };
    });
    var rows = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return b.net - a.net; });
    var total = rows.reduce(function (s, r) { return s + (r.paid || 0); }, 0);
    return { settle: tx, rows: rows, total: Math.round(total * 100) / 100 };
  }

  // Sheet to edit exchange rates (SAR per 1 unit) for the currencies in use.
  function ratesSheet() {
    var curs = {}; state.trips.forEach(function (t) { curs[t.currency || "EUR"] = 1; });
    var list = Object.keys(curs).filter(function (c) { return c !== "SAR"; });
    if (!list.length) { toast("All trips are already in SAR — nothing to convert"); return; }
    var rows = list.map(function (c) {
      return '<div class="field"><label>1 ' + esc(c) + ' &nbsp;=&nbsp; ? SAR</label>' +
        '<input type="number" step="0.0001" min="0" inputmode="decimal" data-cur="' + esc(c) + '" value="' + rateFor(c) + '" /></div>';
    }).join("");
    var body = '<form id="ratesForm">' + rows +
      '<button type="submit" class="btn btn--block btn--lg">Save rates</button>' +
      '<div class="hint" style="text-align:center;margin-top:10px">Used to convert every trip into Saudi Riyal in the overall analysis.</div></form>';
    openSheet("Exchange rates → SAR", body, function (sheet) {
      sheet.querySelector("#ratesForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (!state.rates) state.rates = {};
        sheet.querySelectorAll("input[data-cur]").forEach(function (inp) {
          var v = parseFloat(inp.value);
          if (v > 0) state.rates[inp.getAttribute("data-cur")] = v;
        });
        save(); closeSheet(); render(); toast("Rates updated", "good");
      });
    });
  }

  function renderOverall() {
    var groups = computeOverall();
    var nTrips = state.trips.length;
    var nameSet = {};
    state.trips.forEach(function (t) { (t.people || []).forEach(function (p) { var k = (p.name || "").trim().toLowerCase(); if (k) nameSet[k] = 1; }); });
    var nPeople = Object.keys(nameSet).length;

    var inner;
    if (!nTrips || !groups.length) {
      inner = emptyBox("📊", "Nothing to analyze yet", "Add trips with expenses and you'll see one combined settlement for everyone across all of them here.", null, null);
    } else {
      inner = groups.map(function (g) {
        var settleHTML;
        if (!g.settle.length) {
          settleHTML = '<div class="card" style="text-align:center;padding:20px"><div style="font-size:30px">🎉</div>' +
            '<div style="font-weight:700;margin-top:6px">All settled in ' + esc(g.currency) + '</div></div>';
        } else {
          settleHTML = '<div class="stack">' + g.settle.map(function (t) {
            return '<div class="settle">' +
              '<div class="avatar" style="background:' + colorFor(t.from.toLowerCase()) + '">' + esc(initials(t.from)) + '</div>' +
              '<div class="settle__names"><b>' + nameHTML(t.from) + '</b> <span class="settle__arrow">→</span> <b>' + nameHTML(t.to) + '</b></div>' +
              '<div class="settle__amt">' + money(t.amount, g.currency) + '</div>' +
            '</div>';
          }).join("") + '</div>';
        }
        var rowsHTML = '<div class="stack">' + g.rows.map(function (r) {
          var cls = Math.abs(r.net) < 0.005 ? "" : r.net > 0 ? "txt-good" : "txt-bad";
          var label = Math.abs(r.net) < 0.005 ? "settled" : r.net > 0 ? "+" + money(r.net, g.currency) : money(r.net, g.currency);
          var sub = Math.abs(r.net) < 0.005 ? "all square" : r.net > 0 ? "gets back" : "owes";
          return '<div class="person analysis">' +
            '<div class="avatar" style="background:' + colorFor(r.name.toLowerCase()) + '">' + esc(initials(r.name)) + '</div>' +
            '<div class="person__body"><div class="person__name">' + nameHTML(r.name) + '</div>' +
              '<div class="analysis__sub">paid <b>' + money(r.paid, g.currency) + '</b> · share <b>' + money(r.share, g.currency) + '</b> · ' + r.trips + (r.trips === 1 ? " trip" : " trips") + '</div></div>' +
            '<div class="person__bal ' + cls + '">' + label + '<small>' + sub + '</small></div>' +
          '</div>';
        }).join("") + '</div>';
        return '<div class="cur-group">' +
          '<div class="cur-head"><span class="cur-badge">' + esc(g.currency) + '</span>' +
            '<span class="cur-total">' + money(g.total, g.currency) + ' · ' + g.rows.length + (g.rows.length === 1 ? " person" : " people") + '</span></div>' +
          '<div class="section-title">Who pays whom</div>' + settleHTML +
          '<div class="section-title" style="margin-top:18px">Each person</div>' + rowsHTML +
        '</div>';
      }).join('<hr class="divider" style="margin:22px 0">');
    }

    // Combined "everything in SAR" rollup — the headline of the analysis.
    var sarSection = "";
    if (groups.length) {
      var sar = computeOverallSAR();
      var myKey = myNameKey();
      var nameByKey = {}; sar.rows.forEach(function (r) { nameByKey[r.key] = r.name; });
      var pendingS = {};
      (state.settlements || []).forEach(function (s) { if (s.status === "proposed") pendingS[s.from + "|" + s.to] = s; });
      var sarSettle = !sar.settle.length
        ? '<div class="card" style="text-align:center;padding:20px"><div style="font-size:30px">🎉</div><div style="font-weight:700;margin-top:6px">Everyone is settled up</div></div>'
        : '<div class="stack">' + sar.settle.map(function (t) {
            var amParty = myKey && (myKey === t.fromKey || myKey === t.toKey);
            var pend = pendingS[t.fromKey + "|" + t.toKey];
            var action = "";
            if (pend) {
              var iProposed = myKey && String(pend.proposedBy || "").trim().toLowerCase() === myKey;
              action = '<div class="settle__foot">' +
                '<span class="settle__pending">⏳ ' + esc(pend.proposedBy || "Someone") + ' marked this paid' + (iProposed ? " — awaiting the other party" : "") + '</span>' +
                (amParty && !iProposed ? '<button class="btn btn--ok btn--xs" data-action="confirm-settlement" data-id="' + esc(pend.id) + '">✓ Confirm</button>' : '') +
                (amParty ? '<button class="btn btn--ghost btn--xs" data-action="cancel-settlement" data-id="' + esc(pend.id) + '">Cancel</button>' : '') +
                '</div>';
            } else if (amParty) {
              var lbl = myKey === t.fromKey ? "I paid this" : "Mark received";
              action = '<div class="settle__foot">' +
                '<button class="btn btn--soft btn--xs" data-action="propose-settlement" data-from="' + esc(t.fromKey) + '" data-to="' + esc(t.toKey) + '" data-amount="' + t.amount + '">' + lbl + '</button></div>';
            }
            return '<div class="settle-row' + (pend ? " pending" : "") + '">' +
                '<div class="settle__main">' +
                  '<div class="avatar" style="background:' + colorFor(t.fromKey) + '">' + esc(initials(t.from)) + '</div>' +
                  '<div class="settle__names"><b>' + nameHTML(t.from) + '</b> <span class="settle__arrow">→</span> <b>' + nameHTML(t.to) + '</b></div>' +
                  '<div class="settle__amt">' + money(t.amount, "SAR") + '</div>' +
                '</div>' + action +
              '</div>';
          }).join("") + '</div>';
      var confirmedS = (state.settlements || []).filter(function (s) { return s.status === "confirmed"; });
      var sarDone = confirmedS.length
        ? '<div class="section-title" style="margin-top:20px">✓ Settled payments</div><div class="stack">' + confirmedS.map(function (s) {
            var fromNm = nameByKey[s.from] || s.from, toNm = nameByKey[s.to] || s.to;
            var amParty = myKey && (myKey === s.from || myKey === s.to);
            return '<div class="settle-row done">' +
              '<div class="settle__main">' +
                '<div class="avatar" style="background:' + colorFor(s.from) + '">' + esc(initials(fromNm)) + '</div>' +
                '<div class="settle__names"><b>' + nameHTML(fromNm) + '</b> <span class="settle__arrow">→</span> <b>' + nameHTML(toNm) + '</b>' +
                  '<div class="settle__sub">✓ confirmed by ' + esc(s.confirmedBy || "") + '</div></div>' +
                '<div class="settle__amt">' + money(s.amount, "SAR") + '</div>' +
              '</div>' +
              (amParty ? '<div class="settle__foot"><button class="btn btn--ghost btn--xs" data-action="cancel-settlement" data-id="' + esc(s.id) + '">↺ Undo</button></div>' : '') +
            '</div>';
          }).join("") + '</div>'
        : "";
      var sarRows = '<div class="stack">' + sar.rows.map(function (r) {
        var cls = Math.abs(r.net) < 0.005 ? "" : r.net > 0 ? "txt-good" : "txt-bad";
        var label = Math.abs(r.net) < 0.005 ? "settled" : r.net > 0 ? "+" + money(r.net, "SAR") : money(r.net, "SAR");
        var sub = Math.abs(r.net) < 0.005 ? "all square" : r.net > 0 ? "gets back" : "owes";
        return '<div class="person analysis"><div class="avatar" style="background:' + colorFor(r.name.toLowerCase()) + '">' + esc(initials(r.name)) + '</div>' +
          '<div class="person__body"><div class="person__name">' + nameHTML(r.name) + '</div>' +
          '<div class="analysis__sub">paid <b>' + money(r.paid, "SAR") + '</b> · share <b>' + money(r.share, "SAR") + '</b></div></div>' +
          '<div class="person__bal ' + cls + '">' + label + '<small>' + sub + '</small></div></div>';
      }).join("") + '</div>';
      sarSection =
        '<div class="summary">' +
          '<div class="summary__label">Combined · all trips in Saudi Riyal</div>' +
          '<div class="summary__total">' + money(sar.total, "SAR") + '</div>' +
          '<div class="summary__grid">' +
            '<div class="summary__stat"><b>' + sar.rows.length + '</b><span>people</span></div>' +
            '<div class="summary__stat"><b>' + nTrips + '</b><span>trips</span></div>' +
            '<div class="summary__stat"><b>' + sar.settle.length + '</b><span>payments</span></div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 4px 10px">' +
          '<div class="section-title" style="margin:0">Who pays whom · SAR</div>' +
          '<button class="linkbtn" data-action="edit-rates">Edit rates</button>' +
        '</div>' +
        sarSettle +
        sarDone +
        '<div class="section-title" style="margin-top:18px">Each person · SAR</div>' +
        sarRows;
    }

    var content = (!nTrips || !groups.length)
      ? inner
      : ('<div class="muted-note" style="margin:-2px 0 14px">People are matched by name. Foreign currencies are converted to SAR at your set rates.</div>' +
         sarSection +
         '<hr class="divider" style="margin:24px 0 16px">' +
         '<div class="section-title">Per-currency breakdown</div>' +
         inner);

    return (
      '<div class="app">' +
        '<header class="appbar">' +
          '<div class="appbar__row">' +
            '<button class="iconbtn" data-action="back-home" aria-label="Back">‹</button>' +
            '<div style="min-width:0">' +
              '<div class="appbar__title"><span style="flex:none">📊</span><span class="ttl">Overall settlement</span></div>' +
              '<div class="appbar__sub">Across ' + nTrips + (nTrips === 1 ? " trip" : " trips") + ' · ' + nPeople + (nPeople === 1 ? " person" : " people") + '</div>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<main class="content">' + content + '</main>' +
      '</div>'
    );
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
          var same = state.trips.filter(function (t) { return (t.name || "").trim().toLowerCase() === name.toLowerCase(); })[0];
          if (same && confirm('You already have a trip called "' + name + '".\n\nOK = open the existing one  ·  Cancel = create a separate new trip')) {
            save(); closeSheet();
            view = { name: "trip", tripId: same.id, tab: "expenses" };
            render();
            return;
          }
          var nt = { id: uid(), code: shortCode(), name: name, currency: currency, emoji: chosen, createdAt: Date.now(), people: [], expenses: [] };
          // add the signed-in person so the new trip shows up for them
          if (state.auth && state.auth.name) nt.people.push({ id: uid(), name: state.auth.name });
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
          '<span class="dot" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</span>' + nameHTML(p.name) + '</button>';
      }).join("");
    }
    function attendChips() {
      return people.map(function (p) {
        var on = attendees.indexOf(p.id) >= 0;
        return '<button type="button" class="chip attend attend-chip' + (on ? " sel attend" : "") + '" data-id="' + p.id + '">' +
          '<span class="dot" style="background:' + colorFor(p.id) + '">' + esc(initials(p.name)) + '</span>' + nameHTML(p.name) +
          '<span class="chip__check">' + (on ? "✓" : "") + '</span></button>';
      }).join("");
    }
    function photoBlock() {
      if (draftPhoto) {
        return '<div class="photo-preview"><img src="' + draftPhoto + '" alt="invoice" id="photoImg">' +
          '<button type="button" class="photo-preview__remove" id="photoRemove" aria-label="Remove photo">✕</button></div>';
      }
      return '<div class="photo-actions">' +
        '<button type="button" class="photo-btn" id="pickCam"><span class="ic">📷</span>Take photo</button>' +
        '<button type="button" class="photo-btn" id="pickLib"><span class="ic">🖼️</span>Photo library</button>' +
        '</div>';
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
          '<input id="photoCam" type="file" accept="image/*" capture="environment" class="hidden" />' +
          '<input id="photoLib" type="file" accept="image/*" class="hidden" /></div>' +
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

      function handlePhotoFile(f) {
        if (!f) return;
        toast("Processing photo…");
        fileToCompressedDataURL(f, function (data) {
          if (!data) { toast("Couldn't read that image", "bad"); return; }
          draftPhoto = data;
          sheet.querySelector("#photoBlock").innerHTML = photoBlock();
          bindPhoto();
        });
      }
      function bindPhoto() {
        var rm = sheet.querySelector("#photoRemove");
        if (rm) rm.addEventListener("click", function () { draftPhoto = null; sheet.querySelector("#photoBlock").innerHTML = photoBlock(); bindPhoto(); });
        var img = sheet.querySelector("#photoImg");
        if (img) img.addEventListener("click", function () { openLightbox(draftPhoto); });
        var cam = sheet.querySelector("#pickCam");
        if (cam) cam.addEventListener("click", function () { sheet.querySelector("#photoCam").click(); });
        var lib = sheet.querySelector("#pickLib");
        if (lib) lib.addEventListener("click", function () { sheet.querySelector("#photoLib").click(); });
      }
      sheet.querySelector("#photoCam").addEventListener("change", function () { handlePhotoFile(this.files && this.files[0]); });
      sheet.querySelector("#photoLib").addEventListener("change", function () { handlePhotoFile(this.files && this.files[0]); });
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
          // Keep the existing approval status — don't reset a decision on edit.
          Object.keys(payload).forEach(function (k) { existing[k] = payload[k]; });
          push("saveExpense", { tripId: trip.id, expense: existing });
          toast("Expense saved", "good");
        } else {
          payload.id = uid(); payload.createdAt = Date.now();
          payload.submittedBy = (state.auth && state.auth.name) || "";
          // Auto-approve everyone — except Marwan, whose submissions go to review.
          payload.status = isMarwan(payload.submittedBy) ? "flagged" : "autoapproved";
          payload.returnMessage = "";
          trip.expenses.push(payload);
          push("saveExpense", { tripId: trip.id, expense: payload });
          toast(payload.status === "flagged"
            ? "Submitted — flagged for review by higher management"
            : "Expense added — auto approved ✓", payload.status === "flagged" ? "" : "good");
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
        nameHTML(personName(trip, id)) + '</span>';
    }).join("");

    var isAdmin = state.auth && state.auth.isAdmin;
    var st = e.status || "autoapproved";
    var smsg = e.returnMessage ? '<div class="status-msg">“' + esc(e.returnMessage) + '”</div>' : '';
    var banner =
        st === "approved"     ? '<div class="status-banner ok">✓ Approved by higher management</div>'
      : st === "autoapproved" ? '<div class="status-banner ok">✓ Auto Approved</div>'
      : st === "returned"     ? '<div class="status-banner bad">⤺ Returned by higher management' + smsg + '</div>'
      : st === "declined"     ? '<div class="status-banner bad">✕ Declined by higher management' + smsg + '</div>'
      : st === "flagged"      ? '<div class="status-banner flag">🚩 Fraud detected — needs to be reviewed by higher management' + fraudScoreBadge(personName(trip, e.paidBy)) + '</div>'
      :                         '<div class="status-banner pend">⏳ Pending approval from higher management</div>';
    var adminActions = isAdmin
      ? '<div class="section-title">Higher management</div>' +
        '<button class="btn btn--ok btn--block" id="approveExp" style="margin-bottom:8px">✓ Approve</button>' +
        '<div class="field__row" style="margin-bottom:10px;gap:8px">' +
          '<button class="btn btn--warn" id="returnExp" style="flex:1">⤺ Return</button>' +
          '<button class="btn btn--danger" id="declineExp" style="flex:1">✕ Decline</button>' +
        '</div>'
      : '';

    var body =
      (e.photo ? '<img src="' + e.photo + '" class="detail-photo" id="detailPhoto" alt="invoice" />' : '') +
      banner +
      '<div class="card stack" style="margin-bottom:14px">' +
        '<div style="font-size:20px;font-weight:750">' + esc(e.title) + '</div>' +
        '<div style="font-size:30px;font-weight:800;color:var(--primary-dark)">' + money(e.amount, trip.currency) + '</div>' +
        '<div class="kv"><span>Date</span><b>' + esc(fmtDateLong(e.date)) + '</b></div>' +
        '<div class="kv"><span>Paid by</span><b>' + nameHTML(personName(trip, e.paidBy)) + '</b></div>' +
        (e.submittedBy ? '<div class="kv"><span>Submitted by</span><b>' + esc(e.submittedBy) + '</b></div>' : '') +
        '<div class="kv"><span>Split between</span><b>' + n + (n === 1 ? " person" : " people") + '</b></div>' +
        '<div class="kv"><span>Each pays</span><b>' + money(share, trip.currency) + '</b></div>' +
        (e.note ? '<div class="kv"><span>Note</span><b style="text-align:right;max-width:60%">' + esc(e.note) + '</b></div>' : '') +
      '</div>' +
      '<div class="section-title">Attended</div>' +
      '<div class="chips" style="margin-bottom:18px">' + attendeeList + '</div>' +
      adminActions +
      '<button class="btn btn--block btn--soft" id="editExp">✏️ Edit expense</button>' +
      (state.trips.length > 1 ? '<button class="btn btn--block btn--soft" id="moveExp" style="margin-top:10px">📦 Move to another city</button>' : '');

    openSheet("Expense", body, function (sheet) {
      var dp = sheet.querySelector("#detailPhoto");
      if (dp) dp.addEventListener("click", function () { openLightbox(e.photo); });
      var ap = sheet.querySelector("#approveExp");
      if (ap) ap.addEventListener("click", function () { reviewExpense(trip, e, "approved"); closeSheet(); });
      var rt = sheet.querySelector("#returnExp");
      if (rt) rt.addEventListener("click", function () { closeSheet(true); returnExpenseSheet(trip, e); });
      var dc = sheet.querySelector("#declineExp");
      if (dc) dc.addEventListener("click", function () {
        if (confirm("Decline this expense? The submitter will see it as declined.")) { reviewExpense(trip, e, "declined"); closeSheet(); }
      });
      sheet.querySelector("#editExp").addEventListener("click", function () {
        closeSheet(true); expenseFormSheet(trip, e);
      });
      var mv = sheet.querySelector("#moveExp");
      if (mv) mv.addEventListener("click", function () { closeSheet(true); moveExpenseSheet(trip, e); });
    });
  }

  // Admin: approve or return an expense (with a reason).
  function reviewExpense(trip, e, status, message) {
    e.status = status;
    e.returnMessage = (status === "returned" || status === "declined") ? (message || "") : "";
    save(); render();
    var t = status === "approved" ? "Expense approved ✓"
          : status === "declined" ? "Expense declined ✕"
          : "Expense returned ⤺";
    toast(t, status === "approved" ? "good" : "");
    api("reviewExpense", {
      name: state.auth && state.auth.name, code: state.auth && state.auth.code,
      tripId: trip.id, expenseId: e.id, status: status, message: e.returnMessage
    }).catch(function () { toast("Couldn't sync the decision — check your connection", "bad"); });
  }

  var RETURN_MESSAGES = [
    "Fraud detected, GRC will review it and get back to you",
    "Your expense is not approved due to budget issues"
  ];
  function returnExpenseSheet(trip, e) {
    var body = RETURN_MESSAGES.map(function (m, i) {
      return '<button class="btn btn--block btn--soft return-msg" data-i="' + i + '" style="text-align:left;white-space:normal;height:auto;padding:15px;margin-bottom:10px">' + esc(m) + '</button>';
    }).join("") +
    '<div class="hint" style="text-align:center;margin-top:4px">Pick a reason — the member sees it on the returned expense.</div>';
    openSheet("Return expense", body, function (sheet) {
      sheet.querySelectorAll(".return-msg").forEach(function (b) {
        b.addEventListener("click", function () {
          reviewExpense(trip, e, "returned", RETURN_MESSAGES[+b.getAttribute("data-i")]);
          closeSheet();
        });
      });
    });
  }

  /* ---------- Settlement approval (two-step: propose, other party confirms) ---------- */
  // Settlements are global (overall, by name key, in SAR).
  function proposeSettlement(fromKey, toKey, amount) {
    var s = { id: uid(), from: fromKey, to: toKey, amount: amount, status: "proposed",
              proposedBy: (state.auth && state.auth.name) || "", confirmedBy: "", createdAt: Date.now() };
    state.settlements.push(s);
    save(); render();
    toast("Marked as paid — waiting for the other party to confirm");
    api("proposeSettlement", { id: s.id, from: fromKey, to: toKey, amount: amount,
      name: state.auth && state.auth.name, code: state.auth && state.auth.code })
      .then(function (r) {
        if (r && r.ok === false) {
          state.settlements = state.settlements.filter(function (x) { return x.id !== s.id; });
          render(); toast(r.error === "not a party" ? "Only the two people in this payment can settle it" : "Couldn't record that", "bad");
        }
      }).catch(function () {});
  }
  function confirmSettlement(id) {
    var s = (state.settlements || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    s.status = "confirmed"; s.confirmedBy = (state.auth && state.auth.name) || "";
    save(); render();
    toast("Settlement confirmed ✓", "good");
    api("confirmSettlement", { id: id, name: state.auth && state.auth.name, code: state.auth && state.auth.code })
      .then(function (r) {
        if (r && r.ok === false) {
          s.status = "proposed"; s.confirmedBy = ""; render();
          toast(r.error === "the other party must confirm" ? "The other party has to confirm this one" : "Couldn't confirm", "bad");
        }
      }).catch(function () {});
  }
  function cancelSettlement(id) {
    state.settlements = (state.settlements || []).filter(function (x) { return x.id !== id; });
    save(); render();
    api("cancelSettlement", { id: id, name: state.auth && state.auth.name, code: state.auth && state.auth.code }).catch(function () {});
  }

  /* ---------- Move an expense to another city ---------- */
  function convertAmount(amount, fromCur, toCur) {
    if (String(fromCur || "") === String(toCur || "")) return amount;
    var v = amount * rateFor(fromCur) / rateFor(toCur);
    return Math.round(v * 100) / 100;
  }
  function moveExpenseSheet(trip, e) {
    var others = state.trips.filter(function (t) { return t.id !== trip.id; });
    if (!others.length) { toast("No other city yet — create another trip first"); return; }
    var body = '<div class="hint" style="margin-bottom:14px">Move “' + esc(e.title) + '” (' + money(e.amount, trip.currency) +
        ') to another city. People are matched by name; anyone missing is added there.</div>' +
      '<div class="stack">' + others.map(function (t) {
        var conv = "";
        if (String(t.currency || "") !== String(trip.currency || "")) {
          conv = '<div class="settle__sub">converts to ' + money(convertAmount(e.amount, trip.currency, t.currency), t.currency) + '</div>';
        }
        return '<button class="btn btn--block btn--soft move-target" data-id="' + esc(t.id) + '" style="text-align:left;height:auto;padding:13px 15px;margin-bottom:8px">' +
          '<span style="font-size:18px;margin-right:8px">' + (t.emoji || "🏙️") + '</span>' + esc(t.name) + ' · ' + esc(t.currency || "") + conv + '</button>';
      }).join("") + '</div>';
    openSheet("Move to another city", body, function (sheet) {
      sheet.querySelectorAll(".move-target").forEach(function (b) {
        b.addEventListener("click", function () {
          var dest = getTrip(b.getAttribute("data-id")); if (dest) doMoveExpense(trip, e, dest);
        });
      });
    });
  }
  function doMoveExpense(trip, e, dest) {
    var newAmount = convertAmount(e.amount, trip.currency, dest.currency);
    var msg = "Move “" + e.title + "” to " + dest.name + "?";
    if (newAmount !== e.amount) msg += "\n\nAmount converts " + money(e.amount, trip.currency) + " → " + money(newAmount, dest.currency) + ".";
    if (!confirm(msg)) return;
    trip.expenses = (trip.expenses || []).filter(function (x) { return x.id !== e.id; }); // optimistic
    save(); closeSheet(); render(); toast("Moving…");
    api("moveExpense", { fromTripId: trip.id, toTripId: dest.id, expenseId: e.id, amount: newAmount,
      name: state.auth && state.auth.name, code: state.auth && state.auth.code })
      .then(function (r) {
        if (r && r.ok) {
          pullTrip({ id: dest.id }, function () { pullTrip({ id: trip.id }, function () { render(); toast("Moved to " + dest.name + " ✓", "good"); }); });
        } else {
          pullTrip({ id: trip.id }, function () { render(); });
          toast(r && r.error ? "Couldn't move: " + r.error : "Couldn't move the expense", "bad");
        }
      })
      .catch(function () { pullTrip({ id: trip.id }, function () { render(); }); toast("Couldn't move — check your connection", "bad"); });
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
    var who = state.auth ? (esc(state.auth.name) + (state.auth.isAdmin ? " · admin" : "")) : "";
    var body =
      '<div class="hint" style="text-align:left;margin:-2px 0 14px">Signed in as <b style="color:var(--ink)">' + who + '</b></div>' +
      '<button class="btn btn--block btn--soft" data-m="export" style="margin-bottom:10px">⬇️ Export my data (JSON backup)</button>' +
      '<button class="btn btn--block btn--danger" data-m="logout">🔒 Log out</button>';
    openSheet("TripSplit", body, function (sheet) {
      sheet.querySelector('[data-m="export"]').addEventListener("click", function () { closeSheet(); exportData(null); });
      sheet.querySelector('[data-m="logout"]').addEventListener("click", function () {
        closeSheet();
        if (confirm("Log out of TripSplit?")) { clearAuth(); state.auth = null; state.trips = []; save(); stopPolling(); view = { name: "trips" }; render(); }
      });
    });
  }

  function exportData(trip) {
    // Never include auth (name + code) in an exported backup.
    var data = trip
      ? { trips: [trip], lastCurrency: state.lastCurrency }
      : { trips: state.trips, lastCurrency: state.lastCurrency, rates: state.rates };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (trip ? "tripsplit-" + trip.name.replace(/\s+/g, "-").toLowerCase() : "tripsplit-backup") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Backup downloaded", "good");
  }


  /* ============================================================
     People add/remove
     ============================================================ */
  // Names already in your other cities + the user directory, minus this trip's
  // people — used for the "add existing person" dropdown.
  function existingNamesPool(trip) {
    var inTrip = {};
    (trip.people || []).forEach(function (p) { inTrip[String(p.name || "").trim().toLowerCase()] = 1; });
    var pool = {};
    state.trips.forEach(function (t) {
      (t.people || []).forEach(function (p) {
        var key = String(p.name || "").trim().toLowerCase();
        if (key && !inTrip[key]) pool[key] = String(p.name).trim();
      });
    });
    memberDirectory.forEach(function (n) {
      var key = String(n || "").trim().toLowerCase();
      if (key && !inTrip[key]) pool[key] = n;
    });
    return Object.keys(pool).sort().map(function (k) { return pool[k]; });
  }
  // Add a person by name (deduped, case-insensitive). Returns true if added.
  function addPersonNamed(name) {
    var trip = getTrip(view.tripId); if (!trip) return false;
    name = String(name || "").trim();
    if (!name) return false;
    var key = name.toLowerCase();
    if ((trip.people || []).some(function (p) { return String(p.name || "").trim().toLowerCase() === key; })) {
      toast(name + " is already in this city"); return false;
    }
    var person = { id: uid(), name: name };
    trip.people.push(person);
    push("addPerson", { tripId: trip.id, person: person });
    save(); render();
    return true;
  }
  function addPersonFromInput() {
    var input = document.getElementById("newPerson");
    if (!input) return;
    if (addPersonNamed(input.value)) {
      var again = document.getElementById("newPerson"); if (again) again.focus(); // fast multi-add
    } else { input.focus(); }
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
      case "do-login": {
        var nmEl = document.getElementById("loginName"), cdEl = document.getElementById("loginCode");
        var rmEl = document.getElementById("rememberMe");
        var nm = (nmEl && nmEl.value || "").trim(), cd = (cdEl && cdEl.value || "").trim();
        var remember = rmEl ? !!rmEl.checked : true;
        if (!nm || !cd) { toast("Enter your name and code", "bad"); break; }
        toast("Signing in…");
        doLogin(nm, cd, remember, function (ok) {
          if (ok) { view = { name: "trips" }; render(); stopPolling(); startPolling(); refreshMemberDirectory(); toast("Welcome, " + state.auth.name + " 👋", "good"); }
          else { toast("Wrong name or code", "bad"); }
        });
        break;
      }
      case "logout":
        if (confirm("Log out of TripSplit?")) { clearAuth(); state.auth = null; state.trips = []; save(); stopPolling(); view = { name: "trips" }; render(); }
        break;
      case "new-trip": tripFormSheet(null); break;
      case "menu": appMenuSheet(); break;
      case "overall": view = { name: "overall" }; render(); refreshSettlements(); break;
      case "back-home": view = { name: "trips" }; render(); break;
      case "edit-rates": ratesSheet(); break;
      case "open-trip": view = { name: "trip", tripId: id, tab: "expenses" }; render(); break;
      case "back": view = { name: "trips" }; render(); break;
      case "tab": view.tab = el.getAttribute("data-tab"); render(); break;
      case "trip-menu": if (trip) tripMenuSheet(trip); break;
      case "add-expense": if (trip) expenseFormSheet(trip, null); break;
      case "open-expense":
        if (trip) { var e = trip.expenses.filter(function (x) { return x.id === id; })[0]; if (e) expenseDetailSheet(trip, e); }
        break;
      case "add-person": addPersonFromInput(); break;
      case "edit-person":
        if (trip) { var per = (trip.people || []).filter(function (x) { return x.id === id; })[0]; if (per) personEditSheet(trip, per); }
        break;
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
      case "propose-settlement":
        proposeSettlement(el.getAttribute("data-from"), el.getAttribute("data-to"), parseFloat(el.getAttribute("data-amount")));
        break;
      case "confirm-settlement": confirmSettlement(id); break;
      case "cancel-settlement": cancelSettlement(id); break;
    }
  });

  // "Add existing person" dropdown in the People tab
  document.addEventListener("change", function (ev) {
    var sel = ev.target;
    if (sel && sel.id === "existingPicker" && sel.value) {
      addPersonNamed(sel.value);
      sel.value = "";
    }
  });

  // Enter key adds a person quickly
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target && ev.target.id === "newPerson") {
      ev.preventDefault(); addPersonFromInput();
    }
    if (ev.key === "Enter" && ev.target && (ev.target.id === "loginName" || ev.target.id === "loginCode")) {
      ev.preventDefault();
      var btn = document.querySelector('[data-action="do-login"]'); if (btn) btn.click();
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
    if (view.name === "trip" || view.name === "overall") { view = { name: "trips" }; render(); }
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
  window.__tripsplit = { state: function () { return state; }, render: render, go: function (v) { view = v; render(); } };
})();
