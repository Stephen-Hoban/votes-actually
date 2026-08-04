/**
 * migrateToSupabase.ts
 *
 * One-time migration: copies the runtime state that used to live on the Render
 * worker's persistent disk into Supabase.
 *
 *   data/seen-votes-{botid}.json      → seen_votes
 *   data/bluesky-session-{botid}.json → bluesky_sessions
 *
 * Run this ONCE before the first scheduled GitHub Actions run. Without it the
 * seen_votes table starts empty, so the bots would treat the last ~10 already-
 * posted votes as new and post them all a second time.
 *
 * Idempotent — re-running it re-upserts the same rows and changes nothing.
 *
 * Usage:
 *   npm run migrate-supabase
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import type { AtpSessionData } from "@atproto/api";
import { markVotesSeen } from "./seenVotes.js";
import { saveSession } from "./bluesky.js";

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    console.warn(`  ⚠️  Could not parse ${path.basename(file)}: ${(err as Error).message}`);
    return undefined;
  }
}

// Discover bots from whatever state files exist, rather than hardcoding a bot
// list this script would then need updating alongside.
function discoverBotIds(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  const ids = new Set<string>();
  for (const name of fs.readdirSync(DATA_DIR)) {
    const seen = name.match(/^seen-votes-(.+)\.json$/);
    if (seen) ids.add(seen[1]);
    const session = name.match(/^bluesky-session-(.+)\.json$/);
    if (session) ids.add(session[1]);
  }
  return [...ids].sort();
}

async function migrateBot(botId: string): Promise<void> {
  console.log(`\n🤖 ${botId}`);

  const voteIds = readJson<string[]>(path.join(DATA_DIR, `seen-votes-${botId}.json`));
  if (voteIds && voteIds.length > 0) {
    await markVotesSeen(botId, voteIds);
    console.log(`   ✅ ${voteIds.length} seen vote ID(s) → seen_votes`);
  } else {
    console.log(`   ⏭️  no seen-votes file — nothing to migrate`);
  }

  const session = readJson<AtpSessionData>(path.join(DATA_DIR, `bluesky-session-${botId}.json`));
  if (session) {
    await saveSession(botId, session);
    console.log(`   ✅ Bluesky session → bluesky_sessions`);
  } else {
    console.log(`   ⏭️  no session file — the bot will log in fresh on its next run`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Migrate local bot state → Supabase");
  console.log("=".repeat(60));

  const botIds = discoverBotIds();
  if (botIds.length === 0) {
    console.log("\nNo local state files found in data/. Nothing to migrate.");
    return;
  }

  console.log(`\nFound state for: ${botIds.join(", ")}`);
  for (const botId of botIds) {
    await migrateBot(botId);
  }

  console.log("\n" + "=".repeat(60));
  console.log("  Done. Verify in the Supabase dashboard → Table Editor → seen_votes.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err);
  process.exit(1);
});
