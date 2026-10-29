import { Router } from "express";
import { z } from "zod";
import { q, one, many } from "../db.js";
import { parse, bad, forbidden, notFound, today, addDays, weekStart } from "../util.js";
import { canCreate, touchActive } from "../auth.js";
import { signedUrl, deleteFile } from "../storage.js";
import { subscribe, publish, kick } from "../realtime.js";

export const crews = Router();

const crewBody = z.object({ name: z.string().trim().min(1).max(40), blurb: z.string().trim().max(90).default(""), weeklyGoal: z.number().int().min(1).max(500) });
const shapeCrew = (c, u) => ({ id: c.id, name: c.name, blurb: c.blurb, weeklyGoal: c.weekly_goal, members: c.members, createdBy: c.created_by,
  canEdit: u.is_owner || (u.is_ambassador && c.created_by === u.id) });
const photo = (id) => (id ? signedUrl(id) : null);

// Members of the crew (or the owner) can see inside it
function mustSee(req, crewId) { if (!req.user.is_owner && req.user.crew_id !== crewId) throw forbidden("Join this crew to see inside it."); }
async function blockedSet(uid) { return new Set((await many("SELECT blocked_id FROM blocks WHERE user_id = $1", [uid])).map((r) => r.blocked_id)); }

crews.get("/", async (req, res) => {
  const rows = await many("SELECT c.*, (SELECT count(*)::int FROM users u WHERE u.crew_id = c.id) AS members FROM crews c ORDER BY c.created_at");
  res.json(rows.map((c) => shapeCrew(c, req.user)));
});

crews.post("/", async (req, res) => {
  if (!canCreate(req.user)) throw forbidden("Only ambassadors can start crews.");
  const b = parse(crewBody, req.body);
  try {
    const c = await one("INSERT INTO crews (name, blurb, weekly_goal, created_by) VALUES ($1,$2,$3,$4) RETURNING *, 0 AS members", [b.name, b.blurb, b.weeklyGoal, req.user.id]);
    res.status(201).json(shapeCrew(c, req.user));
  } catch (e) { if (e.code === "23505") throw bad("There's already a crew with that name."); throw e; }
});

crews.patch("/:id", async (req, res) => {
  const c = await one("SELECT * FROM crews WHERE id = $1", [req.params.id]);
  if (!c) throw notFound("Crew not found.");
  if (!(req.user.is_owner || (req.user.is_ambassador && c.created_by === req.user.id))) throw forbidden("You can't edit this crew.");
  const b = parse(crewBody, req.body);
  try {
    const u = await one("UPDATE crews SET name = $2, blurb = $3, weekly_goal = $4 WHERE id = $1 RETURNING *, (SELECT count(*)::int FROM users WHERE crew_id = $1) AS members", [c.id, b.name, b.blurb, b.weeklyGoal]);
    publish(c.id, "crew", {});
    res.json(shapeCrew(u, req.user));
  } catch (e) { if (e.code === "23505") throw bad("There's already a crew with that name."); throw e; }
});

crews.post("/:id/join", async (req, res) => {
  const c = await one("SELECT id FROM crews WHERE id = $1", [req.params.id]);
  if (!c) throw notFound("Crew not found.");
  const old = req.user.crew_id;
  await q("UPDATE users SET crew_id = $2, crew_ever = true, joined_at = CASE WHEN crew_id IS DISTINCT FROM $2 THEN now() ELSE joined_at END WHERE id = $1", [req.user.id, c.id]);
  if (old && old !== c.id) { kick(old, req.user.id); publish(old, "members", {}); }
  publish(c.id, "members", {});
  res.json({ crewId: c.id });
});
crews.post("/leave", async (req, res) => {
  const old = req.user.crew_id;
  await q("UPDATE users SET crew_id = NULL WHERE id = $1", [req.user.id]);
  if (old) { kick(old, req.user.id); publish(old, "members", {}); }
  res.json({ crewId: null });
});

// The crew page: details, members, this week's shared total
crews.get("/:id", async (req, res) => {
  mustSee(req, req.params.id);
  const c = await one("SELECT c.*, (SELECT count(*)::int FROM users u WHERE u.crew_id = c.id) AS members FROM crews c WHERE c.id = $1", [req.params.id]);
  if (!c) throw notFound("Crew not found.");
  const ws = weekStart(today());
  const [members, total] = await Promise.all([
    many(`SELECT u.id, u.name, u.photo_id, u.last_active, u.joined_at, u.check_on_me, (a.user_id IS NOT NULL) AS amb
          FROM users u LEFT JOIN ambassadors a ON a.user_id = u.id WHERE u.crew_id = $1 ORDER BY u.name`, [c.id]),
    one("SELECT count(*)::int AS n FROM sessions WHERE crew_id = $1 AND shared AND date >= $2", [c.id, ws])
  ]);
  res.json(Object.assign(shapeCrew(c, req.user), {
    weekTotal: total.n,
    memberList: members.map((m) => ({ id: m.id, name: m.name, photoUrl: photo(m.photo_id), ambassador: m.amb, lastActive: m.last_active }))
  }));
});

crews.get("/:id/feed", async (req, res) => {
  mustSee(req, req.params.id);
  const blocked = await blockedSet(req.user.id);
  const rows = await many(`SELECT s.id, s.user_id, s.type, s.minutes, s.why, s.feeling, s.date, s.at, u.name, u.photo_id, (a.user_id IS NOT NULL) AS amb,
      (SELECT count(*)::int FROM cheers ch WHERE ch.session_id = s.id) AS cheers,
      EXISTS (SELECT 1 FROM cheers ch WHERE ch.session_id = s.id AND ch.user_id = $2) AS cheered
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN ambassadors a ON a.user_id = s.user_id
    WHERE s.crew_id = $1 AND s.shared ORDER BY s.at DESC LIMIT 60`, [req.params.id, req.user.id]);
  res.json(rows.filter((r) => !blocked.has(r.user_id)).map((r) => ({
    id: r.id, uid: r.user_id, name: r.name, photoUrl: photo(r.photo_id), ambassador: r.amb, type: r.type, minutes: r.minutes,
    why: r.why, feeling: r.feeling, date: r.date, at: r.at, cheers: r.cheers, cheered: r.cheered
  })));
});

crews.post("/sessions/:sid/cheer", async (req, res) => {
  const s = await one("SELECT user_id, crew_id FROM sessions WHERE id = $1 AND shared", [req.params.sid]);
  if (!s) throw notFound();
  mustSee(req, s.crew_id);
  if (s.user_id === req.user.id) throw bad("You can't cheer your own session.");
  await q("INSERT INTO cheers (session_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.sid, req.user.id]);
  publish(s.crew_id, "feed", { id: req.params.sid });
  res.json({ ok: true });
});
crews.delete("/sessions/:sid/cheer", async (req, res) => {
  const s = await one("DELETE FROM cheers ch USING sessions s WHERE ch.session_id = $1 AND ch.user_id = $2 AND s.id = ch.session_id RETURNING s.crew_id", [req.params.sid, req.user.id]);
  if (s) publish(s.crew_id, "feed", { id: req.params.sid });
  res.json({ ok: true });
});

/* ---------- Chat ---------- */
function shapeMsg(m) {
  return { id: m.id, uid: m.user_id, name: m.user_id ? m.name : "Deleted member", photoUrl: photo(m.photo_id), text: m.text, at: m.at,
    media: m.media_id ? { url: signedUrl(m.media_id), kind: m.media_kind, w: m.media_w, h: m.media_h, id: m.media_id } : null };
}
const MSG_SELECT = "SELECT m.*, u.name, u.photo_id FROM messages m LEFT JOIN users u ON u.id = m.user_id";

crews.get("/:id/messages", async (req, res) => {
  mustSee(req, req.params.id);
  const before = typeof req.query.before === "string" && !isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const rows = await many(MSG_SELECT + " WHERE m.crew_id = $1 AND ($2::timestamptz IS NULL OR m.at < $2) ORDER BY m.at DESC LIMIT 60", [req.params.id, before]);
  const blocked = await blockedSet(req.user.id);
  res.json(rows.reverse().filter((m) => !m.user_id || !blocked.has(m.user_id)).map(shapeMsg));
});

crews.post("/:id/messages", async (req, res) => {
  if (req.user.crew_id !== req.params.id) throw forbidden("You can only post in your own crew.");
  const b = parse(z.object({ text: z.string().trim().max(500).default(""), mediaId: z.uuid().optional() }), req.body);
  let media = null;
  if (b.mediaId) {
    media = await one("SELECT id, mime, crew_id, owner_id FROM uploads WHERE id = $1 AND kind = 'chat'", [b.mediaId]);
    if (!media || media.owner_id !== req.user.id || media.crew_id !== req.params.id) throw bad("That upload can't be used here.");
  }
  if (!b.text && !media) throw bad("Write a message or add a photo.");
  const w = typeof req.body.w === "number" ? Math.round(req.body.w) : null, h = typeof req.body.h === "number" ? Math.round(req.body.h) : null;
  const m = await one("INSERT INTO messages (crew_id, user_id, text, media_id, media_kind, media_w, media_h) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [req.params.id, req.user.id, b.text, media ? media.id : null, media ? (media.mime.startsWith("video/") ? "video" : "image") : null, w, h]);
  const full = shapeMsg(await one(MSG_SELECT + " WHERE m.id = $1", [m.id]));
  await touchActive(req.user.id, today());
  publish(req.params.id, "message", full);
  res.status(201).json(full);
});

crews.delete("/messages/:mid", async (req, res) => {
  const m = await one("SELECT crew_id, user_id, media_id FROM messages WHERE id = $1", [req.params.mid]);
  if (!m) throw notFound();
  if (m.user_id !== req.user.id && !req.user.is_owner) throw forbidden("You can only delete your own messages.");
  await q("DELETE FROM messages WHERE id = $1", [req.params.mid]);
  if (m.media_id) { await q("DELETE FROM uploads WHERE id = $1", [m.media_id]); await deleteFile(m.media_id); }
  publish(m.crew_id, "message-deleted", { id: req.params.mid });
  res.json({ ok: true });
});

/* ---------- Weekly Question wall ---------- */
crews.get("/:id/answers", async (req, res) => {
  mustSee(req, req.params.id);
  const w = weekStart(today());
  const blocked = await blockedSet(req.user.id);
  const rows = await many(`SELECT a.user_id, a.week, a.text, a.outcome, a.at, u.name, u.photo_id FROM answers a JOIN users u ON u.id = a.user_id
    WHERE a.crew_id = $1 AND a.week IN ($2, $3) ORDER BY a.at`, [req.params.id, w, addDays(w, -7)]);
  res.json(rows.filter((r) => !blocked.has(r.user_id)).map((r) => ({ uid: r.user_id, name: r.name, photoUrl: photo(r.photo_id), week: r.week, text: r.text, outcome: r.outcome, at: r.at })));
});

/* ---------- Live updates ---------- */
crews.get("/:id/stream", (req, res) => {
  mustSee(req, req.params.id);
  subscribe(req.params.id, req.user.id, res);
});
