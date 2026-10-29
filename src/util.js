import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
export const bad = (msg, code) => new HttpError(400, msg, code);
export const forbidden = (msg) => new HttpError(403, msg || "You can't do that.");
export const notFound = (msg) => new HttpError(404, msg || "Not found.");

// Validate a request body with a zod schema; turns errors into a friendly 400
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw bad((first.path.join(".") || "input") + ": " + first.message, "validation");
  }
  return r.data;
}

// Dates in the app's timezone (Melbourne by default)
export function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
export function weekStart(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(ymd, -wd);
}
export function dayGap(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
export const YMD = /^\d{4}-\d{2}-\d{2}$/;
