/**
 * supabase.ts
 *
 * Shared Supabase client for the durable state the bots need to survive
 * between runs. Since the bots moved from an always-on Render worker with a
 * persistent disk to ephemeral GitHub Actions containers, two things can no
 * longer live on the filesystem:
 *
 *   seen_votes        — which votes a bot already posted (dedupe)
 *   bluesky_sessions  — each bot's Bluesky login session (avoids relogin limits)
 *
 * Everything else the bots read (state/district populations, member→district
 * map, member ages) is slow-changing reference data committed to the repo, not
 * runtime state, so it deliberately stays as files. See db/schema.sql.
 *
 * Requires in the environment (.env locally, GitHub Secrets in Actions):
 *   SUPABASE_URL          — https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  — the SECRET key (`sb_secret_…`), not the publishable one
 *
 * Supabase renamed these: what the docs used to call `service_role` is now the
 * "secret key" (`sb_secret_…`), and `anon` is now the "publishable key"
 * (`sb_publishable_…`). The legacy JWT-style keys still work but are deprecated
 * at the end of 2026 — use the new ones. Either kind goes in the same env var.
 *
 * The secret key bypasses row-level security. Both tables have RLS on with no
 * policies, so it's the only way in — a leaked publishable key exposes nothing.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// Derived from supabase-js's own public options rather than importing
// WebSocketLikeConstructor from @supabase/realtime-js, which is a transitive
// dependency we don't declare. `ws` is structurally compatible at runtime; the
// two constructor signatures just disagree on paper.
type RealtimeTransport = NonNullable<
  NonNullable<Parameters<typeof createClient>[2]>["realtime"]
>["transport"];

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.\n" +
        "Locally: add both to .env. In GitHub Actions: add them as repository secrets.\n" +
        "Find them in the Supabase dashboard under Settings → API Keys " +
        "(use the secret key, sb_secret_…, not the publishable one)."
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // We never use Realtime — this is purely to get past its constructor.
    // createClient() builds a RealtimeClient eagerly and resolves its WebSocket
    // transport right there, so on any runtime without a global WebSocket
    // (Node < 22) it throws before a single query can run. Supplying `ws`
    // satisfies it on every Node version and costs nothing, since no channel is
    // ever opened. Remove once the floor is Node 22+ everywhere.
    realtime: { transport: WebSocket as unknown as RealtimeTransport },
  });
  return client;
}

// Postgres unique-violation. Raised when two runs race to claim the same vote —
// expected and meaningful, not an error condition. See seenVotes.ts.
export const PG_UNIQUE_VIOLATION = "23505";
