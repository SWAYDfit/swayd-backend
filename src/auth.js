import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config.js";
import { one, q } from "./db.js";
import { HttpError, parse, bad } from "./util.js";

const TOKEN_DAYS = 30;
export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: TOKEN_DAYS + "d" });
}

const credentials = z.object({
  email: z.email().max(200).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8, "Use at least 8 characters").max(200)
});

export async function signup(req, res) {
  const { email, password } = parse(credentials, req.body);
  const exists = await one("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists) throw bad("An account with that email already exists. Try logging in.", "email_taken");
  const hash = await bcrypt.hash(password, 11);
  const isOwner = !!config.ownerEmail && email === config.ownerEmail;
  const user = await one("INSERT INTO users (email, password_hash, is_owner) VALUES ($1, $2, $3) RETURNING id", [email, hash, isOwner]);
  res.status(201).json({ token: signToken(user.id) });
}

export async function login(req, res) {
  const { email, password } = parse(credentials, req.body);
  const user = await one("SELECT id, password_hash FROM users WHERE email = $1", [email]);
  // Same message either way so nobody can test which emails have accounts
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new HttpError(401, "Email or password is incorrect.", "bad_login");
  res.json({ token: signToken(user.id) });
}

// Reads the token from the Authorization header, or ?token= for live-update streams
export async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : typeof req.query.token === "string" ? req.query.token : null;
  if (!token) return next(new HttpError(401, "Please log in.", "no_token"));
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret); } catch { return next(new HttpError(401, "Your session has expired. Please log in again.", "bad_token")); }
  const user = await one(
    "SELECT u.*, (a.user_id IS NOT NULL) AS is_ambassador FROM users u LEFT JOIN ambassadors a ON a.user_id = u.id WHERE u.id = $1",
    [payload.sub]
  );
  if (!user) return next(new HttpError(401, "This account no longer exists.", "no_user"));
  req.user = user;
  next();
}

export function requireConsent(req, res, next) {
  const c = req.user.consent;
  if (!c || c.version !== config.consentVersion || !c.adult || !c.terms) return next(new HttpError(403, "Please accept the latest terms first.", "consent_required"));
  next();
}
export function requireOwner(req, res, next) {
  if (!req.user.is_owner) return next(new HttpError(403, "Only the owner can do that."));
  next();
}
export const canCreate = (u) => u.is_owner || u.is_ambassador;

export async function touchActive(userId, date) {
  await q("UPDATE users SET last_active = $2 WHERE id = $1 AND (last_active IS NULL OR last_active < $2)", [userId, date]);
}
