import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

// Files live either on a Railway volume (disk) or an S3-compatible bucket (e.g. Cloudflare R2)
let s3 = null, S3 = null;
async function s3Client() {
  if (s3) return s3;
  S3 = await import("@aws-sdk/client-s3");
  s3 = new S3.S3Client({
    region: config.s3.region, endpoint: config.s3.endpoint || undefined,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
  });
  return s3;
}
function diskPath(id) { return path.join(config.uploadDir, id.slice(0, 2), id); }

export async function putFile(id, buffer, mime) {
  if (config.storage === "s3") {
    const c = await s3Client();
    await c.send(new S3.PutObjectCommand({ Bucket: config.s3.bucket, Key: id, Body: buffer, ContentType: mime }));
    return;
  }
  const p = diskPath(id);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, buffer);
}
export async function streamFile(id, res, mime) {
  res.set({ "Content-Type": mime, "Cache-Control": "private, max-age=3600" });
  if (config.storage === "s3") {
    const c = await s3Client();
    const out = await c.send(new S3.GetObjectCommand({ Bucket: config.s3.bucket, Key: id }));
    out.Body.pipe(res);
    return;
  }
  fs.createReadStream(diskPath(id)).on("error", () => res.status(404).end()).pipe(res);
}
export async function deleteFile(id) {
  try {
    if (config.storage === "s3") {
      const c = await s3Client();
      await c.send(new S3.DeleteObjectCommand({ Bucket: config.s3.bucket, Key: id }));
    } else await fsp.unlink(diskPath(id));
  } catch { /* already gone */ }
}

// Short-lived signed links so <img> and <video> tags can load private media without login headers
const LINK_HOURS = 6;
export function signedUrl(id) {
  const exp = Math.floor(Date.now() / 1000) + LINK_HOURS * 3600;
  const sig = crypto.createHmac("sha256", config.jwtSecret).update(id + ":" + exp).digest("base64url");
  return "/media/" + id + "?exp=" + exp + "&sig=" + sig;
}
export function checkSignature(id, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = crypto.createHmac("sha256", config.jwtSecret).update(id + ":" + exp).digest("base64url");
  const a = Buffer.from(want), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Check the file really is what it claims to be (first bytes), not just the label
export function sniff(buf) {
  const h = buf.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (h.subarray(0, 6).toString() === "GIF87a" || h.subarray(0, 6).toString() === "GIF89a") return "image/gif";
  if (h.subarray(4, 8).toString() === "ftyp") return "video/mp4"; // MP4 and iPhone .mov share this container
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return "video/webm";
  return null;
}
