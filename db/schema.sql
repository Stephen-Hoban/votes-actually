-- Supabase schema for the vote bots' durable runtime state.
--
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run; every statement is idempotent.
--
-- Only these two tables move to Postgres. The slow-changing reference caches
-- (state-populations, district-populations, member-districts, member-ages) stay
-- as files committed to the repo — they're build artifacts on a refresh-* cadence,
-- not per-run state.

-- ---------------------------------------------------------------------------
-- seen_votes — which votes each bot has already posted.
--
-- The composite primary key is what makes dedupe safe: a bot claims a vote by
-- INSERTing this row BEFORE posting, so if two runs of the same bot ever overlap,
-- the second insert hits a unique violation and that run skips the vote instead
-- of posting it twice. A duplicate post is public and irreversible, so this
-- needs to be a database constraint, not application-level checking.
-- ---------------------------------------------------------------------------
create table if not exists public.seen_votes (
  bot_id    text        not null,
  vote_id   text        not null,
  posted_at timestamptz not null default now(),
  primary key (bot_id, vote_id)
);

-- ---------------------------------------------------------------------------
-- bluesky_sessions — one persisted @atproto session per bot.
--
-- Previously data/bluesky-session-{botid}.json on the Render disk. Without this
-- every scheduled run would log in fresh, which Bluesky rate-limits.
-- ---------------------------------------------------------------------------
create table if not exists public.bluesky_sessions (
  bot_id       text        primary key,
  session_json jsonb       not null,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Lock both tables down.
--
-- RLS enabled with zero policies means no role can read or write these through
-- the public API. The service_role key used by the bots bypasses RLS entirely,
-- so the bots keep working and nothing else can touch the data — including
-- anyone who finds the anon key, which is safe to expose by design.
-- ---------------------------------------------------------------------------
alter table public.seen_votes       enable row level security;
alter table public.bluesky_sessions enable row level security;
