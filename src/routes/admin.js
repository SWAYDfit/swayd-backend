import { Router } from "express";
import { z } from "zod";
import { q, one, many } from "../db.js";
import { parse, bad, notFound } from "../util.js";
import { requireOwner } from "../auth.js";
import { signedUrl, deleteFile } from "../storage.js";
import { publish } from "../realtime.js";

/* Reports can be sent by anyone; reading and acting on them is owner-only */
export const reports = Router();
reports.post("/", async (req, res) => {
  const b = parse(z.object({
    about: z.uuid(), kind: z.enum(["message", "post", "answer"]), refId: z.uuid().optional(),
    reason: z.string().trim().min(1).max(60), detail: z.string().trim().max(500).default(""), text: z.string().max(300).default("")
  }), req.body);
  let crewId = null, mediaId = null;
  if (b.kind === "message" && b.refId) {
    const m = await one("SELECT crew_id, media_id FROM messages WHERE id = $1", [b.refId]);
    if (m) { crewId = m.crew_id; mediaId = m.media_id; }
  }
  await q("INSERT INTO reports (by_id, about_id, kind, ref_id, crew_id, media_id, text, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [req.user.id, b.about, b.kind, b.refId || null, crewId, mediaId, b.text, b.reason, b.detail]);
  res.status(201).json({ ok: true });
});

export const admin = Router();
admin.use(requireOwner);

admin.get("/members", async (req, res) => {
  const rows = await many(`SELECT u.id, u.name, u.photo_id, u.crew_id, c.name AS crew, (a.user_id IS NOT NULL) AS ambassador
    FROM users u LEFT JOIN crews c ON c.id = u.crew_id LEFT JOIN ambassadors a ON a.user_id = u.id WHERE u.onboarded ORDER BY u.name`);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, crew: r.crew, ambassador: r.ambassador, photoUrl: r.photo_id ? signedUrl(r.photo_id) : null })));
});
admin.post("/ambassadors/:uid", async (req, res) => {
  const u = await one("SELECT id FROM users WHERE id = $1", [req.params.uid]);
  if (!u) throw notFound("Member not found.");
  await q("INSERT INTO ambassadors (user_id, granted_by) VALUES ($1,$2) ON CONFLICT DO NOTHING", [u.id, req.user.id]);
  res.json({ ok: true });
});
admin.delete("/ambassadors/:uid", async (req, res) => {
  await q("DELETE FROM ambassadors WHERE user_id = $1", [req.params.uid]);
  res.json({ ok: true });
});

admin.get("/reports", async (req, res) => {
  const rows = await many(`SELECT r.*, a.name AS about_name, b.name AS by_name FROM reports r
    LEFT JOIN users a ON a.id = r.about_id LEFT JOIN users b ON b.id = r.by_id ORDER BY r.status, r.at DESC LIMIT 200`);
  res.json(rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, crewId: r.crew_id, reason: r.reason, detail: r.detail, text: r.text, status: r.status, at: r.at,
    about: { id: r.about_id, name: r.about_name || "Deleted member" }, by: { id: r.by_id, name: r.by_name || "Deleted member" },
    mediaUrl: r.media_id ? signedUrl(r.media_id) : null })));
});
admin.patch("/reports/:id", async (req, res) => {
  const b = parse(z.object({ status: z.enum(["open", "done"]), removeMessage: z.boolean().optional() }), req.body);
  const r = await one("UPDATE reports SET status = $2 WHERE id = $1 RETURNING *", [req.params.id, b.status]);
  if (!r) throw notFound();
  if (b.removeMessage && r.kind === "message" && r.ref_id) {
    const m = await one("DELETE FROM messages WHERE id = $1 RETURNING crew_id, media_id", [r.ref_id]);
    if (m) {
      if (m.media_id) { await q("DELETE FROM uploads WHERE id = $1", [m.media_id]); await deleteFile(m.media_id); }
      publish(m.crew_id, "message-deleted", { id: r.ref_id });
    }
  }
  res.json({ ok: true });
});
