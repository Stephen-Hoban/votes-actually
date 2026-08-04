/**
 * baselineSeenVotes.ts
 *
 * Marks every vote the pipeline currently fetches as already-seen for a bot,
 * WITHOUT posting any of them. Nothing is sent to Bluesky.
 *
 * Why this exists: migrateToSupabase.ts can only migrate the seen-vote files on
 * *this* machine, and those are a stale snapshot. The bots have been running on
 * Render since 2026-07-27 against their own persistent disks, so the authoritative
 * record of "what did I already post" lives on those disks, not here. Local
 * data/seen-votes-population.json was last written 2026-07-08 and shares zero vote
 * IDs with what the bots fetch today.
 *
 * Without baselining, the first GitHub Actions run finds none of the current votes
 * in seen_votes, concludes they're all new, and re-posts ~10 votes that Render
 * already posted — publicly and irreversibly.
 *
 * Failure direction is deliberate: baselining can only ever cause a vote to be
 * skipped, never double-posted. If Render hadn't yet posted one of these, that vote
 * is silently missed. Losing one post is recoverable; a duplicate is not.
 *
 * IMPORTANT: suspend the Render services BEFORE running this. If a Render worker
 * posts a new vote after the baseline is taken, that vote is absent from seen_votes
 * and Actions will post it a second time.
 *
 * Usage:
 *   npm run baseline-seen -- population
 *   npm run baseline-seen -- age
 */

import * as dotenv from "dotenv";
import { fetchAllVotes } from "./voteSources.js";
import { markVotesSeen } from "./seenVotes.js";

dotenv.config();

function parseBotId(): string {
  // Skip node + script path; tsx passes the npm-style "--" separator through.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const botId = args[0];

  if (!botId) {
    console.error(
      "Usage: npm run baseline-seen -- <botId>\n" +
        "  e.g. npm run baseline-seen -- population\n" +
        "       npm run baseline-seen -- age"
    );
    process.exit(1);
  }
  return botId;
}

async function main(): Promise<void> {
  const botId = parseBotId();

  console.log("=".repeat(60));
  console.log(`  Baseline seen votes for bot: ${botId}`);
  console.log("=".repeat(60));
  console.log("\n⚠️  Nothing will be posted. These votes will be marked as already");
  console.log("   handled so the first scheduled run doesn't re-post them.\n");

  const votes = await fetchAllVotes();
  if (votes.length === 0) {
    console.log("No votes retrieved — nothing to baseline. Check the network and try again.");
    return;
  }

  const ids = votes.map((v) => v.id);
  await markVotesSeen(botId, ids);

  console.log(`\n✅ Marked ${ids.length} vote(s) as seen for "${botId}":`);
  for (const v of votes) {
    console.log(`   ${v.chamber.padEnd(6)} #${String(v.voteNumber).padEnd(6)} ${v.id}`);
  }
  console.log(
    `\nThe bot will now only post votes newer than these. Re-run this if the ` +
      `cutover slips by more than a few hours.`
  );
}

main().catch((err) => {
  console.error("\n❌ Baseline failed:", err);
  process.exit(1);
});
