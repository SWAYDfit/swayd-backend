import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { q, one, many } from "../db.js";
import { parse, bad, forbidden, notFound, today } from "../util.js";
import { canCreate, touchActive } from "../auth.js";

export const events = Router();

const canManage = (u, e) => u.is_owner || (u.is_ambassador && e.created_by === u.id);
function shapeEvent(e, u) {
  return { id: e.id, title: e.title, when: e.starts_at, place: e.place, cost: e.cost, capacity: e.capacity, host: e.host, access: e.access, blurb: e.blurb,
    going: e.going, rsvpd: e.rsvpd, checkedIn: e.checked_in, checkins: e.checkins,
    live: !!(e.checkin_open_until && new Date(e.checkin_open_until) > new Date()), canManage: canManage(u, e) };
}
const LIST = `SELECT e.*,
  (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id) AS going,
  EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.user_id = $1) AS rsvpd,
  EXISTS (SELECT 1 FROM checkins c WHERE c.event_id = e.id AND c.user_id = $1) AS checked_in,
  (SELECT count(*)::int FROM checkins c WHERE c.event_id = e.id) AS checkins
  FROM events e`;

events.get("/", async (req, res) => {
  const rows = await many(LIST + " WHERE e.starts_at > now() - interval '3 hours' ORDER BY e.starts_at LIMIT 100", [req.user.id]);
  res.json(rows.map((e) => shapeEvent(e, req.user)));
});

const eventBody = z.object({
  title: z.string().trim().min(1).max(70), when: z.iso.datetime({ offset: true }), place: z.string().trim().max(80).default(""),
  cost: z.string().trim().max(20).default("Free"), capacity: z.number().int().min(1).max(5000).nullable().optional(),
  host: z.string().trim().max(40).optional(), access: z.string().trim().max(120).default(""), blurb: z.string().trim().max(240).default("")
});
events.post("/", async (req, res) => {
  if (!canCreate(req.user)) throw forbidden("Only ambassadors can host events.");
  const b = parse(eventBody, req.body);
  const host = b.host || (req.user.is_owner ? "Swayd" : req.user.name);
  const e = await one("INSERT INTO events (title, starts_at, place, cost, capacity, host, access, blurb, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [b.title, b.when, b.place, b.cost || "Free", b.capacity || null, host, b.access, b.blurb, req.user.id]);
  res.status(201).json(shapeEvent(await one(LIST + " WHERE e.id = $2", [req.user.id, e.id]), req.user));
});

async function load(id) { const e = await one("SELECT * FROM events WHERE id = $1", [id]); if (!e) throw notFound("Event not found."); return e; }

events.delete("/:id", async (req, res) => {
  const e = await load(req.params.id);
  if (!canManage(req.user, e)) throw forbidden("You can't delete this event.");
  await q("DELETE FROM events WHERE id = $1", [e.id]); // RSVPs go with it; check-ins (stamps) stay
  res.json({ ok: true });
});

function requireEventTerms(u) { if (!u.event_terms_at) throw forbidden("Please accept the Event Participation Terms first."); }

events.post("/:id/rsvp", async (req, res) => {
  requireEventTerms(req.user);
  const e = await load(req.params.id);
  const n = await one("SELECT count(*)::int AS n FROM rsvps WHERE event_id = $1", [e.id]);
  if (e.capacity && n.n >= e.capacity) throw bad("This event is full.");
  await q("INSERT INTO rsvps (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e.id, req.user.id]);
  res.json({ ok: true });
});
events.delete("/:id/rsvp", async (req, res) => {
  await q("DELETE FROM rsvps WHERE event_id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/* ---------- Check-in with a rotating code ---------- */
// The code is derived from a secret only the server knows and the current minute,
// so it can't be guessed from the app and changes every 60 seconds.
const ALPHABET = "ACDEFHJKMNPRTUVWXY34679";
function codeFor(secret, eventId, minute) {
  const h = crypto.createHmac("sha256", secret).update(eventId + ":" + minute).digest();
  let s = ""; for (let i = 0; i < 5; i++) s += ALPHABET[h[i] % ALPHABET.length];
  return s;
}
const minuteNow = () => Math.floor(Date.now() / 60000);

events.post("/:id/checkin/open", async (req, res) => {
  const e = await load(req.params.id);
  if (!canManage(req.user, e)) throw forbidden("Only the host can open check-in.");
  const secret = e.checkin_secret || crypto.randomBytes(32).toString("hex");
  await q("UPDATE events SET checkin_secret = $2, checkin_open_until = now() + interval '90 seconds' WHERE id = $1", [e.id, secret]);
  res.json(currentCode(e.id, secret));
});
// The host's screen calls this every few seconds; it also keeps check-in open
events.get("/:id/checkin/code", async (req, res) => {
  const e = await load(req.params.id);
  if (!canManage(req.user, e)) throw forbidden();
  if (!e.checkin_secret) throw bad("Check-in isn't open.");
  await q("UPDATE events SET checkin_open_until = now() + interval '90 seconds' WHERE id = $1", [e.id]);
  const c = await one("SELECT count(*)::int AS n FROM checkins WHERE event_id = $1", [e.id]);
  res.json(Object.assign(currentCode(e.id, e.checkin_secret), { checkins: c.n }));
});
function currentCode(id, secret) {
  const m = minuteNow();
  return { code: codeFor(secret, id, m), nextAt: new Date((m + 1) * 60000).toISOString() };
}
events.post("/:id/checkin/close", async (req, res) => {
  const e = await load(req.params.id);
  if (!canManage(req.user, e)) throw forbidden();
  await q("UPDATE events SET checkin_open_until = NULL WHERE id = $1", [e.id]);
  res.json({ ok: true });
});

// 10 tries a minute per member stops anyone guessing codes
const tryLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => "ci:" + req.user.id, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "Too many tries. Wait a minute and check the code again." }) });

events.post("/:id/checkin", tryLimit, async (req, res) => {
  requireEventTerms(req.user);
  const b = parse(z.object({ code: z.string().trim().toUpperCase().length(5) }), req.body);
  const e = await load(req.params.id);
  if (!e.checkin_secret || !e.checkin_open_until || new Date(e.checkin_open_until) < new Date()) throw bad("Check-in has closed for this event.");
  const m = minuteNow();
  const ok = [m, m - 1].some((x) => codeFor(e.checkin_secret, e.id, x) === b.code);
  if (!ok) throw bad("That code doesn't match. Check the host's screen.", "bad_code");
  await q("INSERT INTO checkins (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e.id, req.user.id]);
  await touchActive(req.user.id, today());
  res.json({ ok: true });
});
