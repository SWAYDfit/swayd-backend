# swayd-backend-v2

The Swayd API. See ../CLAUDE.md for the project overview and rules. This file covers the backend only.

## Run and test

```powershell
copy .env.example .env    # set DATABASE_URL, JWT_SECRET, OWNER_EMAIL
npm install
npm run dev               # http://localhost:3000, tables are created on start
$env:API="http://localhost:3000"; $env:OWNER_EMAIL="<same as .env>"; npm test   # needs an EMPTY database
```

**Database for local testing:** never use the staging or production database. Use one of:
- PostgreSQL for Windows, or
- `docker run -e POSTGRES_PASSWORD=swayd -p 5432:5432 postgres:16`

## Map

| Path | Purpose |
|---|---|
| `db/schema.sql` | All tables. Must stay idempotent (`IF NOT EXISTS`); it runs on every start |
| `src/server.js` | App setup, route mounting, error handler |
| `src/auth.js` | Signup and login, JWT, `requireAuth`, `requireConsent`, `requireOwner`, `canCreate` |
| `src/routes/me.js` | Profile, consent, daily log, food, sessions, answers, notes, blocks, account deletion |
| `src/routes/crews.js` | Crews, members, feed, cheers, chat, Weekly Question wall, SSE stream |
| `src/routes/events.js` | Events, RSVPs, rotating check-in codes (HMAC of a server secret plus the minute) |
| `src/routes/admin.js` | Reports (anyone can file one); owner-only ambassadors and report review |
| `src/routes/media.js` | Uploads (content-sniffed), signed media links |
| `src/routes/ai.js`, `src/coach.js` | Coach (streams SSE), meal estimates, coach rules and the member summary |
| `src/realtime.js` | In-memory SSE hub (one instance only) |
| `test/smoke.js` | End-to-end checks. Add a check for every new endpoint |

## Conventions

- **Validation:** validate every body with zod via `parse()`, and throw `bad()`, `forbidden()` or `notFound()` for errors.
- **SQL:** always parameterised `$1` placeholders. Never build SQL from user input. The only dynamic SQL is column names taken from fixed maps.
- **Permissions:** check them on the server even when the UI hides the button.
- **Dates:** `YYYY-MM-DD` strings, with "today" from `today()` in `APP_TZ`.
- **Schema changes:** add new `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lines at the end of `schema.sql`. Never drop columns that hold member data without asking LG.
- **Dependencies:** pinned to exact versions that were at least two weeks old when added. Keep doing that.
