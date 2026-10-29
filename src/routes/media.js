import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { q, one } from "../db.js";
import { bad, forbidden, notFound } from "../util.js";
import { putFile, streamFile, deleteFile, signedUrl, checkSignature, sniff } from "../storage.js";

const MAX = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });

export const uploads = Router();

// POST /uploads  (multipart: file, kind=avatar|chat)
uploads.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) throw bad("Attach a file.");
  const kind = req.body.kind;
  if (kind !== "avatar" && kind !== "chat") throw bad("kind must be avatar or chat.");
  const mime = sniff(req.file.buffer);
  if (!mime) throw bad("That format isn't supported. Try a JPG or PNG photo, or an MP4 video.", "unsupported_type");
  if (kind === "avatar" && !mime.startsWith("image/")) throw bad("Profile photos must be images.");
  if (kind === "chat" && !req.user.crew_id) throw bad("Join a crew to share photos.");
  const id = crypto.randomUUID();
  await putFile(id, req.file.buffer, mime);
  await q("INSERT INTO uploads (id, owner_id, kind, crew_id, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, req.user.id, kind, kind === "chat" ? req.user.crew_id : null, mime, req.file.size]);
  if (kind === "avatar") {
    const old = req.user.photo_id;
    await q("UPDATE users SET photo_id = $2 WHERE id = $1", [req.user.id, id]);
    if (old) { await q("DELETE FROM uploads WHERE id = $1", [old]); await deleteFile(old); }
  }
  res.status(201).json({ id, url: signedUrl(id), mime });
});

uploads.delete("/avatar", async (req, res) => {
  const old = req.user.photo_id;
  await q("UPDATE users SET photo_id = NULL WHERE id = $1", [req.user.id]);
  if (old) { await q("DELETE FROM uploads WHERE id = $1", [old]); await deleteFile(old); }
  res.json({ ok: true });
});

// GET /media/:id?exp=&sig=  — no login header needed; the API only hands out
// signed links after checking the viewer is allowed to see the file.
export async function serveMedia(req, res) {
  if (!checkSignature(req.params.id, req.query.exp, req.query.sig)) throw forbidden("This link has expired. Refresh the app.");
  const f = await one("SELECT id, mime FROM uploads WHERE id = $1", [req.params.id]);
  if (!f) throw notFound();
  await streamFile(f.id, res, f.mime);
}
