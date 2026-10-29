# Swayd API v2

Backend for the public version of Swayd: accounts, crews, chat, events and check-in, tracking, the Weekly Question, "We miss you" notes, reports, ambassadors, photo uploads and the AI coach.

Node.js, Express 5 and PostgreSQL. It replaces the hosted Claude test build's database with your own.

---

## Deploy to Railway (staging first)

This sets up a **new** service alongside your old backend, so nothing running today breaks. Do it in a **staging** environment first. Production is the same steps, repeated later.

### 1. Put the code on GitHub

In PowerShell:

```powershell
cd C:\Users\LGF2H
git clone https://github.com/SWAYDfit/swayd-backend.git swayd-backend-v2
cd swayd-backend-v2
git checkout -b v2
```

Delete everything in that folder **except the hidden `.git` folder**, then copy in the contents of the `swayd-backend-v2` folder from the zip. Then:

```powershell
npm install
git add .
git commit -m "Swayd API v2"
git push -u origin v2
```

### 2. Create a staging environment on Railway

1. Open your Swayd project on railway.com.
2. Use the environment switcher at the top to create a new environment called **staging**. Everything you add from here sits inside staging and can't touch production.

### 3. Add the database

1. In staging, choose **Create**, then **Database**, then **PostgreSQL**.
2. Wait until it shows as running.

### 4. Add the API service

1. Choose **Create**, then **GitHub Repo**, and pick `SWAYDfit/swayd-backend`.
2. In the new service's settings, set the branch to **v2**.
3. Rename the service `swayd-api`.

### 5. Add a volume for photos

1. Attach a **volume** to `swayd-api`.
2. Set its mount path to `/data`.

### 6. Set the variables

Open `swayd-api`, go to **Variables**, and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (typed exactly like this; it links to the database) |
| `JWT_SECRET` | A long random string. In PowerShell: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `OWNER_EMAIL` | The email you'll sign up with. That account becomes the owner. |
| `CORS_ORIGINS` | Your frontend address(es), comma-separated, no trailing slash. Add the address once the frontend exists. |
| `APP_TZ` | `Australia/Melbourne` |
| `STORAGE` | `disk` |
| `UPLOAD_DIR` | `/data/uploads` |
| `SANDBOX` | `true` (staging only) |
| `ANTHROPIC_API_KEY` | From console.anthropic.com. Leave blank to keep the coach off. |
| `NODE_ENV` | `production` |

Use a **different** `JWT_SECRET` for staging and production.

### 7. Deploy and check

1. Railway deploys automatically. In the service's networking settings, generate a public domain.
2. Open `https://<your-domain>/health`. You should see `{"ok":true,"sandbox":true}`.

The database tables are created automatically on first start.

### Production later

Repeat steps 2 to 7 in the **production** environment with:
- a new database,
- a new `JWT_SECRET`,
- no `SANDBOX` variable,
- branch `main`.

Releasing means merging `v2` into `main`.

---

## Cost controls

- **AI:** each member is capped at 40 coach messages and 30 meal estimates per hour. Also set a monthly spend limit in the Anthropic console.
- **Photos:** 20 MB max per file. The app shrinks photos before upload.

---

## Run it locally (optional)

You need Node 20+ and PostgreSQL.

```powershell
copy .env.example .env      # fill in DATABASE_URL, JWT_SECRET, OWNER_EMAIL
npm install
npm run dev
```

**Full check (47 tests):** point it at a fresh, empty database and run:

```powershell
$env:API="http://localhost:3000"; $env:OWNER_EMAIL="you@example.com"; npm test
```

---

## API reference (for the frontend)

**Basics**
- All routes take and return JSON, with `Authorization: Bearer <token>`.
- Errors look like `{ "error": "...", "code": "..." }`.
- Dates are `YYYY-MM-DD`. "Today" and Monday week resets use `APP_TZ`.

**Auth**
- `POST /auth/signup {email, password}` → `{token}`
- `POST /auth/login {email, password}` → `{token}`

**Me**
- `GET /me` → profile, plus `app.{consentVersion, sandbox, coachAvailable, today}`
- `POST /me/consent {adult:true, terms:true, health}`. Required before anything below works.
- `PATCH /me {name, goal, onboarded, quiet, checkOnMe, goals, body, seenBadges}`
- `POST /me/health {on, deleteData?}`, `POST /me/coach {on}`, `POST /me/event-terms`
- `GET /me/days?from&to` → `{days: {date: {intention, water, steps, weight, food[], presence[]}}}`
- `PUT /me/days/:date {intention?, water?, steps?, weight?}`
- `POST /me/food {date, meal, items[]}`, `PATCH /me/food/:id {meal}`, `DELETE /me/food/:id`
- `POST /me/sessions {date, type, minutes, why, feeling, shared}`, `DELETE /me/sessions/:id`
- `GET /me/summary` → `{checkins, cheersGiven, rsvps, movedWith[]}`
- `PUT /me/answer {text}`, `POST /me/answer/reflect {week, outcome}`, `GET /me/answers`
- `GET /me/nudge-targets`, `POST /me/nudges {to, text}`, `GET /me/nudges`, `POST /me/nudges/:id/dismiss`
- `POST|DELETE /me/blocks/:uid`
- `DELETE /me` (deletes the account)

**Crews**
- `GET /crews`, `POST /crews`, `PATCH /crews/:id`
- `POST /crews/:id/join`, `POST /crews/leave`
- `GET /crews/:id` (details, members, week total), `GET /crews/:id/feed`
- `POST|DELETE /crews/sessions/:sid/cheer`
- `GET /crews/:id/messages?before`, `POST /crews/:id/messages {text, mediaId?, w?, h?}`, `DELETE /crews/messages/:mid`
- `GET /crews/:id/answers`
- `GET /crews/:id/stream?token=`: live events `message`, `message-deleted`, `feed`, `answers`, `members`, `crew`

**Events**
- `GET /events`, `POST /events`, `DELETE /events/:id`
- `POST|DELETE /events/:id/rsvp`
- Host side: `POST /events/:id/checkin/open`, `GET /events/:id/checkin/code` (poll every ~5s), `POST /events/:id/checkin/close`
- Attendee side: `POST /events/:id/checkin {code}`

**Uploads**
- `POST /uploads` (multipart: `file`, `kind=avatar|chat`) → `{id, url}`
- `DELETE /uploads/avatar`
- Media links (`/media/:id?exp&sig`) are signed and expire after 6 hours. Chat media is only linked for members of that crew.

**AI**
- `POST /ai/coach {mode: general|food, messages[]}` streams `data: {"t": "..."}` chunks, then `event: done`.
- `POST /ai/estimate` (multipart: `desc`, optional `photo`) → `{items[], note}`

**Reports and admin**
- `POST /reports {about, kind, refId?, reason, detail?, text?}`
- Owner only: `GET /admin/members`, `POST|DELETE /admin/ambassadors/:uid`, `GET /admin/reports`, `PATCH /admin/reports/:id {status, removeMessage?}`

---

## Known limits (deliberate for v1)

- **Live updates run in memory on one server.** Add Redis if you ever run more than one copy.
- **No password-reset email yet.** It needs an email provider such as Resend.
- **Sign in with Apple and Google** come with the app-store stage.
