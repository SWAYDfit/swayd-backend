import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { HttpError } from "./util.js";
import { signup, login, requireAuth, requireConsent } from "./auth.js";
import { me } from "./routes/me.js";
import { crews } from "./routes/crews.js";
import { events } from "./routes/events.js";
import { admin, reports } from "./routes/admin.js";
import { uploads, serveMedia } from "./routes/media.js";
import { ai } from "./routes/ai.js";

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy; needed for correct IPs in rate limits
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)), credentials: false }));
app.use(express.json({ limit: "200kb" }));

const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." }) });

app.get("/health", async (req, res) => { await pool.query("SELECT 1"); res.json({ ok: true, sandbox: config.sandbox }); });
app.post("/auth/signup", authLimit, signup);
app.post("/auth/login", authLimit, login);
app.get("/media/:id", serveMedia);

app.use("/me", requireAuth, me);
app.use("/crews", requireAuth, requireConsent, crews);
app.use("/events", requireAuth, requireConsent, events);
app.use("/reports", requireAuth, requireConsent, reports);
app.use("/admin", requireAuth, requireConsent, admin);
app.use("/uploads", requireAuth, requireConsent, uploads);
app.use("/ai", requireAuth, requireConsent, ai);

app.use((req, res) => res.status(404).json({ error: "Not found." }));
// One place that turns every error into a clean JSON reply
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That file is too large (20 MB max).", code: "too_large" });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  if (err && err.code === "22P02") return res.status(400).json({ error: "Invalid id." });
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "Something went wrong on our side." });
});

await migrate();
app.listen(config.port, () => console.log("Swayd API listening on " + config.port + (config.sandbox ? " (sandbox)" : "")));
