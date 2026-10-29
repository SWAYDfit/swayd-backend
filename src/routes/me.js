import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { q, one, many, tx } from "../db.js";
import { parse, bad, forbidden, notFound, today, addDays, weekStart, dayGap, YMD } from "../util.js";
import { requireConsent, touchActive } from "../auth.js";
import { signedUrl, deleteFile } from "../storage.js";
import { publish } from "../realtime.js";

export const me = Router();

const ymd = z.string().regex(YMD, "use YYYY-MM-DD");
const MEALS = ["breakfast", "lunch", "dinner", "snack"];

// Everything the app needs about the signed-in member
export function shapeMe(u, blocked) {
  return {
    id: u.id, email: u.email, name: u.name, photoUrl: u.photo_id ? signedUrl(u.photo_id) : null,
    isOwner: u.is_owner, isAmbassador: !!u.is_ambassador, crewId: u.crew_id, joinedAt: u.joined_at,
    lastActive: u.last_active, checkOnMe: u.check_on_me, goal: u.goal, onboarded: u.onboarded,
    consent: u.consent, consentCurrent: !!(u.consent && u.consent.version === config.consentVersion && u.consent.adult && u.consent.terms),
    health: u.health, coachOn: u.coach_on, quiet: u.quiet, goals: u.goals, body: u.body, seenBadges: u.seen_badges,
    crewEver: u.crew_ever, eventTermsAt: u.event_terms_at, qAnswered: u.q_answered, qReflected: u.q_reflected,
    livedAnswer: u.lived_answer, blocked: blocked || [],
    app: { consentVersion: config.consentVersion, sandbox: config.sandbox, coachAvailable: !!config.anthropicKey, today: today() }
  };
}
async function blockedIds(uid) { return (await many("SELECT blocked_id FROM blocks WHERE user_id = $1", [uid])).map((r) => r.blocked_id); }
function requireHealth(req) { if (!req.user.health) throw forbidden("Turn on health tracking in your profile first."); }

me.get("/", async (req, res) => res.json(shapeMe(req.user, await blockedIds(req.user.id))));

/* ---------- Consent (works before the terms are accepted) ---------- */
me.post("/consent", async (req, res) => {
  const b = parse(z.object({ adult: z.literal(true), terms: z.literal(true), health: z.boolean() }), req.body);
  await tx(async (c) => {
    await c.query("UPDATE users SET consent = $2, health = $3, health_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1",
      [req.user.id, { version: config.consentVersion, at: new Date().toISOString(), adult: true, terms: true }, b.health]);
    await c.query("INSERT INTO consent_log (user_id, kind, value, version) VALUES ($1,'terms',true,$2), ($1,'health',$3,$2)", [req.user.id, config.consentVersion, b.health]);
  });
  res.json({ ok: true });
});

me.use(requireConsent);

/* ---------- Profile ---------- */
const goalsSchema = z.object({ kcal: z.number().int().min(800).max(8000), p: z.number().int().min(0).max(500), c: z.number().int().min(0).max(1000), f: z.number().int().min(0).max(400), water: z.number().int().min(1).max(16), steps: z.number().int().min(500).max(60000) });
const bodySchema = z.object({
  sex: z.enum(["female", "male"]).optional(), age: z.number().int().min(18).max(100).optional(), height: z.number().min(120).max(230).optional(),
  weight: z.number().min(35).max(300).optional(), activity: z.enum(["sedentary", "light", "moderate", "very"]).optional(),
  goal: z.enum(["lose", "maintain", "build"]), pace: z.enum(["gentle", "steady"]).nullable().optional(), target: z.number().min(35).max(300).nullable().optional(),
  safeConfirmed: z.boolean().optional(), noTargets: z.boolean().optional(), setAt: z.number().optional()
}).nullable();

me.patch("/", async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(30).optional(), goal: z.string().max(80).optional(), onboarded: z.boolean().optional(),
    quiet: z.boolean().optional(), checkOnMe: z.boolean().optional(), goals: goalsSchema.optional(), body: bodySchema.optional(),
    seenBadges: z.array(z.string().max(30)).max(50).optional()
  }), req.body);
  if (b.body && b.body.goal === "lose" && !b.body.noTargets) {
    // Same safety rules as the app: never a loss target for an underweight BMI
    if (!b.body.height || !b.body.weight) throw bad("Height and weight are needed for a weight-loss goal.");
    const m = b.body.height / 100;
    if (b.body.weight / (m * m) < 18.5) throw bad("Swayd won't set a weight-loss target below the healthy weight range.");
    if (b.body.target && b.body.target / (m * m) < 18.5) throw bad("That goal weight is below the healthy range for your height.");
    if (!b.body.safeConfirmed) throw bad("The safety check is required for a weight-loss goal.");
  }
  const map = { name: "name", goal: "goal", onboarded: "onboarded", quiet: "quiet", checkOnMe: "check_on_me", goals: "goals", body: "body", seenBadges: "seen_badges" };
  const sets = [], vals = [req.user.id];
  for (const k of Object.keys(b)) { vals.push(b[k]); sets.push(map[k] + " = $" + vals.length); }
  if (sets.length) await q("UPDATE users SET " + sets.join(", ") + " WHERE id = $1", vals);
  const u = await one("SELECT u.*, (a.user_id IS NOT NULL) AS is_ambassador FROM users u LEFT JOIN ambassadors a ON a.user_id = u.id WHERE u.id = $1", [req.user.id]);
  res.json(shapeMe(u, await blockedIds(req.user.id)));
});

me.post("/health", async (req, res) => {
  const b = parse(z.object({ on: z.boolean(), deleteData: z.boolean().optional() }), req.body);
  await tx(async (c) => {
    await c.query("UPDATE users SET health = $2, health_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [req.user.id, b.on]);
    await c.query("INSERT INTO consent_log (user_id, kind, value, version) VALUES ($1,'health',$2,$3)", [req.user.id, b.on, config.consentVersion]);
    if (!b.on && b.deleteData) {
      await c.query("DELETE FROM food_items WHERE user_id = $1", [req.user.id]);
      await c.query("UPDATE day_logs SET water = 0, steps = 0, weight = NULL WHERE user_id = $1", [req.user.id]);
      await c.query("UPDATE sessions SET why = '', feeling = '' WHERE user_id = $1", [req.user.id]);
      await c.query("UPDATE users SET body = NULL WHERE id = $1", [req.user.id]);
    }
  });
  res.json({ ok: true });
});
me.post("/coach", async (req, res) => {
  const b = parse(z.object({ on: z.boolean() }), req.body);
  await q("UPDATE users SET coach_on = $2, coach_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [req.user.id, b.on]);
  await q("INSERT INTO consent_log (user_id, kind, value, version) VALUES ($1,'coach',$2,$3)", [req.user.id, b.on, config.consentVersion]);
  res.json({ ok: true });
});
me.post("/event-terms", async (req, res) => {
  await q("UPDATE users SET event_terms_at = now() WHERE id = $1", [req.user.id]);
  await q("INSERT INTO consent_log (user_id, kind, value, version) VALUES ($1,'event_terms',true,$2)", [req.user.id, config.consentVersion]);
  res.json({ ok: true });
});

/* ---------- Daily log ---------- */
me.get("/days", async (req, res) => {
  const to = YMD.test(req.query.to || "") ? req.query.to : today();
  const from = YMD.test(req.query.from || "") ? req.query.from : addDays(to, -60);
  if (dayGap(from, to) > 400) throw bad("Ask for at most 400 days at a time.");
  const [days, food, sess] = await Promise.all([
    many("SELECT date, intention, water, steps, weight FROM day_logs WHERE user_id = $1 AND date BETWEEN $2 AND $3", [req.user.id, from, to]),
    many("SELECT id, date, meal, name, kcal, p, c, f FROM food_items WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY created_at", [req.user.id, from, to]),
    many("SELECT id, date, type, minutes, why, feeling, shared, at FROM sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY at", [req.user.id, from, to])
  ]);
  const out = {};
  const day = (d) => (out[d] = out[d] || { date: d, intention: null, water: 0, steps: 0, weight: null, food: [], presence: [] });
  days.forEach((r) => Object.assign(day(r.date), r));
  food.forEach((r) => day(r.date).food.push(r));
  sess.forEach((r) => day(r.date).presence.push(r));
  res.json({ from, to, days: out });
});

me.put("/days/:date", async (req, res) => {
  const date = parse(ymd, req.params.date);
  if (date > addDays(today(), 1)) throw bad("You can't log days in the future.");
  const b = parse(z.object({
    intention: z.enum(["Reset", "Push", "Connect", "Recover", "Explore", "Show Up"]).nullable().optional(),
    water: z.number().int().min(0).max(16).optional(), steps: z.number().int().min(0).max(150000).optional(),
    weight: z.number().min(20).max(400).nullable().optional()
  }), req.body);
  if (b.water !== undefined || b.steps !== undefined || b.weight !== undefined) requireHealth(req);
  await q("INSERT INTO day_logs (user_id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, date]);
  const map = { intention: "intention", water: "water", steps: "steps", weight: "weight" };
  const sets = [], vals = [req.user.id, date];
  for (const k of Object.keys(b)) { vals.push(b[k]); sets.push(map[k] + " = $" + vals.length); }
  if (sets.length) await q("UPDATE day_logs SET " + sets.join(", ") + " WHERE user_id = $1 AND date = $2", vals);
  await touchActive(req.user.id, date);
  res.json(await one("SELECT date, intention, water, steps, weight FROM day_logs WHERE user_id = $1 AND date = $2", [req.user.id, date]));
});

const foodItem = z.object({ name: z.string().trim().min(1).max(80), kcal: z.number().int().min(0).max(10000), p: z.number().int().min(0).max(1000), c: z.number().int().min(0).max(1000), f: z.number().int().min(0).max(1000) });
me.post("/food", async (req, res) => {
  requireHealth(req);
  const b = parse(z.object({ date: ymd, meal: z.enum(MEALS), items: z.array(foodItem).min(1).max(20) }), req.body);
  const rows = [];
  for (const it of b.items) {
    rows.push(await one("INSERT INTO food_items (user_id, date, meal, name, kcal, p, c, f) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, date, meal, name, kcal, p, c, f",
      [req.user.id, b.date, b.meal, it.name, it.kcal, it.p, it.c, it.f]));
  }
  res.status(201).json({ items: rows });
});
me.patch("/food/:id", async (req, res) => {
  const b = parse(z.object({ meal: z.enum(MEALS) }), req.body);
  const r = await one("UPDATE food_items SET meal = $3 WHERE id = $1 AND user_id = $2 RETURNING id, date, meal, name, kcal, p, c, f", [req.params.id, req.user.id, b.meal]);
  if (!r) throw notFound();
  res.json(r);
});
me.delete("/food/:id", async (req, res) => {
  await q("DELETE FROM food_items WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

const ACT_TYPES = ["Walk", "Run", "Strength", "Class", "Swim", "Ride", "Yoga", "Recovery / Mobility", "Sport"];
me.post("/sessions", async (req, res) => {
  const b = parse(z.object({
    date: ymd, type: z.enum(ACT_TYPES), minutes: z.number().int().min(1).max(1440).nullable().optional(),
    why: z.string().max(140).optional(), feeling: z.string().max(30).optional(), shared: z.boolean().optional()
  }), req.body);
  const health = req.user.health, crewId = b.shared ? req.user.crew_id : null;
  const s = await one(
    "INSERT INTO sessions (user_id, date, type, minutes, why, feeling, shared, crew_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, date, type, minutes, why, feeling, shared, at",
    [req.user.id, b.date, b.type, b.minutes || null, health ? b.why || "" : "", health ? b.feeling || "" : "", !!crewId, crewId]
  );
  await touchActive(req.user.id, b.date);
  if (crewId) publish(crewId, "feed", { id: s.id });
  res.status(201).json(s);
});
me.delete("/sessions/:id", async (req, res) => {
  const s = await one("DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING crew_id", [req.params.id, req.user.id]);
  if (s && s.crew_id) publish(s.crew_id, "feed", { removed: req.params.id });
  res.json({ ok: true });
});

/* ---------- Counts for stamps and Passport Marks ---------- */
me.get("/summary", async (req, res) => {
  const uid = req.user.id;
  const [ci, ch, rs, mw] = await Promise.all([
    one("SELECT count(*)::int AS n FROM checkins WHERE user_id = $1", [uid]),
    one("SELECT count(*)::int AS n FROM cheers WHERE user_id = $1", [uid]),
    one("SELECT count(*)::int AS n FROM rsvps WHERE user_id = $1", [uid]),
    many(`SELECT o.user_id AS uid, u.name, u.photo_id, count(*)::int AS n FROM checkins m
          JOIN checkins o ON o.event_id = m.event_id AND o.user_id <> m.user_id
          JOIN users u ON u.id = o.user_id
          WHERE m.user_id = $1 GROUP BY o.user_id, u.name, u.photo_id ORDER BY n DESC LIMIT 50`, [uid])
  ]);
  res.json({ checkins: ci.n, cheersGiven: ch.n, rsvps: rs.n, movedWith: mw.map((r) => ({ uid: r.uid, name: r.name, photoUrl: r.photo_id ? signedUrl(r.photo_id) : null, n: r.n })) });
});

/* ---------- Blocking ---------- */
me.post("/blocks/:uid", async (req, res) => {
  if (req.params.uid === req.user.id) throw bad("You can't block yourself.");
  await q("INSERT INTO blocks (user_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, req.params.uid]);
  res.json({ blocked: await blockedIds(req.user.id) });
});
me.delete("/blocks/:uid", async (req, res) => {
  await q("DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2", [req.user.id, req.params.uid]);
  res.json({ blocked: await blockedIds(req.user.id) });
});

/* ---------- The Weekly Question ---------- */
me.put("/answer", async (req, res) => {
  const b = parse(z.object({ text: z.string().trim().min(1).max(160) }), req.body);
  if (!req.user.crew_id) throw bad("Join a crew to answer the Weekly Question.");
  const week = weekStart(today());
  const prev = await one("SELECT outcome FROM answers WHERE user_id = $1 AND week = $2", [req.user.id, week]);
  await q(`INSERT INTO answers (user_id, week, crew_id, text) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, week) DO UPDATE SET text = EXCLUDED.text, crew_id = EXCLUDED.crew_id`, [req.user.id, week, req.user.crew_id, b.text]);
  if (!prev) await q("UPDATE users SET q_answered = q_answered + 1 WHERE id = $1", [req.user.id]);
  await touchActive(req.user.id, today());
  publish(req.user.crew_id, "answers", {});
  res.json({ week, text: b.text, outcome: prev ? prev.outcome : null });
});
me.post("/answer/reflect", async (req, res) => {
  const b = parse(z.object({ week: ymd, outcome: z.enum(["did", "partly", "not"]) }), req.body);
  const r = await one("UPDATE answers SET outcome = $3 WHERE user_id = $1 AND week = $2 AND outcome IS NULL RETURNING crew_id", [req.user.id, b.week, b.outcome]);
  if (!r) throw bad("Nothing to reflect on for that week.");
  await q("UPDATE users SET q_reflected = q_reflected + 1, lived_answer = lived_answer OR $2 WHERE id = $1", [req.user.id, b.outcome === "did"]);
  if (r.crew_id) publish(r.crew_id, "answers", {});
  res.json({ ok: true });
});
me.get("/answers", async (req, res) => {
  const w = weekStart(today());
  res.json(await many("SELECT week, text, outcome FROM answers WHERE user_id = $1 AND week IN ($2, $3)", [req.user.id, w, addDays(w, -7)]));
});

/* ---------- "We miss you" ---------- */
// Quiet = in a crew for 7+ days, opted in, and not active for 7+ days
export async function quietCrewmates(crewId) {
  const t = today();
  const rows = await many("SELECT id, name, last_active, joined_at, check_on_me FROM users WHERE crew_id = $1", [crewId]);
  const weekAgo = Date.now() - 7 * 86400000;
  const quiet = rows.filter((r) => r.check_on_me && new Date(r.joined_at).getTime() < weekAgo && (!r.last_active || dayGap(r.last_active, t) >= 7));
  const active = rows.filter((r) => r.last_active && dayGap(r.last_active, t) < 7);
  return { quiet, active };
}
function hash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x >>> 0; }

me.get("/nudge-targets", async (req, res) => {
  if (!req.user.crew_id) return res.json([]);
  const { quiet, active } = await quietCrewmates(req.user.crew_id);
  const wk = weekStart(today());
  if (!active.some((a) => a.id === req.user.id)) return res.json([]);
  const sent = new Set((await many("SELECT to_id FROM nudges WHERE from_id = $1 AND week = $2", [req.user.id, wk])).map((r) => r.to_id));
  const mine = quiet.filter((t) => t.id !== req.user.id && !sent.has(t.id)).filter((t) => {
    const pool = active.filter((a) => a.id !== t.id).sort((a, b) => hash(t.id + wk + a.id) - hash(t.id + wk + b.id)).slice(0, 2);
    return pool.some((p) => p.id === req.user.id);
  });
  res.json(mine.map((t) => ({ uid: t.id, name: t.name })));
});
me.post("/nudges", async (req, res) => {
  const b = parse(z.object({ to: z.uuid(), text: z.string().trim().min(1).max(200) }), req.body);
  const target = await one("SELECT crew_id FROM users WHERE id = $1", [b.to]);
  if (!target || target.crew_id !== req.user.crew_id) throw forbidden("You can only send notes to your crew.");
  const r = await one("INSERT INTO nudges (from_id, to_id, week, text) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [req.user.id, b.to, weekStart(today()), b.text]);
  if (!r) throw bad("You've already sent them a note this week.");
  res.status(201).json({ ok: true });
});
me.get("/nudges", async (req, res) => {
  res.json(await many(`SELECT n.id, n.text, n.at, n.from_id AS "from", u.name AS "fromName" FROM nudges n JOIN users u ON u.id = n.from_id
    WHERE n.to_id = $1 AND n.dismissed_at IS NULL AND n.at > now() - interval '14 days'
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = $1 AND b.blocked_id = n.from_id) ORDER BY n.at DESC`, [req.user.id]));
});
me.post("/nudges/:id/dismiss", async (req, res) => {
  await q("UPDATE nudges SET dismissed_at = now() WHERE id = $1 AND to_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/* ---------- Delete account ---------- */
me.delete("/", async (req, res) => {
  const uid = req.user.id;
  const files = await many("SELECT id FROM uploads WHERE owner_id = $1 AND kind = 'avatar'", [uid]);
  await tx(async (c) => {
    await c.query("DELETE FROM uploads WHERE owner_id = $1 AND kind = 'avatar'", [uid]);
    await c.query("DELETE FROM checkins WHERE user_id = $1", [uid]);
    await c.query("DELETE FROM users WHERE id = $1", [uid]); // everything else cascades; chat messages stay as "deleted member"
  });
  await Promise.all(files.map((f) => deleteFile(f.id)));
  res.json({ ok: true });
});
