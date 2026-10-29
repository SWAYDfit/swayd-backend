import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { parse, bad, forbidden, HttpError } from "../util.js";
import { COACH_RULES, FOOD_RULES, memberSummary } from "../coach.js";
import { sniff } from "../storage.js";

export const ai = Router();

const API = config.anthropicBase.replace(/\/$/, "") + "/v1/messages";
const headers = () => ({ "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" });

function ready(req) {
  if (!config.anthropicKey) throw new HttpError(503, "The coach isn't switched on yet.", "coach_unavailable");
  if (!req.user.coach_on) throw forbidden("Turn on the AI coach in your profile first.");
}
// Keeps costs predictable: 40 coach messages and 30 estimates per member per hour
const limit = (n, key) => rateLimit({ windowMs: 3600000, limit: n, keyGenerator: (req) => key + req.user.id, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "You've hit the hourly limit. Try again a bit later.", code: "rate_limited" }) });

const chatBody = z.object({
  mode: z.enum(["general", "food"]).default("general"),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) })).min(1).max(20)
});

// POST /ai/coach — streams the reply back as Server-Sent Events: data: {"t":"..."} then event: done
ai.post("/coach", limit(40, "coach:"), async (req, res) => {
  ready(req);
  const b = parse(chatBody, req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw bad("The last message must be from you.");
  if (b.mode === "food" && !req.user.health) throw forbidden("Turn on health tracking to use the food coach.");
  const system = COACH_RULES + (b.mode === "food" ? "\n" + FOOD_RULES : "") + "\n\nMEMBER DATA:\n" + (await memberSummary(req.user, b.mode));

  const upstream = await fetch(API, { method: "POST", headers: headers(),
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 700, system, messages: b.messages, stream: true }) });
  if (!upstream.ok || !upstream.body) {
    console.error("Anthropic error", upstream.status, await upstream.text().catch(() => ""));
    throw new HttpError(502, upstream.status === 429 ? "The coach is busy. Try again in a minute." : "The coach couldn't reply just now.", "upstream");
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let closed = false;
  req.on("close", () => { closed = true; });
  const reader = upstream.body.getReader(), dec = new TextDecoder();
  let buf = "";
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let evt; try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") res.write("data: " + JSON.stringify({ t: evt.delta.text }) + "\n\n");
        if (evt.type === "message_delta" && evt.delta && evt.delta.stop_reason === "max_tokens") res.write("event: truncated\ndata: {}\n\n");
        if (evt.type === "error") res.write("event: error\ndata: " + JSON.stringify({ error: "The coach couldn't finish that reply." }) + "\n\n");
      }
    }
  } finally {
    if (closed) reader.cancel().catch(() => {});
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

// POST /ai/estimate (multipart: desc, optional photo) — calories and macros for a meal
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
ai.post("/estimate", limit(30, "est:"), upload.single("photo"), async (req, res) => {
  ready(req);
  if (!req.user.health) throw forbidden("Turn on health tracking to log food.");
  const desc = typeof req.body.desc === "string" ? req.body.desc.trim().slice(0, 300) : "";
  if (!desc && !req.file) throw bad("Describe the meal or add a photo.");
  const content = [];
  if (req.file) {
    const mime = sniff(req.file.buffer);
    if (!mime || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw bad("Use a JPG or PNG photo.");
    content.push({ type: "image", source: { type: "base64", media_type: mime, data: req.file.buffer.toString("base64") } });
  }
  content.push({ type: "text", text:
    "Estimate the calories and macros for this meal for a food diary. Use typical Australian serving sizes and products. " +
    (req.file ? "A photo of the meal is attached. " : "") + (desc ? "The member describes it as: \"" + desc.replace(/"/g, "'") + "\". " : "") +
    "Split it into the main components. Respond with ONLY JSON in this shape: {\"items\":[{\"name\":\"short name with portion, e.g. Grilled chicken (150g)\",\"kcal\":0,\"p\":0,\"c\":0,\"f\":0}],\"note\":\"one short sentence on the main assumption\"}. " +
    "Numbers are integers: kcal, then protein, carbs and fat in grams. If it isn't food, return {\"items\":[],\"note\":\"That doesn't look like food.\"}." });
  const r = await fetch(API, { method: "POST", headers: headers(), body: JSON.stringify({ model: config.anthropicModelFast, max_tokens: 800, messages: [{ role: "user", content }] }) });
  if (!r.ok) { console.error("Anthropic error", r.status, await r.text().catch(() => "")); throw new HttpError(502, "Couldn't estimate that one. Try describing it.", "upstream"); }
  const data = await r.json();
  const text = (data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
  let out;
  try { out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { throw new HttpError(502, "Couldn't read the estimate. Try again.", "parse"); }
  const items = (Array.isArray(out.items) ? out.items : []).slice(0, 12).map((x) => ({
    name: String(x.name || "Item").slice(0, 60), kcal: Math.max(0, Math.round(+x.kcal || 0)), p: Math.max(0, Math.round(+x.p || 0)), c: Math.max(0, Math.round(+x.c || 0)), f: Math.max(0, Math.round(+x.f || 0))
  }));
  res.json({ items, note: out.note ? String(out.note).slice(0, 200) : "" });
});
