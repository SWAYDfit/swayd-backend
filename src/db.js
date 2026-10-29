import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

// Railway's internal network doesn't use SSL; public connection strings do
const ssl = /sslmode=require|proxy\.rlwy\.net/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 10 });

// Return dates as plain "YYYY-MM-DD" strings, not JS Dates shifted by timezone
pg.types.setTypeParser(1082, (v) => v);
// numeric (weight) as a number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}
export async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}
export async function many(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
}
