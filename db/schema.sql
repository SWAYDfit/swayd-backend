-- Swayd v2 database schema (PostgreSQL 16+)
-- Safe to run more than once: every statement checks before creating.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  is_owner      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- shown to other members
  name          text NOT NULL DEFAULT '',
  photo_id      uuid,
  crew_id       uuid,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_active   date,
  check_on_me   boolean NOT NULL DEFAULT true,

  -- private to the member
  goal          text,
  onboarded     boolean NOT NULL DEFAULT false,
  consent       jsonb,             -- {version, at, adult, terms}
  health        boolean NOT NULL DEFAULT false,
  health_at     timestamptz,
  coach_on      boolean NOT NULL DEFAULT false,
  coach_at      timestamptz,
  quiet         boolean NOT NULL DEFAULT false,
  goals         jsonb NOT NULL DEFAULT '{"kcal":2200,"p":140,"c":240,"f":70,"water":8,"steps":8000}',
  body          jsonb,             -- nutrition goal details
  seen_badges   text[] NOT NULL DEFAULT '{}',
  crew_ever     boolean NOT NULL DEFAULT false,
  event_terms_at timestamptz,
  q_answered    integer NOT NULL DEFAULT 0,
  q_reflected   integer NOT NULL DEFAULT 0,
  lived_answer  boolean NOT NULL DEFAULT false
);

-- Audit trail of every consent given or withdrawn (privacy best practice)
CREATE TABLE IF NOT EXISTS consent_log (
  id        bigserial PRIMARY KEY,
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,         -- terms | health | coach | event_terms
  value     boolean NOT NULL,
  version   text,
  at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  blurb       text NOT NULL DEFAULT '',
  weekly_goal integer NOT NULL DEFAULT 15 CHECK (weekly_goal BETWEEN 1 AND 500),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crews_name_unique ON crews (lower(name));

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_crew_fk FOREIGN KEY (crew_id) REFERENCES crews(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ambassadors (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid REFERENCES users(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id)
);

-- One row per member per day: the daily numbers
CREATE TABLE IF NOT EXISTS day_logs (
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  date      date NOT NULL,
  intention text,
  water     integer NOT NULL DEFAULT 0,
  steps     integer NOT NULL DEFAULT 0,
  weight    numeric(5,1),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS food_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  meal       text CHECK (meal IN ('breakfast','lunch','dinner','snack')),
  name       text NOT NULL,
  kcal       integer NOT NULL DEFAULT 0,
  p          integer NOT NULL DEFAULT 0,
  c          integer NOT NULL DEFAULT 0,
  f          integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS food_user_date ON food_items (user_id, date);

-- Proof of Presence sessions. Shared ones appear in the crew feed.
CREATE TABLE IF NOT EXISTS sessions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date     date NOT NULL,
  type     text NOT NULL,
  minutes  integer,
  why      text NOT NULL DEFAULT '',
  feeling  text NOT NULL DEFAULT '',
  shared   boolean NOT NULL DEFAULT false,
  crew_id  uuid REFERENCES crews(id) ON DELETE SET NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_date ON sessions (user_id, date);
CREATE INDEX IF NOT EXISTS sessions_crew_feed ON sessions (crew_id, at DESC) WHERE shared;

CREATE TABLE IF NOT EXISTS cheers (
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS uploads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('avatar','chat')),
  crew_id    uuid REFERENCES crews(id) ON DELETE CASCADE,  -- chat media: only this crew can see it
  mime       text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id    uuid NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,   -- kept as "deleted member"
  text       text NOT NULL DEFAULT '',
  media_id   uuid REFERENCES uploads(id) ON DELETE SET NULL,
  media_kind text,
  media_w    integer,
  media_h    integer,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_crew_at ON messages (crew_id, at DESC);

-- The Weekly Question: one answer per member per week
CREATE TABLE IF NOT EXISTS answers (
  user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  week     date NOT NULL,           -- Monday of the week
  crew_id  uuid REFERENCES crews(id) ON DELETE SET NULL,
  text     text NOT NULL,
  outcome  text CHECK (outcome IN ('did','partly','not')),
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week)
);
CREATE INDEX IF NOT EXISTS answers_crew_week ON answers (crew_id, week);

CREATE TABLE IF NOT EXISTS events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  starts_at          timestamptz NOT NULL,
  place              text NOT NULL DEFAULT '',
  cost               text NOT NULL DEFAULT 'Free',
  capacity           integer,
  host               text NOT NULL DEFAULT 'Swayd',
  access             text NOT NULL DEFAULT '',
  blurb              text NOT NULL DEFAULT '',
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  checkin_secret     text,          -- never sent to clients
  checkin_open_until timestamptz
);
CREATE INDEX IF NOT EXISTS events_starts ON events (starts_at);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- Check-ins outlive deleted events so stamps and "moved with" survive
CREATE TABLE IF NOT EXISTS checkins (
  event_id uuid NOT NULL,
  user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- "We miss you" notes: one per sender, per recipient, per week
CREATE TABLE IF NOT EXISTS nudges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  to_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  week         date NOT NULL,
  text         text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  UNIQUE (week, from_id, to_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  by_id     uuid REFERENCES users(id) ON DELETE SET NULL,   -- kept as a safety record
  about_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind      text NOT NULL,          -- message | post | answer
  ref_id    uuid,
  crew_id   uuid,
  media_id  uuid,
  text      text NOT NULL DEFAULT '',
  reason    text NOT NULL,
  detail    text NOT NULL DEFAULT '',
  status    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  at        timestamptz NOT NULL DEFAULT now()
);
