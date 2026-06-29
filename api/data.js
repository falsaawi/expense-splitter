// TripSplit backend — a single serverless endpoint backed by Neon Postgres.
// All operations come in as POST { op, ...payload }. Kept in one function so it
// works within Vercel's function limits and is easy to reason about.

import { neon } from "@neondatabase/serverless";

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  "";

const sql = CONN ? neon(CONN) : null;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    emoji TEXT,
    created_at BIGINT,
    updated_at BIGINT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    name TEXT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    title TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    date TEXT,
    paid_by TEXT,
    attendees JSONB DEFAULT '[]'::jsonb,
    photo TEXT,
    note TEXT,
    created_at BIGINT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_people_trip ON people(trip_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id)`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS return_message TEXT`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS submitted_by TEXT`;
  // New model: auto-approve everyone except Marwan (flagged for review). Migrate
  // any legacy 'pending' rows once — Marwan's (by payer) are flagged, rest auto-approved.
  await sql`UPDATE expenses SET status = 'flagged'
            WHERE status = 'pending'
              AND paid_by IN (SELECT id FROM people WHERE lower(btrim(name)) = 'marwan')`;
  await sql`UPDATE expenses SET status = 'autoapproved' WHERE status = 'pending'`;
  await sql`CREATE TABLE IF NOT EXISTS deleted_trips (id TEXT PRIMARY KEY, deleted_at BIGINT)`;
  await sql`CREATE TABLE IF NOT EXISTS members (name_key TEXT PRIMARY KEY, name TEXT, code TEXT, is_admin BOOLEAN DEFAULT false)`;
  // Settlement payments between two people in a trip. status: proposed | confirmed.
  await sql`CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    from_person TEXT NOT NULL,
    to_person TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'proposed',
    proposed_by TEXT,
    confirmed_by TEXT,
    created_at BIGINT,
    confirmed_at BIGINT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_settlements_trip ON settlements(trip_id)`;
  schemaReady = true;
}

// Settlements are global (cross-trip), between two people by name key, in SAR.
const OVERALL = "__overall__";
function mapSettlement(s) {
  return {
    id: s.id,
    from: s.from_person,
    to: s.to_person,
    amount: Number(s.amount),
    status: s.status || "proposed",
    proposedBy: s.proposed_by || "",
    confirmedBy: s.confirmed_by || "",
    createdAt: Number(s.created_at) || 0,
  };
}
async function overallSettlements() {
  const rows = await sql`SELECT * FROM settlements WHERE trip_id = ${OVERALL} ORDER BY created_at`;
  return rows.map(mapSettlement);
}

async function assembleTrip(row) {
  if (!row) return null;
  const people = await sql`SELECT id, name FROM people WHERE trip_id = ${row.id} ORDER BY name`;
  const expenses = await sql`SELECT * FROM expenses WHERE trip_id = ${row.id} ORDER BY date DESC NULLS LAST, created_at DESC`;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    emoji: row.emoji,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    people: people.map((p) => ({ id: p.id, name: p.name })),
    expenses: expenses.map((e) => ({
      id: e.id,
      title: e.title,
      amount: Number(e.amount),
      date: e.date,
      paidBy: e.paid_by,
      attendees: Array.isArray(e.attendees) ? e.attendees : [],
      photo: e.photo || null,
      note: e.note || "",
      status: e.status || "autoapproved",
      returnMessage: e.return_message || "",
      submittedBy: e.submitted_by || "",
      createdAt: Number(e.created_at) || 0,
    })),
  };
}

async function getTripById(id) {
  const rows = await sql`SELECT * FROM trips WHERE id = ${id}`;
  return assembleTrip(rows[0]);
}
async function getTripByCode(code) {
  const rows = await sql`SELECT * FROM trips WHERE code = ${code}`;
  return assembleTrip(rows[0]);
}

async function upsertTripRow(t) {
  await sql`INSERT INTO trips (id, code, name, currency, emoji, created_at, updated_at)
    VALUES (${t.id}, ${t.code}, ${t.name}, ${t.currency || "EUR"}, ${t.emoji || "🏙️"}, ${t.createdAt || Date.now()}, ${Date.now()})
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, currency = EXCLUDED.currency, emoji = EXCLUDED.emoji, updated_at = EXCLUDED.updated_at`;
}
async function upsertPerson(tripId, p) {
  await sql`INSERT INTO people (id, trip_id, name) VALUES (${p.id}, ${tripId}, ${p.name})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
}
async function upsertExpense(tripId, e) {
  await sql`INSERT INTO expenses (id, trip_id, title, amount, date, paid_by, attendees, photo, note, created_at, status, return_message, submitted_by)
    VALUES (${e.id}, ${tripId}, ${e.title}, ${e.amount || 0}, ${e.date || null}, ${e.paidBy || null},
            ${JSON.stringify(e.attendees || [])}::jsonb, ${e.photo || null}, ${e.note || ""}, ${e.createdAt || Date.now()},
            ${e.status || "autoapproved"}, ${e.returnMessage || null}, ${e.submittedBy || null})
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, amount = EXCLUDED.amount, date = EXCLUDED.date,
      paid_by = EXCLUDED.paid_by, attendees = EXCLUDED.attendees, photo = EXCLUDED.photo, note = EXCLUDED.note,
      submitted_by = COALESCE(EXCLUDED.submitted_by, expenses.submitted_by),
      status = CASE WHEN EXCLUDED.status = 'pending' THEN expenses.status ELSE EXCLUDED.status END,
      return_message = CASE WHEN EXCLUDED.status = 'pending' THEN expenses.return_message ELSE EXCLUDED.return_message END`;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!sql) { res.status(500).json({ error: "Database not configured (no connection string env var found)." }); return; }

  let body;
  try {
    await ensureSchema();
    body = await readBody(req);
    const op = body.op;

    switch (op) {
      case "ping":
        return res.status(200).json({ ok: true });

      // Login with name + 4-digit code. Returns the member's trips (all, if admin).
      case "login": {
        const nameKey = String(body.name || "").trim().toLowerCase();
        const code = String(body.code || "").trim();
        if (!nameKey || !code) return res.status(200).json({ ok: false });
        const rows = await sql`SELECT name, code, is_admin FROM members WHERE name_key = ${nameKey}`;
        if (!rows.length || String(rows[0].code) !== code) return res.status(200).json({ ok: false });
        const m = rows[0];
        let tripRows;
        if (m.is_admin) {
          tripRows = await sql`SELECT * FROM trips ORDER BY updated_at DESC NULLS LAST`;
        } else {
          tripRows = await sql`SELECT t.* FROM trips t WHERE EXISTS (
            SELECT 1 FROM people p WHERE p.trip_id = t.id AND lower(trim(p.name)) = ${nameKey}
          ) ORDER BY t.updated_at DESC NULLS LAST`;
        }
        const trips = [];
        for (const r of tripRows) { const t = await assembleTrip(r); if (t) trips.push(t); }
        return res.status(200).json({ ok: true, name: m.name, isAdmin: !!m.is_admin, trips, settlements: await overallSettlements() });
      }

      case "getTrips": {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        const trips = [];
        for (const id of ids) {
          const t = await getTripById(id);
          if (t) trips.push(t);
        }
        // tell the client which requested trips were deleted, so it can prune them
        let deleted = [];
        if (ids.length) {
          const delRows = await sql`SELECT id FROM deleted_trips`;
          const delSet = {};
          delRows.forEach((r) => { delSet[r.id] = true; });
          deleted = ids.filter((id) => delSet[id]);
        }
        return res.status(200).json({ trips, deleted });
      }

      case "getTrip": {
        const t = body.code ? await getTripByCode(String(body.code)) : await getTripById(String(body.id));
        return res.status(200).json({ trip: t });
      }

      case "saveTripFull": {
        // upsert a whole trip incl. people + expenses (create / migrate / re-sync)
        const t = body.trip;
        if (!t || !t.id || !t.code) return res.status(400).json({ error: "trip with id+code required" });
        // never resurrect a trip that was deleted
        const tomb = await sql`SELECT 1 FROM deleted_trips WHERE id = ${t.id}`;
        if (tomb.length) return res.status(200).json({ ok: true, skipped: "deleted" });
        await upsertTripRow(t);
        for (const p of t.people || []) await upsertPerson(t.id, p);
        for (const e of t.expenses || []) await upsertExpense(t.id, e);
        return res.status(200).json({ ok: true });
      }

      case "updateTrip": {
        await sql`UPDATE trips SET name = ${body.name}, currency = ${body.currency}, emoji = ${body.emoji}, updated_at = ${Date.now()} WHERE id = ${body.id}`;
        return res.status(200).json({ ok: true });
      }

      case "deleteTrip": {
        await sql`DELETE FROM expenses WHERE trip_id = ${body.id}`;
        await sql`DELETE FROM people WHERE trip_id = ${body.id}`;
        await sql`DELETE FROM trips WHERE id = ${body.id}`;
        await sql`INSERT INTO deleted_trips (id, deleted_at) VALUES (${body.id}, ${Date.now()}) ON CONFLICT (id) DO NOTHING`;
        return res.status(200).json({ ok: true });
      }

      case "addPerson": {
        await upsertPerson(body.tripId, body.person);
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id = ${body.tripId}`;
        return res.status(200).json({ ok: true });
      }

      case "removePerson": {
        await sql`DELETE FROM people WHERE id = ${body.personId} AND trip_id = ${body.tripId}`;
        // drop this person from every expense's attendees array
        await sql`UPDATE expenses SET attendees = COALESCE((
          SELECT jsonb_agg(elem) FROM jsonb_array_elements(attendees) elem
          WHERE elem <> to_jsonb(${body.personId}::text)
        ), '[]'::jsonb) WHERE trip_id = ${body.tripId}`;
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id = ${body.tripId}`;
        return res.status(200).json({ ok: true });
      }

      case "saveExpense": {
        await upsertExpense(body.tripId, body.expense);
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id = ${body.tripId}`;
        return res.status(200).json({ ok: true });
      }

      case "deleteExpense": {
        await sql`DELETE FROM expenses WHERE id = ${body.expenseId} AND trip_id = ${body.tripId}`;
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id = ${body.tripId}`;
        return res.status(200).json({ ok: true });
      }

      // Approve / return / decline an expense — admin only (verified by name + code).
      case "reviewExpense": {
        const nameKey = String(body.name || "").trim().toLowerCase();
        const code = String(body.code || "").trim();
        const m = await sql`SELECT is_admin FROM members WHERE name_key = ${nameKey} AND code = ${code}`;
        if (!m.length || !m[0].is_admin) return res.status(200).json({ ok: false, error: "not admin" });
        const valid = body.status === "approved" || body.status === "returned" || body.status === "declined";
        if (!valid) return res.status(200).json({ ok: false, error: "bad status" });
        const status = body.status;
        const keepMsg = status === "returned" || status === "declined";
        await sql`UPDATE expenses SET status = ${status}, return_message = ${keepMsg ? (body.message || "") : null} WHERE id = ${body.expenseId} AND trip_id = ${body.tripId}`;
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id = ${body.tripId}`;
        return res.status(200).json({ ok: true });
      }

      // Create a login for a member — admin only (verified by admin name + code).
      // Non-admin only; never clobbers an existing member.
      case "addMember": {
        const adminKey = String(body.adminName || "").trim().toLowerCase();
        const adminCode = String(body.adminCode || "").trim();
        const a = await sql`SELECT is_admin FROM members WHERE name_key = ${adminKey} AND code = ${adminCode}`;
        if (!a.length || !a[0].is_admin) return res.status(200).json({ ok: false, error: "not admin" });
        const disp = String(body.name || "").trim();
        const key = disp.toLowerCase();
        const code = String(body.code || "").trim();
        if (!key || !/^\d{4}$/.test(code)) return res.status(200).json({ ok: false, error: "need name + 4-digit code" });
        const ins = await sql`INSERT INTO members (name_key, name, code, is_admin)
          VALUES (${key}, ${disp}, ${code}, false)
          ON CONFLICT (name_key) DO NOTHING
          RETURNING name_key`;
        if (!ins.length) return res.status(200).json({ ok: false, exists: true });
        return res.status(200).json({ ok: true, name: disp });
      }

      // Directory of member names — any valid member (for the add-person dropdown).
      case "listMemberNames": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT 1 FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false });
        const rows = await sql`SELECT name FROM members ORDER BY name`;
        return res.status(200).json({ ok: true, names: rows.map((r) => r.name).filter(Boolean) });
      }

      // Overall settlements are global (by name key, in SAR). All overall settlements.
      case "getSettlements": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT 1 FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false });
        return res.status(200).json({ ok: true, settlements: await overallSettlements() });
      }

      // Propose a settlement — caller must be one of the two parties (by name key).
      case "proposeSettlement": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT name FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false, error: "not a member" });
        const from = String(body.from || "").trim().toLowerCase();
        const to = String(body.to || "").trim().toLowerCase();
        const amount = Number(body.amount) || 0;
        if (!from || !to || from === to || !(amount > 0)) return res.status(200).json({ ok: false, error: "bad input" });
        if (k !== from && k !== to) return res.status(200).json({ ok: false, error: "not a party" });
        const id = String(body.id || ("s" + Date.now()));
        await sql`INSERT INTO settlements (id, trip_id, from_person, to_person, amount, status, proposed_by, created_at)
          VALUES (${id}, ${OVERALL}, ${from}, ${to}, ${amount}, 'proposed', ${mm[0].name}, ${Date.now()})
          ON CONFLICT (id) DO NOTHING`;
        return res.status(200).json({ ok: true, id });
      }

      // Confirm a proposed settlement — caller must be the OTHER party (not the proposer).
      case "confirmSettlement": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT name FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false, error: "not a member" });
        const id = String(body.id || "");
        const rows = await sql`SELECT * FROM settlements WHERE id = ${id} AND trip_id = ${OVERALL}`;
        if (!rows.length) return res.status(200).json({ ok: false, error: "not found" });
        const s = rows[0];
        if (k !== String(s.from_person) && k !== String(s.to_person)) return res.status(200).json({ ok: false, error: "not a party" });
        if (String(s.proposed_by || "").trim().toLowerCase() === k) return res.status(200).json({ ok: false, error: "the other party must confirm" });
        await sql`UPDATE settlements SET status = 'confirmed', confirmed_by = ${mm[0].name}, confirmed_at = ${Date.now()} WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      // Cancel / undo a settlement — either party may cancel.
      case "cancelSettlement": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT 1 FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false, error: "not a member" });
        const id = String(body.id || "");
        const rows = await sql`SELECT * FROM settlements WHERE id = ${id} AND trip_id = ${OVERALL}`;
        if (!rows.length) return res.status(200).json({ ok: true });
        const s = rows[0];
        if (k !== String(s.from_person) && k !== String(s.to_person)) return res.status(200).json({ ok: false, error: "not a party" });
        await sql`DELETE FROM settlements WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      // Move an expense to another trip — remaps people by name (adding any missing),
      // and stores the client-converted amount.
      case "moveExpense": {
        const k = String(body.name || "").trim().toLowerCase();
        const c = String(body.code || "").trim();
        const mm = await sql`SELECT 1 FROM members WHERE name_key = ${k} AND code = ${c}`;
        if (!mm.length) return res.status(200).json({ ok: false, error: "not a member" });
        const fromTrip = String(body.fromTripId || ""), toTrip = String(body.toTripId || ""), expId = String(body.expenseId || "");
        if (!fromTrip || !toTrip || !expId || fromTrip === toTrip) return res.status(200).json({ ok: false, error: "bad input" });
        const exRows = await sql`SELECT * FROM expenses WHERE id = ${expId} AND trip_id = ${fromTrip}`;
        if (!exRows.length) return res.status(200).json({ ok: false, error: "expense not found" });
        const ex = exRows[0];
        const srcPeople = await sql`SELECT id, name FROM people WHERE trip_id = ${fromTrip}`;
        const dstPeople = await sql`SELECT id, name FROM people WHERE trip_id = ${toTrip}`;
        const srcName = {}; srcPeople.forEach((p) => (srcName[p.id] = p.name));
        const dstByKey = {}; dstPeople.forEach((p) => (dstByKey[String(p.name || "").trim().toLowerCase()] = p.id));
        let seq = 0;
        async function mapPerson(srcId) {
          const nm = srcName[srcId]; if (!nm) return null;
          const key = String(nm).trim().toLowerCase();
          if (dstByKey[key]) return dstByKey[key];
          const newId = "p" + Date.now() + "_" + (seq++) + Math.floor(Math.random() * 1e6).toString(36);
          await sql`INSERT INTO people (id, trip_id, name) VALUES (${newId}, ${toTrip}, ${nm}) ON CONFLICT (id) DO NOTHING`;
          dstByKey[key] = newId;
          return newId;
        }
        const newPaidBy = await mapPerson(ex.paid_by);
        const srcAtt = Array.isArray(ex.attendees) ? ex.attendees : [];
        const newAtt = [];
        for (const id of srcAtt) { const m = await mapPerson(id); if (m) newAtt.push(m); }
        const amt = Number.isFinite(Number(body.amount)) ? Number(body.amount) : Number(ex.amount);
        await sql`UPDATE expenses SET trip_id = ${toTrip}, paid_by = ${newPaidBy}, attendees = ${JSON.stringify(newAtt)}::jsonb, amount = ${amt} WHERE id = ${expId}`;
        await sql`UPDATE trips SET updated_at = ${Date.now()} WHERE id IN (${fromTrip}, ${toTrip})`;
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown op: " + op });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
