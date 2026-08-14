/**
 * seenVotes.ts
 *
 * Tracks which vote IDs a given bot has already posted, so re-running the
 * pipeline (every 15 minutes, on a GitHub Actions schedule) never double-posts
 * the same vote.
 *
 * Backed by Supabase's seen_votes table. This used to be a local JSON file per
 * bot, which worked when the bots ran as always-on Render workers with a
 * persistent disk. Scheduled Actions containers are ephemeral, so the dedupe
 * store has to outlive the container.
 *
 * The API is claim-based rather than load-a-Set/save-a-Set, because the old
 * read-then-write shape has a race in it: two overlapping runs both read a set
 * that lacks vote X, both post X, and the second write clobbers the first. A
 * duplicate post is public and irreversible, so the guarantee needs to come from
 * the database. claimVote() INSERTs the row first and lets the (bot_id, vote_id)
 * primary key arbitrate — exactly one caller can ever win.
 */

import { getSupabase, PG_UNIQUE_VIOLATION } from "./supabase.js";

const TABLE = "seen_votes";

/**
 * Try to claim a vote for posting.
 *
 * Returns true if this caller now owns the vote and should post it; false if it
 * was already claimed (already posted, or being posted right now by an
 * overlapping run). Call this BEFORE posting, never after.
 *
 * Throws on any error that isn't a duplicate — an unreachable Supabase must NOT
 * silently degrade into posting without dedupe, since that risks the exact
 * duplicate this table exists to prevent. Skipping a cycle is recoverable;
 * a double post isn't.
 */
export async function claimVote(botId: string, voteId: string): Promise<boolean> {
  const { error } = await getSupabase()
    .from(TABLE)
    .insert({ bot_id: botId, vote_id: voteId });

  if (!error) return true;
  if (error.code === PG_UNIQUE_VIOLATION) return false;

  throw new Error(
    `Failed to claim vote "${voteId}" for bot "${botId}": ${error.message} (${error.code})`
  );
}

/**
 * Give back a claim after a post failed, so a later run retries the vote
 * instead of it being silently marked as posted forever.
 *
 * Best-effort by design: if the release itself fails, the vote stays claimed
 * and simply never gets posted. That's the safe direction to fail in, so this
 * warns rather than throwing — the caller is already handling a post failure
 * and shouldn't have it escalated into a crash.
 */
export async function releaseVote(botId: string, voteId: string): Promise<void> {
  const { error } = await getSupabase()
    .from(TABLE)
    .delete()
    .eq("bot_id", botId)
    .eq("vote_id", voteId);

  if (error) {
    console.warn(
      `  ⚠️  Could not release claim on "${voteId}" for bot "${botId}": ${error.message}. ` +
        `It will not be retried.`
    );
  }
}

/**
 * The highest vote number this bot has already handled for one chamber, or 0 if
 * it has none yet.
 *
 * `idPrefix` is the chamber+session part of a vote ID, e.g. "house-2026-" or
 * "senate-119-2-". Vote IDs zero-pad their trailing number (3 digits House, 5
 * Senate), so lexicographic ordering in Postgres matches numeric ordering and a
 * single indexed row answers the question.
 *
 * This is what lets a run reach back past its display window to votes published
 * while no run happened to fire — see catchUpStart() in voteCalculations.ts.
 * Throws rather than defaulting on error, matching claimVote(): a run that
 * can't reach Supabase should abort, not quietly narrow its window.
 */
export async function highestSeenNumber(botId: string, idPrefix: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select("vote_id")
    .eq("bot_id", botId)
    .like("vote_id", `${idPrefix}%`)
    .order("vote_id", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(
      `Failed to read high-water mark for bot "${botId}" (${idPrefix}): ${error.message} (${error.code})`
    );
  }

  const newest = data?.[0]?.vote_id as string | undefined;
  if (!newest) return 0;

  const trailing = /(\d+)$/.exec(newest);
  return trailing ? parseInt(trailing[1], 10) : 0;
}

/**
 * Record a vote as posted without claiming it first.
 *
 * Only for the one-time migration of pre-existing local seen-vote files
 * (src/migrateToSupabase.ts). The bots themselves must go through claimVote().
 */
export async function markVotesSeen(botId: string, voteIds: string[]): Promise<void> {
  if (voteIds.length === 0) return;

  const rows = voteIds.map((vote_id) => ({ bot_id: botId, vote_id }));
  const { error } = await getSupabase()
    .from(TABLE)
    .upsert(rows, { onConflict: "bot_id,vote_id", ignoreDuplicates: true });

  if (error) {
    throw new Error(`Failed to record seen votes for bot "${botId}": ${error.message}`);
  }
}
