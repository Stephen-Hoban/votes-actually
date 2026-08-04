/**
 * bluesky.ts
 *
 * Minimal Bluesky posting client for the vote bots.
 * Persists each bot's login session to Supabase so repeated runs don't hit
 * Bluesky's login rate limit. (This used to be a file on the Render worker's
 * persistent disk; scheduled GitHub Actions containers are ephemeral, so
 * without a durable store every run would log in fresh.)
 *
 * Each bot has its own account, so credentials and env vars are keyed by
 * bot ID. For a bot with ID "population", requires in .env:
 *   BLUESKY_POPULATION_HANDLE
 *   BLUESKY_POPULATION_APP_PASSWORD
 * Create an app password at https://bsky.app/settings/app-passwords
 * (do not use your main account password).
 */

import { AtpAgent, type AppBskyRichtextFacet, type AtpSessionData } from "@atproto/api";
import { getSupabase } from "./supabase.js";
import {
  fitsInPost,
  graphemeLength,
  truncateToGraphemes,
  MAX_POST_LENGTH,
  type PostFacet,
} from "./voteCalculations.js";

const SESSION_TABLE = "bluesky_sessions";

function envPrefix(botId: string): string {
  return `BLUESKY_${botId.toUpperCase()}_`;
}

async function loadSavedSession(botId: string): Promise<AtpSessionData | undefined> {
  const { data, error } = await getSupabase()
    .from(SESSION_TABLE)
    .select("session_json")
    .eq("bot_id", botId)
    .maybeSingle();

  // A missing or unreadable session is recoverable — we just log in fresh — so
  // this warns instead of throwing. Contrast with seenVotes, where failing open
  // would risk a duplicate post.
  if (error) {
    console.warn(`  ⚠️  Could not load saved Bluesky session for "${botId}": ${error.message}`);
    return undefined;
  }
  return (data?.session_json as AtpSessionData | undefined) ?? undefined;
}

export async function saveSession(botId: string, session: AtpSessionData): Promise<void> {
  const { error } = await getSupabase()
    .from(SESSION_TABLE)
    .upsert(
      { bot_id: botId, session_json: session, updated_at: new Date().toISOString() },
      { onConflict: "bot_id" }
    );

  if (error) {
    console.warn(`  ⚠️  Could not save Bluesky session for "${botId}": ${error.message}`);
  }
}

/**
 * @atproto's persistSession callback is synchronous, but our save is a network
 * round-trip. Collecting the in-flight saves lets postToBluesky await them
 * before the process exits — otherwise a refreshed token could be dropped and
 * the next scheduled run would log in fresh for no reason.
 */
async function getAgent(botId: string): Promise<{ agent: AtpAgent; saves: Promise<void>[] }> {
  const prefix = envPrefix(botId);
  const handle = process.env[`${prefix}HANDLE`]?.replace(/^@/, "");
  const password = process.env[`${prefix}APP_PASSWORD`];
  if (!handle || !password) {
    throw new Error(
      `Missing ${prefix}HANDLE or ${prefix}APP_PASSWORD in .env. ` +
        "Create an app password at https://bsky.app/settings/app-passwords."
    );
  }

  const saves: Promise<void>[] = [];
  const agent = new AtpAgent({
    service: "https://bsky.social",
    persistSession: (_evt, session) => {
      if (session) saves.push(saveSession(botId, session));
    },
  });

  const saved = await loadSavedSession(botId);
  if (saved) {
    try {
      await agent.resumeSession(saved);
      return { agent, saves };
    } catch {
      console.warn(`  ⚠️  Saved Bluesky session for "${botId}" expired, logging in fresh.`);
    }
  }

  await agent.login({ identifier: handle, password });
  return { agent, saves };
}

// Callers (e.g. buildPopulationPost) should already shorten text to fit.
// This is a last-resort safety net so postToBluesky never sends something
// Bluesky will reject or mangle — if it actually triggers, that's a sign
// the caller's own shortening logic missed a case. Facets are dropped in
// that case since their byte ranges are no longer trustworthy once the
// text has been blindly sliced.
export function truncateForBluesky(text: string): string {
  if (fitsInPost(text)) return text;
  console.warn(
    `  ⚠️  Post exceeds Bluesky's ${MAX_POST_LENGTH}-grapheme limit (${graphemeLength(text)} graphemes); truncating as a last resort.`
  );
  return truncateToGraphemes(text, MAX_POST_LENGTH - 1) + "…";
}

function toAtprotoFacets(text: string, facets: PostFacet[]): AppBskyRichtextFacet.Main[] {
  if (!fitsInPost(text)) return []; // ranges aren't trustworthy once truncateForBluesky rewrites the text
  return facets.map((f) => ({
    index: { byteStart: f.byteStart, byteEnd: f.byteEnd },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: f.uri }],
  }));
}

export async function postToBluesky(botId: string, text: string, facets: PostFacet[] = []): Promise<void> {
  const { agent, saves } = await getAgent(botId);
  const atprotoFacets = toAtprotoFacets(text, facets);
  const finalText = truncateForBluesky(text);
  try {
    await agent.post({
      text: finalText,
      facets: atprotoFacets.length > 0 ? atprotoFacets : undefined,
      createdAt: new Date().toISOString(),
    });
  } finally {
    // Flush even when the post failed: the session may still have been
    // refreshed during the attempt, and losing it costs a needless relogin.
    await Promise.all(saves);
  }
}
